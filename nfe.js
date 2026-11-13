/**
 * DuaPi.NFe — emissão de NF-e (modelo 55) direto na Sefaz, sem serviço pago no meio.
 *
 * - Cada empresa entra no app (apps/nfe do site) com código + senha.
 *   Quem cria a empresa é o Keller, pelo WhatsApp: #nfe nova Nome da Empresa
 * - A empresa cadastra os dados fiscais e envia o certificado digital A1 (.pfx).
 *   O certificado e a senha ficam no Firestore CRIPTOGRAFADOS (cofre do motor).
 * - Emissão: monta o XML, assina com o certificado, manda pra Sefaz e guarda a nota
 *   autorizada (XML com protocolo). DANFE em PDF gerado na hora.
 * - Começa sempre em HOMOLOGAÇÃO (teste, sem valor fiscal). Produção só depois de
 *   uma nota de teste autorizada.
 * - Versão 1: emitentes do Simples Nacional (CRT 1) e MEI (CRT 4).
 *
 * Bibliotecas: node-sped-nfe (XML, assinatura, webservices) e node-sped-pdf (DANFE), MIT.
 */
const crypto = require("crypto");
const forge = require("node-forge");
const fsdb = require("./firestore");

const ORIGENS = ["https://kellercamilodeoliveira-del.github.io", "http://localhost:8765"];
const SITE_NFE = "https://kellercamilodeoliveira-del.github.io/apps/nfe/";
const TOKEN_HORAS = 12;
const MAX_NOTAS_LISTA = 400;
const MAX_CATALOGO = 300;
const VERSAO_APP = "DuaPi.NFe 1.0";

