/**
 * Ponto Eletrônico (app em kellercamilodeoliveira-del.github.io/apps/ponto).
 *
 * A cada batida no tablet, o app chama POST /ponto/comprovante com
 * { empresa, marcacao }. O motor confere a batida direto no Firestore
 * (nada do que o tablet manda é usado como conteúdo), gera o comprovante
 * em PDF e manda no WhatsApp do colaborador e do gestor.
 */
const PDFDocument = require("pdfkit");

const PROJETO = "escritorio-c3acb";
const API_KEY_FIREBASE = "AIzaSyBZyZ4Dqs0BI5VSsm3HB2TNGpk7Z7330CE";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents`;
const ORIGENS = ["https://kellercamilodeoliveira-del.github.io", "http://localhost:8765"];
const VALIDADE_MS = 15 * 60 * 1000; // só manda comprovante de batida feita nos últimos 15 min
const LIMITE_DIA_EMPRESA = 600; // trava contra abuso
const FUSO = "America/Sao_Paulo";

function valor(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return campos(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(valor);
  return null;
}
function campos(f) {
  const o = {};
  for (const k in f) o[k] = valor(f[k]);
  return o;
}
async function lerDoc(caminho) {
  const r = await fetch(`${BASE}/${caminho}?key=${API_KEY_FIREBASE}`);
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`Firestore GET ${caminho}: ${r.status}`);
  const d = await r.json();
  return campos(d.fields || {});
}

const soNumeros = (v) => String(v || "").replace(/\D/g, "");
const dataBR = (d) => d.toLocaleDateString("pt-BR", { timeZone: FUSO, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
const horaBR = (d) => d.toLocaleTimeString("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
const slug = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function gerarPdf({ emp, m, cod, marcacao }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 36 });
    const partes = [];
    doc.on("data", (c) => partes.push(c));
    doc.on("end", () => resolve(Buffer.concat(partes)));
    doc.on("error", reject);
    const W = doc.page.width;
    doc.rect(0, 0, W, 8).fill("#4f46e5");
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(16).text(emp.nome || "", 36, 30);
    doc.font("Helvetica").fontSize(9).fillColor("#555");
    if (emp.cnpj) doc.text(`CNPJ: ${emp.cnpj}`);
    if (emp.endereco) doc.text(emp.endereco);
    doc.moveDown(1.2);
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(13).text("Comprovante de Registro de Ponto");
    doc.moveDown(0.8);
    const linha = (rotulo, texto) => {
      doc.font("Helvetica").fontSize(9).fillColor("#666").text(rotulo.toUpperCase());
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(texto || "-");
      doc.moveDown(0.5);
    };
    linha("Colaborador", m.nome || cod.nome);
    linha("Registro", m.tipo);
    linha("Data", dataBR(m.ts));
    linha("Hora", horaBR(m.ts));
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(8).fillColor("#777")
      .text(`Registrado no ponto eletrônico da empresa. Recebido pelo sistema às ${horaBR(m.recebido)}.`)
      .text(`Código do registro: ${marcacao}`);
    doc.fontSize(7).fillColor("#999").text("Ponto Eletrônico por Keller IA", 36, doc.page.height - 50);
    doc.end();
  });
}

function registrarPonto(app, { enviar, paraJid, estaConectado }) {
  const jaEnviadas = new Map(); // marcacao -> quando
  const contagem = new Map(); // empresa|dia -> quantas

  app.use("/ponto", (req, res, next) => {
    const origem = req.headers.origin;
    if (ORIGENS.includes(origem)) {
      res.set("Access-Control-Allow-Origin", origem);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  async function esperarConexao(maxMs) {
    const ate = Date.now() + maxMs;
    while (!estaConectado() && Date.now() < ate) await new Promise((r) => setTimeout(r, 3000));
    return estaConectado();
  }

  async function processar(empresa, marcacao) {
    const m = await lerDoc(`ponto_empresas/${empresa}/marcacoes/${marcacao}`);
    if (!m || m.origem !== "funcionario" || !(m.ts instanceof Date) || !(m.recebido instanceof Date)) return;
    if (Date.now() - m.recebido.getTime() > VALIDADE_MS) return;
    const emp = await lerDoc(`ponto_empresas/${empresa}`);
    if (!emp) return;
    const dia = new Date().toISOString().slice(0, 10), chave = `${empresa}|${dia}`;
    const n = (contagem.get(chave) || 0) + 1;
    contagem.set(chave, n);
    if (n > LIMITE_DIA_EMPRESA) return console.log(`⚠️ Ponto: limite diário de comprovantes atingido em ${empresa}.`);
    const cod = m.codigo ? await lerDoc(`ponto_empresas/${empresa}/codigos/${m.codigo}`) : null;
    if (!cod || cod.funcionarioId !== m.funcionarioId) return;
    const aviso = emp.notificar || {};
    const destinos = [];
    if (soNumeros(cod.whatsapp).length >= 10 && aviso.funcionario !== false) destinos.push(cod.whatsapp);
    if (soNumeros(emp.whatsappGestor).length >= 10 && aviso.gestor !== false) destinos.push(emp.whatsappGestor);
    if (!destinos.length) return;
    if (!(await esperarConexao(120000))) return console.log("⚠️ Ponto: WhatsApp desconectado, comprovante não enviado.");
    const pdf = await gerarPdf({ emp, m, cod, marcacao });
    const legenda = `🕐 *${m.tipo}* registrada\n${m.nome}\n${dataBR(m.ts)} às ${horaBR(m.ts)}\n${emp.nome}`;
    const fileName = `ponto-${slug(m.nome)}-${m.ts.toISOString().slice(0, 10)}-${horaBR(m.ts).replace(":", "h")}.pdf`;
    const vistos = new Set();
    for (const numero of destinos) {
      const jid = paraJid(numero);
      if (vistos.has(jid)) continue;
      vistos.add(jid);
      try {
        await enviar(jid, { document: pdf, mimetype: "application/pdf", fileName, caption: legenda });
      } catch (e) {
        console.error("Ponto: erro ao mandar comprovante:", e.message);
      }
    }
  }

  app.post("/ponto/comprovante", (req, res) => {
    const { empresa, marcacao } = req.body || {};
    if (!/^[a-z0-9-]{3,40}$/.test(String(empresa || "")) || !/^[A-Za-z0-9]{10,40}$/.test(String(marcacao || ""))) {
      return res.status(400).json({ erro: "Dados inválidos." });
    }
    if (jaEnviadas.has(marcacao)) return res.json({ ok: true, repetido: true });
    jaEnviadas.set(marcacao, Date.now());
    if (jaEnviadas.size > 5000) jaEnviadas.delete(jaEnviadas.keys().next().value);
    res.status(202).json({ ok: true });
    processar(empresa, marcacao).catch((e) => console.error("Ponto: erro no comprovante:", e.message));
  });
}

module.exports = { registrarPonto, _teste: { gerarPdf, campos } };