// ---------- utilidades ----------
const so = (v) => String(v ?? "").replace(/\D/g, "");
const txt = (v, max = 60) =>
  String(v ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // Sefaz aceita acento, mas sem acento evita problema de DANFE/encoding
    .replace(/[<>&"'|]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const f2 = (n) => r2(n).toFixed(2);
const f4 = (n) => Number(n).toFixed(4);
const f10 = (n) => Number(n).toFixed(10);
const tag = (xml, nome) => { const m = String(xml || "").match(new RegExp(`<(?:\\w+:)?${nome}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${nome}>`)); return m ? m[1] : null; };
const bloco = (xml, nome) => { const m = String(xml || "").match(new RegExp(`<(?:\\w+:)?${nome}\\b[^>]*>[\\s\\S]*?</(?:\\w+:)?${nome}>`)); return m ? m[0] : null; };
const dsMensagem = (e) => (typeof e === "string" ? e : e?.message || String(e));

function cnpjValido(c) {
  c = so(c);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (base) => { let s = 0, p = base.length - 7; for (let i = 0; i < base.length; i++) { s += +base[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(c.slice(0, 12)) === +c[12] && calc(c.slice(0, 13)) === +c[13];
}
function cpfValido(c) {
  c = so(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const calc = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return calc(9) === +c[9] && calc(10) === +c[10];
}

// Data/hora de Brasília no formato da NF-e (AAAA-MM-DDThh:mm:ss-03:00)
function dhBrasilia(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}-03:00`;
}

const UF_COD = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };
const PAGAMENTOS = { "01": "Dinheiro", "03": "Cartão de crédito", "04": "Cartão de débito", "15": "Boleto", "17": "PIX", "99": "Outros", "90": "Sem pagamento" };

let libs = null;
// A biblioteca do DANFE perde o nº do protocolo ao ler o XML autorizado (nfeProc).
// Ajuste pequeno no arquivo dela, feito uma vez ao iniciar.
function ajustarDanfe() {
  try {
    const fs = require("fs"), path = require("path");
    const arq = path.join(__dirname, "node_modules", "node-sped-pdf", "dist", "index.js");
    const s = fs.readFileSync(arq, "utf8");
    if (s.includes("/*ajustado-duapi*/")) return;
    const novo = s
      .split("xml.protNFe").join("(xml.protNFe||{infProt:xml.infProt})")
      // horários no fuso de Brasília (o Render roda em UTC)
      .split('toLocaleDateString("pt-BR")').join('toLocaleDateString("pt-BR",{timeZone:"America/Sao_Paulo"})')
      .split('toLocaleTimeString("pt-BR")').join('toLocaleTimeString("pt-BR",{timeZone:"America/Sao_Paulo"})')
      .split('toLocaleString("pt-BR")').join('toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})');
    fs.writeFileSync(arq, "/*ajustado-duapi*/" + novo);
  } catch (e) {
    console.error("NF-e: não consegui ajustar o DANFE:", e.message);
  }
}

async function carregarLibs() {
  if (!libs) {
    ajustarDanfe();
    const nfe = await import("node-sped-nfe");
    const pdf = await import("node-sped-pdf");
    libs = { Make: nfe.Make, Tools: nfe.Tools, DANFe: pdf.DANFe };
  }
  return libs;
}

// ---------- certificado ----------
/**
 * Abre o .pfx (aceita os formatos antigos que muitas certificadoras ainda usam),
 * confere a senha e a validade, e regrava num formato que o OpenSSL 3 lê sem
 * precisar do modo "legacy".
 */
function lerCertificado(pfxBuf, senha) {
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString("binary"))), false, senha);
  } catch (e) {
    throw new Error(/mac|password|invalid/i.test(dsMensagem(e)) ? "Senha do certificado errada." : "Arquivo não parece ser um certificado A1 (.pfx) válido.");
  }
  const bags = (tipo) => p12.getBags({ bagType: tipo })[tipo] || [];
  const chaves = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)].map((b) => b.key).filter(Boolean);
  const certs = bags(forge.pki.oids.certBag).map((b) => b.cert).filter(Boolean);
  if (!chaves.length || !certs.length) throw new Error("O arquivo não tem a chave do certificado. Exporte o A1 de novo, com a chave privada.");
  const chave = chaves[0];
  const titular = certs.find((c) => c.publicKey?.n && chave.n && c.publicKey.n.equals(chave.n)) || certs[0];
  const cadeia = certs.filter((c) => c !== titular);
  const cn = (titular.subject.getField("CN") || {}).value || "";
  const cnpj = (cn.match(/:(\d{14})\s*$/) || [])[1] || ""; // e-CNPJ ICP-Brasil: "RAZAO SOCIAL:CNPJ"
  const validade = titular.validity.notAfter;
  const novo = forge.pkcs12.toPkcs12Asn1(chave, [titular, ...cadeia], senha, { algorithm: "3des", generateLocalKeyId: true, friendlyName: "duapi-nfe" });
  return {
    pfx: Buffer.from(forge.asn1.toDer(novo).getBytes(), "binary"),
    titular: cn.replace(/:\d{11,14}\s*$/, "").trim() || cn,
    cnpj,
    validade: validade.getTime(),
    vencido: validade.getTime() < Date.now(),
  };
}

// ---------- montagem da nota ----------
/**
 * Confere o pedido de emissão e devolve os dados prontos pra virar XML.
 * (Função pura, pra testar.)
 */
function prepararNota(emp, pedido, ambiente) {
  const d = emp.dados || {};
  const erros = [];
  if (!cnpjValido(d.cnpj)) erros.push("CNPJ da empresa inválido (aba Empresa).");
  if (!so(d.ie)) erros.push("Inscrição estadual da empresa não preenchida (aba Empresa).");
  if (!UF_COD[d.uf]) erros.push("UF da empresa não preenchida (aba Empresa).");
  if (so(d.cMun).length !== 7) erros.push("Cidade da empresa não preenchida (aba Empresa).");
  if (!["1", "4"].includes(String(d.crt))) erros.push("Por enquanto o app emite só para Simples Nacional ou MEI.");

  const dest = pedido.dest || {};
  const doc = so(dest.doc);
  if (doc.length === 14 ? !cnpjValido(doc) : doc.length === 11 ? !cpfValido(doc) : true) erros.push("CPF/CNPJ do cliente inválido.");
  if (!txt(dest.nome)) erros.push("Nome do cliente não preenchido.");
  const de = dest.end || {};
  if (!UF_COD[de.uf] || so(de.cMun).length !== 7 || !txt(de.xLgr) || !txt(de.xBairro) || so(de.cep).length !== 8) erros.push("Endereço do cliente incompleto (use o CEP pra preencher).");
  const ieDest = so(dest.ie);
  const indIEDest = doc.length === 11 ? "9" : ieDest ? "1" : dest.isento ? "2" : "9";

  const itens = Array.isArray(pedido.itens) ? pedido.itens : [];
  if (!itens.length) erros.push("Coloque pelo menos um produto.");
  if (itens.length > 60) erros.push("Máximo de 60 produtos por nota.");
  const dentro = de.uf === d.uf;
  const fabr = !!pedido.fabricacaoPropria;
  const cfop = (dentro ? "5" : "6") + (fabr ? "101" : "102");
  const produtos = itens.map((it, i) => {
    const q = Number(String(it.qtd).replace(",", ".")), v = Number(String(it.valor).replace(",", "."));
    const desc = r2(Number(String(it.desconto || 0).replace(",", ".")) || 0);
    if (!txt(it.descricao)) erros.push(`Produto ${i + 1}: falta a descrição.`);
    if (so(it.ncm).length !== 8) erros.push(`Produto ${i + 1}: NCM precisa ter 8 números.`);
    if (!(q > 0)) erros.push(`Produto ${i + 1}: quantidade inválida.`);
    if (!(v > 0)) erros.push(`Produto ${i + 1}: valor inválido.`);
    const vProd = r2(q * v);
    if (desc < 0 || desc >= vProd) erros.push(`Produto ${i + 1}: desconto inválido.`);
    const csosn = ["101", "102", "103", "300", "400", "500"].includes(String(it.csosn)) ? String(it.csosn) : "102";
    return {
      prod: { cProd: txt(it.codigo || String(i + 1), 60), cEAN: "SEM GTIN", xProd: txt(it.descricao, 120), NCM: so(it.ncm), CFOP: cfop, uCom: txt(it.unidade || "UN", 6), qCom: f4(q), vUnCom: f10(v), vProd: f2(vProd), cEANTrib: "SEM GTIN", uTrib: txt(it.unidade || "UN", 6), qTrib: f4(q), vUnTrib: f10(v), ...(desc > 0 ? { vDesc: f2(desc) } : {}), indTot: "1" },
      icms: { orig: String(it.origem ?? "0").replace(/\D/g, "").slice(0, 1) || "0", CSOSN: csosn },
      vLiq: r2(vProd - desc),
    };
  });
  const total = r2(produtos.reduce((s, p) => s + p.vLiq, 0));
  const tPag = PAGAMENTOS[pedido.pagamento] ? pedido.pagamento : "17";
  if (erros.length) return { erros };

  return {
    erros: [],
    cfop,
    total,
    indIEDest,
    ide: {
      cUF: String(UF_COD[d.uf]), cNF: String(crypto.randomInt(10000000, 99999999)), natOp: txt(pedido.natOp || "VENDA DE MERCADORIA", 60), mod: "55",
      serie: String(Number(d.serie) || 1), dhEmi: dhBrasilia(), tpNF: "1", idDest: dentro ? "1" : "2", cMunFG: so(d.cMun), tpImp: "1", tpEmis: "1",
      cDV: "0", tpAmb: String(ambiente), finNFe: "1", indFinal: indIEDest === "1" && !pedido.consumidorFinal ? "0" : "1", indPres: String(pedido.presencial ? 1 : 9),
      indIntermed: "0", procEmi: "0", verProc: VERSAO_APP,
    },
    emit: { CNPJ: so(d.cnpj), xNome: txt(d.razao, 60), ...(txt(d.fantasia) ? { xFant: txt(d.fantasia, 60) } : {}), IE: so(d.ie), CRT: String(d.crt) },
    enderEmit: { xLgr: txt(d.xLgr), nro: txt(d.nro || "SN", 60), ...(txt(d.xCpl) ? { xCpl: txt(d.xCpl) } : {}), xBairro: txt(d.xBairro), cMun: so(d.cMun), xMun: txt(d.xMun), UF: d.uf, CEP: so(d.cep), cPais: "1058", xPais: "BRASIL", ...(so(d.fone).length >= 10 ? { fone: so(d.fone) } : {}) },
    dest: { ...(doc.length === 14 ? { CNPJ: doc } : { CPF: doc }), xNome: txt(dest.nome, 60), indIEDest, ...(indIEDest === "1" ? { IE: ieDest } : {}), ...(dest.email ? { email: String(dest.email).trim().slice(0, 60) } : {}) },
    enderDest: { xLgr: txt(de.xLgr), nro: txt(de.nro || "SN", 60), ...(txt(de.xCpl) ? { xCpl: txt(de.xCpl) } : {}), xBairro: txt(de.xBairro), cMun: so(de.cMun), xMun: txt(de.xMun), UF: de.uf, CEP: so(de.cep), cPais: "1058", xPais: "BRASIL" },
    produtos,
    pag: [{ indPag: "0", tPag, vPag: tPag === "90" ? "0.00" : f2(total), ...(["03", "04"].includes(tPag) ? { card: { tpIntegra: "2" } } : {}), ...(tPag === "99" ? { xPag: "OUTROS" } : {}) }],
    infCpl: txt([d.crt === "4" ? "Documento emitido por MEI." : "Documento emitido por ME ou EPP optante pelo Simples Nacional. Nao gera direito a credito fiscal de IPI.", d.infCpl, pedido.obs].filter(Boolean).join(" "), 2000),
  };
}

async function montarXml(prep, numero) {
  const { Make } = await carregarLibs();
  const N = new Make();
  N.tagInfNFe({ Id: null, versao: "4.00" });
  // a ordem dos campos importa no XML: nNF vem logo depois da série
  const ide = {};
  for (const [k, v] of Object.entries(prep.ide)) { ide[k] = v; if (k === "serie") ide.nNF = String(numero); }
  N.tagIde(ide);
  N.tagEmit(prep.emit);
  N.tagEnderEmit(prep.enderEmit);
  N.tagDest(prep.dest);
  N.tagEnderDest(prep.enderDest);
  await N.tagProd(prep.produtos.map((p) => p.prod));
  prep.produtos.forEach((p, i) => {
    N.tagProdICMSSN(i, p.icms);
    N.tagProdPIS(i, { CST: "49", qBCProd: 0, vAliqProd: 0, vPIS: 0 });
    N.tagProdCOFINS(i, { CST: "49", qBCProd: 0, vAliqProd: 0, vCOFINS: 0 });
  });
  N.tagTotal();
  N.tagTransp({ modFrete: 9 });
  N.tagDetPag(prep.pag);
  N.tagInfAdic({ infCpl: prep.infCpl });
  return N.xml();
}

// ---------- módulo ----------
function registrarNfe(app, { cofre, enviar, paraJid, estaConectado, avisarKeller }) {
  const caminhoEmp = (id) => `config/nfe-emp-${id}`;
  const caminhoNota = (id, chave) => `config/nfe-xml-${id}-${chave}`;
  const travas = new Map();
  const tentativasLogin = new Map();

  function travar(id, fn) {
    const antes = travas.get(id) || Promise.resolve();
    const agora = antes.catch(() => {}).then(fn);
    const fim = agora.catch(() => {}).finally(() => { if (travas.get(id) === fim) travas.delete(id); });
    travas.set(id, fim);
    return agora;
  }

  async function lerEmpresa(id) {
    if (!/^[a-z0-9-]{4,40}$/.test(String(id || ""))) return null;
    const doc = await fsdb.getDoc(caminhoEmp(id));
    if (!doc || !doc.d) return null;
    return cofre().decifrar(doc.d);
  }
  async function salvarEmpresa(emp) {
    emp.atualizadoEm = Date.now();
    await fsdb.setCampos(caminhoEmp(emp.id), { d: cofre().cifrar(emp) });
  }

  function hashSenha(senha, sal = crypto.randomBytes(16).toString("hex")) {
    return { sal, hash: crypto.scryptSync(String(senha), sal, 32).toString("hex") };
  }
  function senhaConfere(emp, senha) {
    const h = hashSenha(senha, emp.senhaSal).hash;
    return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(emp.senhaHash, "hex"));
  }

  async function criarEmpresa(nome) {
    const base = txt(nome, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "empresa";
    const id = `${base}-${crypto.randomBytes(2).toString("hex")}`;
    const senha = crypto.randomBytes(4).toString("hex");
    const { sal, hash } = hashSenha(senha);
    const emp = { id, nome: txt(nome, 60), senhaSal: sal, senhaHash: hash, criadoEm: Date.now(), dados: { crt: "1", serie: 1 }, ambiente: 2, proximo: { 1: 1, 2: 1 }, notas: [], produtos: [], clientes: [], homologOk: false };
    await salvarEmpresa(emp);
    return { id, senha };
  }

  function publico(emp) {
    return {
      id: emp.id, nome: emp.nome, dados: emp.dados || {}, ambiente: emp.ambiente, proximo: emp.proximo?.[emp.ambiente] || 1,
      homologOk: !!emp.homologOk, notas: emp.notas || [], produtos: emp.produtos || [], clientes: emp.clientes || [],
      cert: emp.cert ? { titular: emp.cert.titular, cnpj: emp.cert.cnpj, validade: emp.cert.validade, vencido: emp.cert.validade < Date.now() } : null,
      whatsapp: estaConectado(),
    };
  }

  async function ferramentas(emp, ambiente = emp.ambiente) {
    if (!emp.cert) throw new Error("Envie o certificado digital A1 (aba Empresa) antes.");
    if (emp.cert.validade < Date.now()) throw new Error("O certificado digital venceu. Envie o certificado novo (aba Empresa).");
    const { Tools } = await carregarLibs();
    return new Tools({ mod: "55", tpAmb: ambiente, UF: emp.dados.uf || "SP", versao: "4.00", timeout: 60, CNPJ: so(emp.dados.cnpj) }, { pfx: Buffer.from(emp.cert.pfx, "base64"), senha: emp.cert.senha });
  }

  // ---------- CORS + autenticação ----------
  app.use("/nfe", (req, res, next) => {
    const origem = req.headers.origin;
    if (ORIGENS.includes(origem)) {
      res.set("Access-Control-Allow-Origin", origem);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.set("Access-Control-Expose-Headers", "Content-Disposition");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    if (!cofre()) return res.status(503).json({ erro: "Motor sem chave de segurança configurada." });
    next();
  });

  async function autenticar(req, res, next) {
    try {
      const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const s = t ? cofre().decifrar(t) : null;
      if (!s || s.tipo !== "nfe" || s.x < Date.now()) return res.status(401).json({ erro: "Entre de novo.", sair: true });
      const emp = await lerEmpresa(s.e);
      if (!emp || (emp.senhaVersao || 0) !== (s.v || 0)) return res.status(401).json({ erro: "Entre de novo.", sair: true });
      req.emp = emp;
      next();
    } catch (e) {
      res.status(401).json({ erro: "Entre de novo.", sair: true });
    }
  }
  const rota = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      console.error("NF-e:", dsMensagem(e));
      if (!res.headersSent) res.status(400).json({ erro: dsMensagem(e).slice(0, 400) });
    }
  };

  // confere se o servidor tem o que a assinatura precisa (openssl) e a validação (xmllint, opcional)
  app.get("/nfe/saude", (req, res) => {
    const { spawnSync } = require("child_process");
    const tem = (cmd, args) => { try { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 }); return r.status === 0 ? (r.stdout || r.stderr || "").trim().split("\n")[0] : false; } catch (e) { return false; } };
    res.json({ openssl: tem("openssl", ["version"]), xmllint: tem("xmllint", ["--version"]) });
  });

  app.post("/nfe/login", rota(async (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const t = tentativasLogin.get(ip) || { n: 0, desde: Date.now() };
    if (Date.now() - t.desde > 15 * 60 * 1000) { t.n = 0; t.desde = Date.now(); }
    if (t.n >= 10) return res.status(429).json({ erro: "Muitas tentativas. Espere 15 minutos." });
    t.n++;
    tentativasLogin.set(ip, t);
    const id = String(req.body?.empresa || "").trim().toLowerCase();
    const emp = await lerEmpresa(id);
    if (!emp || !senhaConfere(emp, String(req.body?.senha || ""))) return res.status(401).json({ erro: "Código ou senha errados." });
    t.n = 0;
    const token = cofre().cifrar({ tipo: "nfe", e: emp.id, v: emp.senhaVersao || 0, x: Date.now() + TOKEN_HORAS * 3600e3 });
    res.json({ token, empresa: publico(emp) });
  }));

  app.get("/nfe/eu", autenticar, rota(async (req, res) => res.json(publico(req.emp))));

  app.post("/nfe/senha", autenticar, rota(async (req, res) => {
    const { atual, nova } = req.body || {};
    if (!senhaConfere(req.emp, String(atual || ""))) throw new Error("Senha atual errada.");
    if (String(nova || "").length < 6) throw new Error("A senha nova precisa ter pelo menos 6 caracteres.");
    await travar(req.emp.id, async () => {
      const emp = await lerEmpresa(req.emp.id);
      Object.assign(emp, (({ sal, hash }) => ({ senhaSal: sal, senhaHash: hash }))(hashSenha(nova)));
      emp.senhaVersao = (emp.senhaVersao || 0) + 1;
      await salvarEmpresa(emp);
    });
    res.json({ ok: true, sair: true });
  }));

  app.post("/nfe/dados", autenticar, rota(async (req, res) => {
    const b = req.body || {};
    const d = {
      cnpj: so(b.cnpj), ie: so(b.ie), razao: txt(b.razao, 60), fantasia: txt(b.fantasia, 60), crt: ["1", "4"].includes(String(b.crt)) ? String(b.crt) : "1",
      cep: so(b.cep), xLgr: txt(b.xLgr), nro: txt(b.nro, 60), xCpl: txt(b.xCpl), xBairro: txt(b.xBairro), cMun: so(b.cMun), xMun: txt(b.xMun), uf: String(b.uf || "").toUpperCase(),
      fone: so(b.fone).slice(0, 14), email: String(b.email || "").trim().slice(0, 60), serie: Math.min(Math.max(parseInt(b.serie, 10) || 1, 1), 889), infCpl: txt(b.infCpl, 500),
    };
    if (!cnpjValido(d.cnpj)) throw new Error("CNPJ inválido.");
    if (!d.ie) throw new Error("Preencha a inscrição estadual.");
    if (!d.razao) throw new Error("Preencha a razão social.");
    if (!UF_COD[d.uf] || d.cMun.length !== 7) throw new Error("Endereço incompleto: use o CEP pra preencher a cidade.");
    const emp = await travar(req.emp.id, async () => {
      const emp = await lerEmpresa(req.emp.id);
      if (emp.cert?.cnpj && emp.cert.cnpj.slice(0, 8) !== d.cnpj.slice(0, 8)) throw new Error(`Esse CNPJ não é o do certificado enviado (${emp.cert.cnpj}).`);
      emp.dados = { ...emp.dados, ...d };
      const num = parseInt(b.proximoNumero, 10);
      if (num >= 1 && num <= 999999999) emp.proximo[emp.ambiente] = num;
      await salvarEmpresa(emp);
      return emp;
    });
    res.json(publico(emp));
  }));

  app.post("/nfe/certificado", autenticar, rota(async (req, res) => {
    const b64 = String(req.body?.pfx || "").replace(/^data:[^,]*,/, "");
    if (!b64 || b64.length > 60000) throw new Error("Arquivo de certificado inválido.");
    const info = lerCertificado(Buffer.from(b64, "base64"), String(req.body?.senha || ""));
    if (info.vencido) throw new Error(`Esse certificado venceu em ${new Date(info.validade).toLocaleDateString("pt-BR")}.`);
    const emp = await travar(req.emp.id, async () => {
      const emp = await lerEmpresa(req.emp.id);
      const cnpjEmp = so(emp.dados?.cnpj);
      if (info.cnpj && cnpjEmp && info.cnpj.slice(0, 8) !== cnpjEmp.slice(0, 8)) throw new Error(`Esse certificado é do CNPJ ${info.cnpj}, diferente do CNPJ da empresa (${cnpjEmp}).`);
      emp.cert = { pfx: info.pfx.toString("base64"), senha: String(req.body.senha), titular: info.titular, cnpj: info.cnpj, validade: info.validade, enviadoEm: Date.now() };
      if (!cnpjEmp && info.cnpj) emp.dados.cnpj = info.cnpj;
      await salvarEmpresa(emp);
      return emp;
    });
    res.json(publico(emp));
  }));

  app.get("/nfe/sefaz", autenticar, rota(async (req, res) => {
    const tools = await ferramentas(req.emp);
    const r = await tools.sefazStatus();
    res.json({ cStat: tag(r, "cStat"), motivo: tag(r, "xMotivo"), ok: tag(r, "cStat") === "107", ambiente: req.emp.ambiente });
  }));

  app.post("/nfe/ambiente", autenticar, rota(async (req, res) => {
    const producao = !!req.body?.producao;
    const emp = await travar(req.emp.id, async () => {
      const emp = await lerEmpresa(req.emp.id);
      if (producao && !emp.homologOk) throw new Error("Emita e autorize pelo menos uma nota de TESTE antes de passar pra produção.");
      if (producao && String(req.body?.confirmo || "").trim().toUpperCase() !== "PRODUCAO") throw new Error("Confirmação errada.");
      emp.ambiente = producao ? 1 : 2;
      await salvarEmpresa(emp);
      return emp;
    });
    res.json(publico(emp));
  }));

  async function consultarAte(tools, chave, tentativas = 4) {
    for (let i = 0; i < tentativas; i++) {
      await new Promise((r) => setTimeout(r, 2500 + i * 1500));
      try {
        const r = await tools.consultarNFe(chave);
        const prot = bloco(r, "protNFe");
        if (prot) return { prot, cStat: tag(prot, "cStat"), motivo: tag(prot, "xMotivo") };
        const c = tag(r, "cStat");
        if (c && !["105", "106"].includes(c) && c !== "217") return { prot: null, cStat: c, motivo: tag(r, "xMotivo") };
      } catch (e) {}
    }
    return { prot: null, cStat: null, motivo: "A Sefaz não respondeu a tempo." };
  }

  app.post("/nfe/emitir", autenticar, rota(async (req, res) => {
    const resultado = await travar(req.emp.id, async () => {
      const emp = await lerEmpresa(req.emp.id);
      const amb = emp.ambiente;
      const prep = prepararNota(emp, req.body || {}, amb);
      if (prep.erros.length) return { ok: false, erros: prep.erros };
      const tools = await ferramentas(emp, amb);
      let numero = emp.proximo[amb] || 1;

      for (let tentativa = 0; tentativa < 3; tentativa++) {
        const xml = await montarXml(prep, numero);
        const assinado = await tools.xmlSign(xml);
        try { await tools.validarNFe(assinado); } catch (e) {
          const m = dsMensagem(e);
          if (!/xmllint/i.test(m)) return { ok: false, erros: ["O XML ficou com erro de formato: " + m.slice(0, 300)] };
        }
        const chave = (assinado.match(/Id="NFe(\d{44})"/) || [])[1];
        let ret;
        try { ret = await tools.sefazEnviaLote(assinado, { indSinc: 1 }); } catch (e) {
          // sem resposta: pode ter chegado. Confere pela chave antes de dizer que falhou.
          const c = await consultarAte(tools, chave, 3);
          if (!c.prot) return { ok: false, erros: ["A Sefaz não respondeu: " + dsMensagem(e).slice(0, 200) + ". Tente de novo em alguns minutos."] };
          ret = c.prot;
        }
        let prot = bloco(ret, "protNFe");
        let cStat = prot ? tag(prot, "cStat") : tag(ret, "cStat");
        let motivo = prot ? tag(prot, "xMotivo") : tag(ret, "xMotivo");
        if (!prot && cStat === "103") { const c = await consultarAte(tools, chave); prot = c.prot; cStat = c.cStat; motivo = c.motivo; }
        if (cStat === "204") { const c = await consultarAte(tools, chave, 2); if (c.prot) { prot = c.prot; cStat = c.cStat; motivo = c.motivo; } }
        if (cStat === "539" || cStat === "206") { numero++; continue; } // número já usado por outra nota: pula pro próximo

        const autorizada = ["100", "150"].includes(cStat);
        const denegada = ["110", "301", "302", "303"].includes(cStat);
        if (!autorizada && !denegada) return { ok: false, cStat, erros: [`Sefaz recusou (${cStat || "?"}): ${motivo || "sem motivo"}`] };

        const nfeSemDecl = assinado.replace(/<\?xml[^>]*\?>/, "").trim();
        const proc = `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${nfeSemDecl}${prot}</nfeProc>`;
        const nota = {
          chave, numero, serie: prep.ide.serie, amb, status: autorizada ? "autorizada" : "denegada", prot: tag(prot, "nProt"), em: Date.now(),
          dest: prep.dest.xNome === "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL" ? txt(req.body.dest?.nome) : prep.dest.xNome,
          doc: so(req.body.dest?.doc), valor: prep.total, motivo,
        };
        await fsdb.setCampos(caminhoNota(emp.id, chave), { d: cofre().cifrar({ xml: proc, nota }) });
        emp.proximo[amb] = numero + 1;
        emp.notas = [nota, ...(emp.notas || [])].slice(0, MAX_NOTAS_LISTA);
        if (autorizada && amb === 2) emp.homologOk = true;
        // guarda produto e cliente pra preencher mais rápido na próxima
        for (const it of req.body.itens || []) {
          const p = { codigo: txt(it.codigo, 60), descricao: txt(it.descricao, 120), ncm: so(it.ncm), unidade: txt(it.unidade || "UN", 6), valor: Number(String(it.valor).replace(",", ".")), csosn: String(it.csosn || "102"), origem: String(it.origem || "0") };
          emp.produtos = [p, ...(emp.produtos || []).filter((x) => x.descricao !== p.descricao)].slice(0, MAX_CATALOGO);
        }
        const c = req.body.dest || {};
        emp.clientes = [{ doc: so(c.doc), nome: txt(c.nome), ie: so(c.ie), email: String(c.email || "").slice(0, 60), whatsapp: so(c.whatsapp), end: c.end || {} }, ...(emp.clientes || []).filter((x) => x.doc !== so(c.doc))].slice(0, MAX_CATALOGO);
        await salvarEmpresa(emp);
        return { ok: autorizada, nota, denegada, empresa: publico(emp), whatsappDestino: so(c.whatsapp) };
      }
      return { ok: false, erros: ["Não consegui achar um número livre. Confira o próximo número na aba Empresa."] };
    });
    res.json(resultado);
    if (resultado.ok && resultado.whatsappDestino?.length >= 10) {
      mandarWhatsApp(req.emp.id, resultado.nota.chave, resultado.whatsappDestino).catch((e) => console.error("NF-e: erro ao mandar no WhatsApp:", e.message));
    }
  }));

  async function lerNota(id, chave) {
    if (!/^\d{44}$/.test(String(chave))) return null;
    const doc = await fsdb.getDoc(caminhoNota(id, chave));
    return doc?.d ? cofre().decifrar(doc.d) : null;
  }

  async function gerarDanfe(xml) {
    const { DANFe } = await carregarLibs();
    return Buffer.from(await DANFe({ xml }));
  }

  async function mandarWhatsApp(id, chave, numero) {
    if (!estaConectado()) throw new Error("WhatsApp do motor desconectado.");
    const emp = await lerEmpresa(id);
    const n = await lerNota(id, chave);
    if (!n) throw new Error("Nota não encontrada.");
    const pdf = await gerarDanfe(n.xml);
    const jid = paraJid(numero);
    const teste = n.nota.amb === 2 ? " (TESTE, sem valor fiscal)" : "";
    await enviar(jid, { document: pdf, mimetype: "application/pdf", fileName: `NFe-${n.nota.numero}.pdf`, caption: `🧾 Nota fiscal nº ${n.nota.numero}${teste}\n${emp.dados.razao || emp.nome}\nValor: R$ ${f2(n.nota.valor).replace(".", ",")}` });
    await enviar(jid, { document: Buffer.from(n.xml, "utf8"), mimetype: "application/xml", fileName: `${chave}-nfe.xml` });
  }

  app.get("/nfe/nota/:chave/:tipo(xml|pdf)", autenticar, rota(async (req, res) => {
    const n = await lerNota(req.emp.id, req.params.chave);
    if (!n) return res.status(404).json({ erro: "Nota não encontrada." });
    if (req.params.tipo === "xml") {
      res.set("Content-Type", "application/xml; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="${req.params.chave}-nfe.xml"`);
      return res.send(n.xml);
    }
    const pdf = await gerarDanfe(n.xml);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="NFe-${n.nota.numero}.pdf"`);
    res.send(pdf);
  }));

  app.post("/nfe/nota/:chave/whatsapp", autenticar, rota(async (req, res) => {
    const numero = so(req.body?.numero);
    if (numero.length < 10) throw new Error("WhatsApp com DDD, só números.");
    await mandarWhatsApp(req.emp.id, req.params.chave, numero);
    res.json({ ok: true });
  }));

  app.post("/nfe/nota/:chave/cancelar", autenticar, rota(async (req, res) => {
    const just = txt(req.body?.justificativa, 255);
    if (just.length < 15) throw new Error("A justificativa precisa ter pelo menos 15 letras.");
    const r = await travar(req.emp.id, async () => {
      const emp = await lerEmpresa(req.emp.id);
      const n = await lerNota(emp.id, req.params.chave);
      if (!n || n.nota.status !== "autorizada") throw new Error("Só dá pra cancelar nota autorizada.");
      const tools = await ferramentas(emp, n.nota.amb);
      const ret = await tools.sefazEvento({ chNFe: req.params.chave, tpEvento: "110111", nProt: n.nota.prot, xJust: just, dhEvento: dhBrasilia() });
      const inf = bloco(ret, "retEvento") || ret;
      const cStat = tag(inf, "cStat"), motivo = tag(inf, "xMotivo");
      if (!["135", "155"].includes(cStat)) throw new Error(`Sefaz não cancelou (${cStat || "?"}): ${motivo || "sem motivo"}`);
      n.nota.status = "cancelada";
      n.nota.canceladaEm = Date.now();
      n.cancelamento = ret;
      await fsdb.setCampos(caminhoNota(emp.id, req.params.chave), { d: cofre().cifrar(n) });
      emp.notas = (emp.notas || []).map((x) => (x.chave === req.params.chave ? { ...x, status: "cancelada" } : x));
      await salvarEmpresa(emp);
      return publico(emp);
    });
    res.json({ ok: true, empresa: r });
  }));

  // ---------- comandos do Keller (#nfe ...) ----------
  async function comando(arg) {
    const [sub, ...resto] = String(arg || "").trim().split(/\s+/);
    const valor = resto.join(" ").trim();
    switch ((sub || "").toLowerCase()) {
      case "nova": {
        if (!valor) return "Escreva assim: #nfe nova Nome da Empresa";
        if (!cofre()) return "⚠️ O motor está sem chave de segurança (SEGREDO_SESSAO), não dá pra guardar certificado.";
        const { id, senha } = await criarEmpresa(valor);
        const idx = (await fsdb.getDoc("config/nfe-indice").catch(() => null)) || {};
        const lista = idx.d ? cofre().decifrar(idx.d) : {};
        lista[id] = { nome: txt(valor, 60), em: Date.now() };
        await fsdb.setCampos("config/nfe-indice", { d: cofre().cifrar(lista) });
        return `🧾 *Empresa criada no app de Nota Fiscal*\n${txt(valor, 60)}\n\nApp: ${SITE_NFE}\nCódigo: *${id}*\nSenha: *${senha}*\n\nPode mandar isso pro cliente. Ele entra, preenche os dados da empresa, envia o certificado A1 e já emite nota de TESTE.`;
      }
      case "empresas":
      case "lista": {
        const idx = await fsdb.getDoc("config/nfe-indice").catch(() => null);
        const lista = idx?.d ? cofre().decifrar(idx.d) : {};
        const ids = Object.keys(lista);
        if (!ids.length) return "🧾 Nenhuma empresa no app de nota ainda. Crie com: #nfe nova Nome da Empresa";
        const linhas = [];
        for (const id of ids) {
          const e = await lerEmpresa(id).catch(() => null);
          if (!e) continue;
          linhas.push(`• *${e.nome}* (${id})\n   ${e.cert ? "certificado ok" : "sem certificado"} · ${e.ambiente === 1 ? "PRODUÇÃO" : "teste"} · ${(e.notas || []).length} nota(s)`);
        }
        return `🧾 *Empresas no app de nota*\n\n${linhas.join("\n")}`;
      }
      case "senha": {
        const e = await lerEmpresa(valor.toLowerCase());
        if (!e) return "Não achei essa empresa. Mande #nfe empresas pra ver os códigos.";
        const senha = crypto.randomBytes(4).toString("hex");
        await travar(e.id, async () => {
          const emp = await lerEmpresa(e.id);
          const { sal, hash } = hashSenha(senha);
          emp.senhaSal = sal; emp.senhaHash = hash; emp.senhaVersao = (emp.senhaVersao || 0) + 1;
          await salvarEmpresa(emp);
        });
        return `🧾 Senha nova de *${e.nome}*: *${senha}*\nCódigo: ${e.id}\n${SITE_NFE}`;
      }
      default:
        return "🧾 *App de Nota Fiscal*\n• #nfe nova Nome da Empresa → cria o acesso\n• #nfe empresas → lista\n• #nfe senha código → gera senha nova";
    }
  }

  return { comando };
}

module.exports = { registrarNfe, _teste: { prepararNota, montarXml, lerCertificado, cnpjValido, cpfValido, dhBrasilia, tag, bloco } };
