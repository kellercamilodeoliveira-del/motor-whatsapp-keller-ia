/**
 * Motor de WhatsApp — Keller IA
 *
 * O que faz:
 *  - Conecta no WhatsApp do Keller (QR code na página inicial, só na primeira vez).
 *  - ATENDENTE: responde sozinho quem chama, com os dados de empresas/keller-ia.json
 *    e com tudo o que o Keller já ensinou.
 *  - Quando não sabe responder, avisa o cliente que vai confirmar e manda a pergunta
 *    pro Keller na conversa dele com ele mesmo ("Você"). O Keller responde ali
 *    (arrastando a mensagem pro lado) ou direto na conversa do cliente, e o motor
 *    guarda a resposta pra usar nas próximas vezes.
 *  - Conversa com todo mundo (clientes, família, amigos). Se o Keller digitar numa
 *    conversa, o atendente fica quieto nela por 2h. Grupos nunca são respondidos.
 *  - Endpoints /enviar e /auto-enviar continuam servindo o Painel de Leads.
 *
 * Plano grátis do Render:
 *  - A sessão do WhatsApp fica salva no Firestore (criptografada), então reinício
 *    não pede QR code de novo.
 *  - O próprio motor se chama a cada 10 minutos pra não "dormir".
 *
 * Usa a biblioteca Baileys (não oficial). Funciona bem, mas evite volume alto de
 * mensagens iguais pra não arriscar o número.
 */

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadMediaMessage,
  generateMessageIDV2,
} = require("@whiskeysockets/baileys");

const fsdb = require("./firestore");
const { criarCofre } = require("./cofre");
const { usarSessaoFirestore } = require("./sessao");
const { carregarMemoria } = require("./memoria");
const { criarAtendente } = require("./atendente");
const { mensagemPadrao, hojeData } = require("./prospeccao");
const { registrarPonto } = require("./ponto");

const EMPRESAS_DIR = path.join(__dirname, "empresas");
const EMPRESA_ARQUIVO = process.env.EMPRESA_ARQUIVO || "keller-ia.json";
const AUTH_DIR = path.join(__dirname, "auth_info");
const ATENDENTE_LIGADO = process.env.ATENDENTE_LIGADO === "sim"; // desligado por padrão
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ""; // chave que o painel de leads usa pra autenticar o envio

const PAUSA_KELLER_FALOU_MS = 2 * 60 * 60 * 1000; // Keller entrou numa conversa: atendente fica quieto 2h pra não atropelar
const PAUSA_KELLER_RESOLVEU_MS = 10 * 60 * 1000; // Keller respondeu uma pendência na conversa: volta em 10 min
const ESPERA_JUNTAR_MS = 6000; // espera o cliente terminar de mandar várias mensagens seguidas
const IDADE_MAX_MSG_MS = 30 * 60 * 1000; // ignora mensagens antigas (histórico)
const LIMITE_ENVIOS_POR_DIA = 20;
const ENVIOS_POR_EXECUCAO = 2;

// ---------- IA ----------
let groq = null;
if (process.env.GROQ_API_KEY) {
  try {
    const Groq = require("groq-sdk");
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log("🤖 Atendente de IA ativado (GROQ_API_KEY encontrada).");
  } catch (erro) {
    console.error("Não consegui iniciar a IA (seguindo sem ela):", erro.message);
  }
} else {
  console.log("ℹ️  GROQ_API_KEY não configurada — atendente desligado (só /enviar funciona).");
}

function carregarEmpresa() {
  const arquivo = path.join(EMPRESAS_DIR, EMPRESA_ARQUIVO);
  if (fs.existsSync(arquivo)) return JSON.parse(fs.readFileSync(arquivo, "utf-8"));
  const primeiro = fs.readdirSync(EMPRESAS_DIR).find((f) => f.endsWith(".json"));
  return primeiro ? JSON.parse(fs.readFileSync(path.join(EMPRESAS_DIR, primeiro), "utf-8")) : null;
}

const cofre = criarCofre();
if (!cofre) console.log("⚠️  Sem SEGREDO_SESSAO/GROQ_API_KEY: sessão e memória não serão salvas no Firestore.");

let memoria = null;
let atendente = null;
let sessao = null;
let sock = null;
let ultimoQrDataUrl = null;
let statusConexao = "iniciando"; // iniciando | aguardando_qr | conectado | caiu

// ---------- Utilidades ----------
const enviadasPeloMotor = new Set();
function lembrarEnviada(id) {
  enviadasPeloMotor.add(id);
  if (enviadasPeloMotor.size > 3000) enviadasPeloMotor.delete(enviadasPeloMotor.values().next().value);
}

// Guarda as mensagens que o motor mandou. Se o celular de quem recebe não
// conseguir abrir a criptografia, ele pede reenvio, e o Baileys busca aqui
// (getMessage). Sem isso a mensagem fica "Aguardando mensagem" pra sempre.
const MAX_GUARDADAS = 500;
const mensagensGuardadas = new Map(); // id -> conteúdo (proto.IMessage)
const MAX_SALVAS = 150; // quantas mensagens de texto ficam salvas no Firestore
function guardarMensagem(id, conteudo) {
  if (!id || !conteudo) return;
  mensagensGuardadas.set(id, conteudo);
  if (mensagensGuardadas.size > MAX_GUARDADAS) mensagensGuardadas.delete(mensagensGuardadas.keys().next().value);
  // Texto também vai pro Firestore: se o Render reiniciar antes do celular pedir
  // o reenvio, a mensagem ainda pode ser reenviada (senão fica "Aguardando mensagem").
  const texto = conteudo.conversation || conteudo.extendedTextMessage?.text;
  if (texto && memoria) {
    const salvas = memoria.dados.enviadas || (memoria.dados.enviadas = {});
    salvas[id] = { t: texto, em: Date.now() };
    const ids = Object.keys(salvas);
    if (ids.length > MAX_SALVAS) {
      ids.sort((a, b) => salvas[a].em - salvas[b].em);
      for (const velho of ids.slice(0, ids.length - MAX_SALVAS)) delete salvas[velho];
    }
    memoria.salvar("enviadas");
  }
}
function mensagemGuardada(id) {
  const m = mensagensGuardadas.get(id);
  if (m) return m;
  const salva = memoria?.dados?.enviadas?.[id];
  if (salva) {
    console.log(`🔁 Reenviando mensagem ${id} (recuperada do Firestore).`);
    return { conversation: salva.t };
  }
  console.log(`⚠️ Celular pediu reenvio da mensagem ${id}, mas ela não está guardada.`);
  return undefined;
}

// Contador de tentativas de reenvio (o Baileys usa pra não reenviar em loop).
const contadorReenvio = (() => {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
      if (m.size > 2000) m.delete(m.keys().next().value);
    },
    del: (k) => m.delete(k),
    flushAll: () => m.clear(),
  };
})();

async function enviar(jid, conteudo) {
  const messageId = generateMessageIDV2(sock.user?.id);
  lembrarEnviada(messageId); // antes de enviar: o eco da própria mensagem chega quase na hora
  const enviada = await sock.sendMessage(jid, conteudo, { messageId });
  guardarMensagem(enviada?.key?.id || messageId, enviada?.message);
  // Cada envio muda as chaves de criptografia: salva já, pra não perder se o Render reiniciar.
  sessao?.gravar().catch(() => {});
  return enviada;
}

function meusJids() {
  const me = sock?.authState?.creds?.me || sock?.user || {};
  const s = new Set();
  if (me.id) s.add(jidNormalizedUser(me.id));
  if (me.lid) s.add(jidNormalizedUser(me.lid));
  return s;
}
function meuJidPrincipal() {
  const me = sock?.authState?.creds?.me || sock?.user || {};
  return me.id ? jidNormalizedUser(me.id) : null;
}

const conversaPrivada = (jid) => /@(s\.whatsapp\.net|lid)$/.test(jid || "");
const digitos = (jid) => String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
const ultimos8 = (n) => String(n || "").replace(/\D/g, "").slice(-8);

function numeroBonito(jid) {
  if (!/@s\.whatsapp\.net$/.test(jid)) return "número oculto pelo WhatsApp";
  return `wa.me/${digitos(jid)}`;
}

function paraJid(numero) {
  let d = String(numero).replace(/\D/g, "");
  if (d.length <= 11) d = "55" + d;
  return `${d}@s.whatsapp.net`;
}

function conteudoDa(m) {
  const msg = m.message || {};
  return msg.ephemeralMessage?.message || msg.viewOnceMessageV2?.message || msg.viewOnceMessage?.message || msg;
}
function textoDa(m) {
  const c = conteudoDa(m);
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    c.buttonsResponseMessage?.selectedDisplayText ||
    c.listResponseMessage?.title ||
    c.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  );
}
function idadeMs(m) {
  const t = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
  return t ? Date.now() - t * 1000 : 0;
}

function estaIgnorado(jid, m) {
  const lista = memoria?.dados.ajustes.ignorar || [];
  const candidatos = [digitos(jid), digitos(m?.key?.senderPn), digitos(m?.key?.remoteJidAlt)].filter(Boolean);
  return lista.some((n) => candidatos.some((c) => ultimos8(c) === ultimos8(n)));
}
function estaPausado(jid) {
  const ate = memoria?.dados.pausas[jid];
  if (!ate) return false;
  if (Date.now() < ate) return true;
  delete memoria.dados.pausas[jid];
  memoria.salvar("pausas");
  return false;
}
function pausar(jid, ms) {
  memoria.dados.pausas[jid] = Date.now() + ms;
  memoria.salvar("pausas");
}

function gerarCodigo() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do {
    c = Array.from({ length: 3 }, () => letras[Math.floor(Math.random() * letras.length)]).join("");
  } while (memoria.dados.pendencias[c]);
  return c;
}
function pendenciaDoCliente(jid) {
  return Object.keys(memoria.dados.pendencias).find((c) => memoria.dados.pendencias[c].jid === jid) || null;
}

// ---------- Clientes de sistemas e pedidos de alteração ----------
// Só números cadastrados com #cliente podem pedir alteração em sistema.
// O agente "Mecânico" (tarefa agendada do time) lê os pedidos em /time/alteracoes,
// faz a mudança, manda link de teste e só publica depois da aprovação do cliente.
function numeroDoCliente(jid, m) {
  const sistemas = memoria?.dados?.sistemas || {};
  const candidatos = [digitos(jid), digitos(m?.key?.senderPn), digitos(m?.key?.remoteJidAlt)].filter(Boolean);
  return Object.keys(sistemas).find((n) => candidatos.some((c) => ultimos8(c) === ultimos8(n))) || null;
}
function alteracoesDoCliente(jid) {
  return Object.entries(memoria.dados.alteracoes || {})
    .filter(([, a]) => a.jid === jid)
    .sort((a, b) => (b[1].atualizadoEm || 0) - (a[1].atualizadoEm || 0));
}
function clienteSistemaDe(jid, m) {
  const numero = numeroDoCliente(jid, m);
  if (!numero) return null;
  const cs = { ...memoria.dados.sistemas[numero], numero };
  const aberto = alteracoesDoCliente(jid).find(([, a]) => STATUS_ABERTOS.includes(a.status));
  if (aberto) {
    const [id, a] = aberto;
    cs.pedidoAberto = { id, pedido: a.pedido, status: a.status, link: a.linkTeste || "" };
    if (a.status === "em_teste") cs.testeAberto = cs.pedidoAberto;
  }
  return cs;
}
const STATUS_ABERTOS = ["novo", "em_andamento", "em_teste", "aguardando_cliente", "escalado"];
function gerarIdAlteracao() {
  return "ALT-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
}
function registrarAlteracao(jid, nome, cs, pedido) {
  const agora = Date.now();
  // Já tem pedido em aberto (ajuste no teste, detalhe a mais, aceite de orçamento):
  // entra no mesmo pedido e volta pra fila do Mecânico.
  if (cs.pedidoAberto && memoria.dados.alteracoes[cs.pedidoAberto.id]) {
    const a = memoria.dados.alteracoes[cs.pedidoAberto.id];
    if (a.status !== "escalado") a.status = "novo";
    a.historico.push({ em: agora, de: "cliente", texto: pedido });
    a.atualizadoEm = agora;
    memoria.salvar("alteracoes");
    console.log(`🛠️ Complemento no pedido ${cs.pedidoAberto.id} (${cs.cliente}): ${pedido}`);
    return cs.pedidoAberto.id;
  }
  const id = gerarIdAlteracao();
  memoria.dados.alteracoes[id] = {
    jid,
    numero: cs.numero,
    nome: nome || "",
    cliente: cs.cliente,
    sistema: cs.sistema,
    pedido,
    status: "novo", // novo | em_andamento | em_teste | aprovado | publicado | escalado | cancelado
    linkTeste: "",
    historico: [{ em: agora, de: "cliente", texto: pedido }],
    criadoEm: agora,
    atualizadoEm: agora,
  };
  // Guarda só os 100 mais recentes.
  const ids = Object.keys(memoria.dados.alteracoes);
  if (ids.length > 100) {
    ids.sort((x, y) => memoria.dados.alteracoes[x].atualizadoEm - memoria.dados.alteracoes[y].atualizadoEm);
    for (const velho of ids.slice(0, ids.length - 100)) delete memoria.dados.alteracoes[velho];
  }
  memoria.salvar("alteracoes");
  console.log(`🛠️ Novo pedido de alteração ${id} (${cs.cliente} / ${cs.sistema}): ${pedido}`);
  return id;
}
function aprovarTeste(cs) {
  if (!cs.testeAberto) return null;
  const a = memoria.dados.alteracoes[cs.testeAberto.id];
  if (!a) return null;
  a.status = "aprovado";
  a.historico.push({ em: Date.now(), de: "cliente", texto: "Aprovou o teste." });
  a.atualizadoEm = Date.now();
  memoria.salvar("alteracoes");
  console.log(`🛠️ Cliente aprovou o teste do pedido ${cs.testeAberto.id}.`);
  return cs.testeAberto.id;
}

// Notificação que TOCA no celular (mensagem pra si mesmo no WhatsApp não toca).
// Usa o app gratuito ntfy; o tópico é criado pelo comando #aviso.
async function notificarCelular(titulo, texto) {
  const topico = memoria?.dados?.ajustes?.ntfy;
  if (!topico) return;
  try {
    await fetch(`https://ntfy.sh/${topico}`, {
      method: "POST",
      body: texto,
      headers: { Title: titulo, Priority: "high", Tags: "bell" },
    });
  } catch (erro) {
    console.error("Não consegui mandar a notificação pro celular:", erro.message);
  }
}

async function avisarKeller(texto) {
  const eu = meuJidPrincipal();
  if (!eu) return null;
  try {
    return await enviar(eu, { text: texto });
  } catch (erro) {
    console.error("Não consegui avisar o Keller:", erro.message);
    return null;
  }
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Atendimento ----------
const filaCliente = new Map(); // jid -> { partes, nome, timer, msg }

function enfileirarCliente(jid, nome, texto, m) {
  const f = filaCliente.get(jid) || { partes: [], nome, timer: null, msg: m };
  f.partes.push(texto);
  f.nome = nome || f.nome;
  f.msg = m;
  clearTimeout(f.timer);
  f.timer = setTimeout(() => {
    filaCliente.delete(jid);
    processarCliente(jid, f.nome, f.partes.join("\n"), f.msg).catch((e) =>
      console.error("Erro no atendimento:", e)
    );
  }, ESPERA_JUNTAR_MS);
  filaCliente.set(jid, f);
}

async function processarCliente(jid, nome, texto, m) {
  if (!memoria.dados.ajustes.ativo || estaPausado(jid) || estaIgnorado(jid, m)) return;
  const empresa = carregarEmpresa();
  if (!empresa) return;

  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch {}

  const cs = clienteSistemaDe(jid, m);
  let r;
  try {
    r = await atendente.responder(jid, nome, texto, cs);
  } catch (erro) {
    console.error("Erro da IA:", erro.message);
    await avisarKeller(
      `⚠️ A IA não conseguiu responder ${nome || "um cliente"} (${numeroBonito(jid)}). Mensagem dele:\n\n"${texto}"\n\nResponda você direto na conversa.`
    );
    return;
  }

  if (r.silencio) {
    console.log(`🤫 Mensagem pessoal de ${nome || jid}, não respondi.`);
    try {
      await sock.sendPresenceUpdate("paused", jid);
    } catch {}
    return;
  }

  // Se o Keller entrou na conversa enquanto a IA pensava, não atropela.
  if (estaPausado(jid)) return;

  if (r.texto) {
    // Como gente: às vezes 2 mensagens seguidas, com "digitando..." entre elas.
    const partes = r.texto.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    const bolhas = partes.length > 2 ? [partes[0], partes.slice(1).join("\n")] : partes;
    for (let i = 0; i < bolhas.length; i++) {
      if (i > 0) {
        try {
          await sock.sendPresenceUpdate("composing", jid);
        } catch {}
      }
      await espera(Math.min(6000, 1000 + bolhas[i].length * 45 + Math.random() * 800));
      if (estaPausado(jid)) return; // Keller entrou na conversa no meio
      await enviar(jid, { text: bolhas[i] });
    }
    console.log(`📤 Respondi ${nome || jid}: ${bolhas.join(" / ")}`);
  }
  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch {}

  if (cs && (r.alteracao || r.aprovado)) {
    if (r.aprovado) aprovarTeste(cs);
    if (r.alteracao) registrarAlteracao(jid, nome, cs, r.alteracao.pedido);
    return; // pedido de sistema: quem cuida é o time, não precisa chamar o Keller
  }
  if (r.chamar && r.chamar.pergunta) await criarPendencia(jid, nome, r.chamar.pergunta);
  // Cliente de sistema falando do sistema (ex.: "o campo da agenda") não pode virar pendência por engano.
  else if (!cs && PEDIDO_DE_ACAO.test(texto)) await criarPendencia(jid, nome, `Pediu: "${texto}"`);
}

// Coisas que a assistente não consegue fazer sozinha: se a pessoa pedir e a IA
// esquecer de chamar o Keller, o motor chama mesmo assim.
const PEDIDO_DE_ACAO =
  /\b(alarme|despertador|lembrete|lembra (ele|o keller)|agenda|agendar|marca(r)? (um|uma|o|a)? ?hor[aá]rio|pix|pagar|pagamento|transfer|encomend|comprar|reserva|buscar|busca (eu|a gente)|leva(r)? |traz(er)? |confirma)/i;

async function criarPendencia(jid, nome, pergunta, alteracaoId = null) {
  const existente = pendenciaDoCliente(jid);
  let codigo = existente;
  if (existente) {
    const p = memoria.dados.pendencias[existente];
    p.pergunta = `${p.pergunta} / ${pergunta}`;
  } else {
    codigo = gerarCodigo();
    memoria.dados.pendencias[codigo] = { jid, nome: nome || "", pergunta, criadaEm: Date.now(), alertaId: null };
  }
  const p = memoria.dados.pendencias[codigo];
  if (alteracaoId) p.alteracaoId = alteracaoId;
  const alerta = await avisarKeller(
    p.alteracaoId
      ? `🛠️ *O time precisa de você* (#${codigo})\n` +
          `👤 ${p.nome || "Cliente"} — ${numeroBonito(jid)}\n\n` +
          `${p.pergunta}\n\n` +
          `*Arraste esta mensagem pro lado e responda* (ex.: "pode fazer", "cobra R$ 300", "não faz"). O time segue a partir da sua resposta e fala com o cliente.`
      : `❓ *Pergunta de cliente* (#${codigo})\n` +
          `👤 ${p.nome || "Cliente"} — ${numeroBonito(jid)}\n\n` +
          `${p.pergunta}\n\n` +
          `Eu disse que ia confirmar com você. *Arraste esta mensagem pro lado e escreva a resposta*: eu mando pro cliente e guardo pra próxima vez. ` +
          `Se preferir, responda direto na conversa dele.`
  );
  if (alerta?.key?.id) p.alertaId = alerta.key.id;
  memoria.salvar("pendencias");
  await notificarCelular(
    `Assistente precisa de voce (#${codigo})`,
    `${p.nome || "Contato"} (${numeroBonito(jid)}): ${p.pergunta}\n\nResponda na conversa com voce mesmo no WhatsApp.`
  );
}

function guardarConhecimento(pergunta, resposta) {
  const lista = memoria.dados.conhecimento.filter((c) => c.p.toLowerCase() !== pergunta.toLowerCase());
  lista.push({ p: pergunta, r: resposta, em: new Date().toISOString().slice(0, 10) });
  memoria.dados.conhecimento = lista.slice(-300);
  memoria.salvar("conhecimento");
}

async function resolverPendencia(codigo, resposta, origem) {
  const p = memoria.dados.pendencias[codigo];
  if (!p) return;
  if (!resposta) {
    await avisarKeller(`Faltou a resposta da #${codigo}. Escreva assim: #${codigo} sua resposta`);
    return;
  }
  delete memoria.dados.pendencias[codigo];
  memoria.salvar("pendencias");
  if (p.alteracaoId && memoria.dados.alteracoes[p.alteracaoId]) {
    // Resposta do Keller sobre um pedido de alteração: volta pro Mecânico com a decisão dele.
    const a = memoria.dados.alteracoes[p.alteracaoId];
    a.historico.push({ em: Date.now(), de: "keller", texto: resposta });
    a.status = "novo";
    a.atualizadoEm = Date.now();
    memoria.salvar("alteracoes");
    // Não repassa direto pro cliente: o Mecânico lê a decisão e conversa com ele.
    await avisarKeller(`✅ Recebi sua decisão sobre o pedido ${p.alteracaoId}. O time continua daqui e fala com ${p.nome || "o cliente"}.`);
    return;
  }
  guardarConhecimento(p.pergunta, resposta);

  if (origem === "conversa") {
    atendente.anotarFalaDoKeller(p.jid, resposta);
    pausar(p.jid, PAUSA_KELLER_RESOLVEU_MS);
    await avisarKeller(`✅ Guardei sua resposta pra "${p.pergunta}". Daqui a 10 minutos eu volto a atender ${p.nome || "esse cliente"}.`);
    return;
  }

  try {
    const texto = await atendente.redigirResposta(p.jid, p.pergunta, resposta);
    await enviar(p.jid, { text: texto });
    await avisarKeller(`✅ Respondi ${p.nome || "o cliente"} e guardei pra próxima:\n\n"${texto}"`);
  } catch (erro) {
    console.error("Erro ao mandar a resposta do Keller:", erro.message);
    await enviar(p.jid, { text: resposta });
    await avisarKeller(`✅ Mandei sua resposta pro ${p.nome || "cliente"} do jeito que você escreveu e guardei pra próxima.`);
  }
}

const AJUDA =
  "🤖 *Comandos do atendente* (mande aqui, na conversa com você mesmo):\n\n" +
  "• Arraste uma pergunta pro lado e responda: eu repasso e guardo.\n" +
  "• #ABC resposta → responde a pergunta #ABC\n" +
  "• #ensinar pergunta | resposta → ensina algo novo\n" +
  "• #esquecer pergunta → apaga algo que ensinou\n" +
  "• #ignorar 14999999999 → nunca responder esse número\n" +
  "• #liberar 14999999999 → voltar a responder esse número\n" +
  "• #desligar / #ligar → para ou volta todo o atendimento\n" +
  "• #status → o que está pendente\n" +
  "• #aviso → liga a notificação que toca no celular quando eu precisar de você\n" +
  "• #aviso desligar → desliga essa notificação\n" +
  "• #aprendido → tudo o que você já ensinou\n\n" +
  "🛠️ *Clientes de sistemas* (o time cuida das alterações):\n" +
  "• #cliente 14999999999 | Empresa | Sistema → cadastra quem pode pedir alteração\n" +
  "• #cliente remover 14999999999 → tira do cadastro\n" +
  "• #clientes → lista os cadastrados\n" +
  "• #pedidos → pedidos de alteração em aberto";

// Avisos que o próprio motor manda na conversa do Keller. Se um deles voltar
// como "mensagem do Keller" (eco depois de reinício/reenvio), não pode virar resposta pro cliente.
function pareceAvisoDoMotor(texto) {
  const t = String(texto || "").trim();
  return (
    /^(❓|✅|📋|📚|🔔|🔕|⚠️|🤖|⏸️|▶️|🗑️|🛠️)/u.test(t) ||
    /Pergunta de cliente|O time precisa de você|Arraste esta mensagem|Respondi .* e guardei|Comandos do atendente/i.test(t)
  );
}

async function comandoDoKeller(m, texto) {
  const t = texto.trim();
  const pend = memoria.dados.pendencias;
  const citado = conteudoDa(m).extendedTextMessage?.contextInfo?.stanzaId;

  // 1) Resposta a uma pergunta pendente
  const mc = t.match(/^#([A-Za-z0-9]{3})(?=\s|:|,|-|$)[\s:,-]*/);
  if (mc && pend[mc[1].toUpperCase()]) return resolverPendencia(mc[1].toUpperCase(), t.slice(mc[0].length).trim(), "chat");
  if (citado) {
    const codigo = Object.keys(pend).find((c) => pend[c].alertaId === citado);
    if (codigo) return resolverPendencia(codigo, t, "chat");
  }

  // 2) Comandos
  if (t.startsWith("#")) {
    const [cmd, ...resto] = t.slice(1).split(/\s+/);
    const arg = resto.join(" ").trim();
    switch (cmd.toLowerCase()) {
      case "ajuda":
      case "comandos":
        return avisarKeller(AJUDA);
      case "status": {
        const lista = Object.entries(pend).map(([c, p]) => `• #${c} ${p.nome || "Cliente"}: ${p.pergunta}`);
        return avisarKeller(
          `📋 Atendente ${memoria.dados.ajustes.ativo ? "LIGADO" : "DESLIGADO"}\n` +
            `Ensinamentos guardados: ${memoria.dados.conhecimento.length}\n` +
            `Números ignorados: ${memoria.dados.ajustes.ignorar.length}\n\n` +
            (lista.length ? `Perguntas esperando você:\n${lista.join("\n")}` : "Nenhuma pergunta pendente. ✅")
        );
      }
      case "aprendido": {
        const lista = memoria.dados.conhecimento.slice(-40).map((c) => `• ${c.p}\n   → ${c.r}`);
        return avisarKeller(lista.length ? `📚 O que você já me ensinou:\n\n${lista.join("\n")}` : "Ainda não aprendi nada com você.");
      }
      case "ensinar":
      case "aprender": {
        const [p, r] = arg.split("|").map((s) => (s || "").trim());
        if (!p || !r) return avisarKeller("Escreva assim: #ensinar pergunta | resposta");
        guardarConhecimento(p, r);
        return avisarKeller(`✅ Aprendi: "${p}" → "${r}"`);
      }
      case "esquecer": {
        const antes = memoria.dados.conhecimento.length;
        memoria.dados.conhecimento = memoria.dados.conhecimento.filter((c) => !c.p.toLowerCase().includes(arg.toLowerCase()));
        memoria.salvar("conhecimento");
        return avisarKeller(`🗑️ Apaguei ${antes - memoria.dados.conhecimento.length} ensinamento(s).`);
      }
      case "ignorar": {
        const n = arg.replace(/\D/g, "");
        if (n.length < 8) return avisarKeller("Escreva assim: #ignorar 14999999999");
        if (!memoria.dados.ajustes.ignorar.includes(n)) memoria.dados.ajustes.ignorar.push(n);
        memoria.salvar("ajustes");
        return avisarKeller(`🔕 Não vou mais responder o ${n}.`);
      }
      case "liberar": {
        const n = arg.replace(/\D/g, "");
        memoria.dados.ajustes.ignorar = memoria.dados.ajustes.ignorar.filter((x) => ultimos8(x) !== ultimos8(n));
        for (const jid of Object.keys(memoria.dados.pausas)) if (ultimos8(digitos(jid)) === ultimos8(n)) delete memoria.dados.pausas[jid];
        memoria.salvar("ajustes");
        memoria.salvar("pausas");
        return avisarKeller(`🔔 Voltei a responder o ${n}.`);
      }
      case "aviso":
      case "notificacao":
      case "notificação": {
        if (/^(desligar|off|parar)$/i.test(arg)) {
          delete memoria.dados.ajustes.ntfy;
          memoria.salvar("ajustes");
          return avisarKeller("🔕 Notificação no celular desligada.");
        }
        if (!memoria.dados.ajustes.ntfy) {
          memoria.dados.ajustes.ntfy = "keller-" + require("crypto").randomBytes(9).toString("hex");
          memoria.salvar("ajustes");
        }
        const topico = memoria.dados.ajustes.ntfy;
        await avisarKeller(
          "🔔 *Notificação no celular*\n\n" +
            "1. Instale o app gratuito *ntfy* (App Store ou Play Store).\n" +
            "2. Abra, toque em *+* e assine este tópico (copie exatamente):\n\n" +
            `${topico}\n\n` +
            "3. Permita as notificações.\n\n" +
            "Pronto: toda vez que alguém pedir algo que só você resolve, seu celular apita. Mandei um teste agora. Não compartilhe esse nome de tópico."
        );
        return notificarCelular("Teste da assistente", "Se apareceu, a notificação está funcionando!");
      }
      case "cliente": {
        if (/^remover\b/i.test(arg)) {
          const n = arg.replace(/\D/g, "");
          const achado = Object.keys(memoria.dados.sistemas).find((x) => ultimos8(x) === ultimos8(n));
          if (!achado) return avisarKeller("Não achei esse número no cadastro. Mande #clientes pra ver a lista.");
          delete memoria.dados.sistemas[achado];
          memoria.salvar("sistemas");
          return avisarKeller(`🗑️ Tirei o ${achado} do cadastro de clientes de sistema.`);
        }
        const [num, cliente, sistema, obs] = arg.split("|").map((x) => (x || "").trim());
        const n = (num || "").replace(/\D/g, "");
        if (n.length < 10 || !cliente || !sistema)
          return avisarKeller("Escreva assim: #cliente 14999999999 | Nome da empresa | Nome do sistema");
        memoria.dados.sistemas[n] = { cliente, sistema, ...(obs ? { obs } : {}) };
        memoria.salvar("sistemas");
        return avisarKeller(`🛠️ Cadastrado: ${n} (${cliente}) pode pedir alterações no ${sistema}. O time cuida e só te chama no que não resolver.`);
      }
      case "clientes": {
        const lista = Object.entries(memoria.dados.sistemas).map(([n, c]) => `• ${n} — ${c.cliente} (${c.sistema})`);
        return avisarKeller(lista.length ? `🛠️ Clientes de sistema:\n${lista.join("\n")}` : "🛠️ Nenhum cliente de sistema cadastrado ainda.");
      }
      case "pedidos": {
        const nomes = { novo: "na fila", em_andamento: "sendo feito", em_teste: "esperando o cliente aprovar", aprovado: "aprovado, vai pro ar", escalado: "esperando você" };
        const abertos = Object.entries(memoria.dados.alteracoes)
          .filter(([, a]) => nomes[a.status])
          .map(([id, a]) => `• ${id} ${a.cliente}: ${a.pedido} — ${nomes[a.status]}`);
        return avisarKeller(abertos.length ? `🛠️ Pedidos de alteração em aberto:\n${abertos.join("\n")}` : "🛠️ Nenhum pedido de alteração em aberto.");
      }
      case "desligar":
      case "pausar":
        memoria.dados.ajustes.ativo = false;
        memoria.salvar("ajustes");
        return avisarKeller("⏸️ Atendente desligado. Mande #ligar pra voltar.");
      case "ligar":
      case "ativar":
        memoria.dados.ajustes.ativo = true;
        memoria.salvar("ajustes");
        return avisarKeller(
          ATENDENTE_LIGADO
            ? "▶️ Atendente ligado."
            : "⏸️ O atendente de IA está desligado no sistema. Pra religar, peça pro Claude (ou crie ATENDENTE_LIGADO=sim no Render)."
        );
      default:
        return avisarKeller(`Não conheço o comando #${cmd}.\n\n${AJUDA}`);
    }
  }

  // 3) Texto solto: se só tem uma pergunta pendente (de menos de 12h), vale como resposta dela.
  const codigos = Object.keys(pend);
  if (
    codigos.length === 1 &&
    !pareceAvisoDoMotor(t) &&
    Date.now() - (pend[codigos[0]].criadaEm || 0) < 12 * 60 * 60 * 1000
  ) {
    return resolverPendencia(codigos[0], t, "chat");
  }
}

async function textoDeAudio(m) {
  try {
    const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
    return await atendente.transcrever(buffer);
  } catch (erro) {
    console.error("Não consegui transcrever áudio:", erro.message);
    return null;
  }
}

async function tratarMensagem(m, type) {
  if (!m.message || !m.key?.remoteJid) return;
  const jid = jidNormalizedUser(m.key.remoteJid);
  if (!conversaPrivada(jid)) return; // grupos, status, canais: nunca
  if (idadeMs(m) > IDADE_MAX_MSG_MS) return; // histórico antigo
  const c = conteudoDa(m);
  if (c.protocolMessage || c.reactionMessage || c.stickerMessage || c.senderKeyDistributionMessage && !textoDa(m)) return;

  const eu = meusJids();
  const naMinhaConversa = eu.has(jid);

  if (m.key.fromMe) {
    // Foi o próprio motor (inclusive mensagens de antes de um reinício, salvas no Firestore).
    if (enviadasPeloMotor.has(m.key.id) || memoria?.dados?.enviadas?.[m.key.id]) return;
    const texto = textoDa(m);
    if (naMinhaConversa && pareceAvisoDoMotor(texto)) return; // eco de um aviso do motor: nunca é resposta do Keller
    if (naMinhaConversa) {
      if (texto && memoria) await comandoDoKeller(m, texto);
      return;
    }
    // Keller digitou numa conversa de cliente
    if (!memoria) return;
    const f = filaCliente.get(jid);
    if (f) {
      clearTimeout(f.timer);
      filaCliente.delete(jid);
    }
    const codigo = pendenciaDoCliente(jid);
    if (codigo && texto) return resolverPendencia(codigo, texto, "conversa");
    pausar(jid, PAUSA_KELLER_FALOU_MS);
    if (texto && atendente) atendente.anotarFalaDoKeller(jid, texto);
    console.log(`👤 Keller falou com ${jid}: atendente pausado 2h nessa conversa.`);
    return;
  }

  // Mensagem de cliente
  // Atendente de IA DESLIGADO por decisão do Keller (nov/2026): não responde ninguém.
  // Pra religar no futuro, crie no Render a variável ATENDENTE_LIGADO=sim.
  // Exceção: clientes de sistema (cadastrados com #cliente) continuam atendidos, pra
  // pedidos de alteração e problemas nos apps chegarem no time (Mecânico).
  if (!ATENDENTE_LIGADO && !(memoria && numeroDoCliente(jid, m))) return;
  if (type !== "notify" || naMinhaConversa || !atendente || !memoria) return;
  if (!memoria.dados.ajustes.ativo || estaPausado(jid) || estaIgnorado(jid, m)) return;

  let texto = textoDa(m);
  if (!texto && c.audioMessage) {
    const transcrito = await textoDeAudio(m);
    texto = transcrito ? `(áudio) ${transcrito}` : "(a pessoa mandou um áudio que não consegui ouvir; peça com gentileza pra escrever)";
  }
  if (!texto && c.imageMessage) texto = "(o cliente mandou uma imagem sem texto)";
  if (!texto && c.documentMessage) texto = `(o cliente mandou um arquivo: ${c.documentMessage.fileName || "documento"})`;
  if (!texto && c.locationMessage) texto = "(o cliente mandou uma localização)";
  if (!texto && c.contactMessage) texto = "(o cliente mandou um contato)";
  if (!texto) return;

  console.log(`📩 ${m.pushName || jid}: ${texto}`);
  enfileirarCliente(jid, m.pushName || "", texto, m);
}

// ---------- Conexão ----------
async function prepararSessao() {
  if (cofre) {
    try {
      sessao = await usarSessaoFirestore(cofre);
      console.log(sessao.tinhaSessao ? "🔐 Sessão do WhatsApp recuperada do Firestore." : "🔐 Nenhuma sessão salva ainda: vai pedir QR code.");
      return;
    } catch (erro) {
      console.error("Não consegui usar a sessão do Firestore, usando disco:", erro.message);
    }
  }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sessao = { state, saveCreds, gravar: async () => {}, apagarTudo: async () => fs.rmSync(AUTH_DIR, { recursive: true, force: true }) };
}

async function iniciar() {
  if (!sessao) await prepararSessao();

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (erro) {
    console.error("Não consegui checar a versão mais recente do WhatsApp, seguindo com a padrão:", erro.message);
  }

  sock = makeWASocket({
    version,
    auth: sessao.state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false, // não "rouba" as notificações do celular do Keller
    syncFullHistory: false,
    msgRetryCounterCache: contadorReenvio,
    getMessage: async (key) => mensagemGuardada(key.id),
  });

  sock.ev.on("creds.update", () => sessao.saveCreds().catch((e) => console.error("Erro ao salvar login:", e.message)));

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      statusConexao = "aguardando_qr";
      try {
        ultimoQrDataUrl = await QRCode.toDataURL(qr);
        console.log("📱 Novo QR code gerado — abra a página inicial do serviço pra escanear.");
      } catch (erro) {
        console.error("Erro ao gerar imagem do QR code:", erro);
      }
    }

    if (connection === "close") {
      statusConexao = "caiu";
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const saiu = codigo === DisconnectReason.loggedOut;
      console.log(`Conexão caiu (código ${codigo}).${saiu ? " O aparelho foi desconectado: vou pedir QR code de novo." : " Reconectando..."}`);
      if (saiu) {
        await sessao.apagarTudo();
        sessao = null;
      } else {
        await sessao.gravar().catch(() => {});
      }
      setTimeout(() => iniciar().catch((e) => console.error("Erro ao reconectar:", e)), saiu ? 3000 : 2000);
    } else if (connection === "open") {
      statusConexao = "conectado";
      ultimoQrDataUrl = null;
      console.log("✅ Conectado ao WhatsApp!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      try {
        await tratarMensagem(m, type);
      } catch (erro) {
        console.error("Erro ao tratar mensagem:", erro);
      }
    }
  });
}

// ---------- Servidor HTTP ----------
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  if (statusConexao === "conectado") {
    const pend = memoria ? Object.keys(memoria.dados.pendencias).length : 0;
    res.send(`
      <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px 16px">
        <h1>${ATENDENTE_LIGADO ? "✅ Atendente Keller IA ligado" : "⏸️ Atendente de IA desligado (WhatsApp conectado)"}</h1>
        <p>${atendente ? "Respondendo clientes sozinho." : "IA desligada: falta a GROQ_API_KEY no Render."}</p>
        <p>Perguntas esperando o Keller: <b>${pend}</b></p>
        <p style="color:#666">Mande <b>#ajuda</b> na sua conversa com você mesmo no WhatsApp pra ver os comandos.</p>
      </body></html>
    `);
  } else if (ultimoQrDataUrl) {
    res.send(`
      <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px 16px">
        <h1>📱 Escaneie pra conectar seu WhatsApp</h1>
        <p>No celular: WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho</p>
        <img src="${ultimoQrDataUrl}" style="width:300px;height:300px;max-width:100%" />
        <p style="color:#888">A página atualiza sozinha a cada 5 segundos.</p>
        <script>setTimeout(() => location.reload(), 5000);</script>
      </body></html>
    `);
  } else {
    res.send(`
      <html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>⏳ Conectando...</h1>
        <p>Atualiza a página em alguns segundos.</p>
        <script>setTimeout(() => location.reload(), 4000);</script>
      </body></html>
    `);
  }
});

app.get("/status", (req, res) => {
  res.json({
    status: statusConexao,
    atendente: !!atendente,
    ligado: memoria ? memoria.dados.ajustes.ativo : null,
    sessaoSalva: !!cofre,
    pendencias: memoria ? Object.keys(memoria.dados.pendencias).length : 0,
    ensinamentos: memoria ? memoria.dados.conhecimento.length : 0,
  });
});

// Página simples com os horários marcados (usada pelos agentes de agendamento).
// ---------- Time de agentes (Mecânico) ----------
// Protegido por uma chave do time; aqui fica só o "resumo" (hash) dela, nunca a chave.
const HASH_CHAVE_TIME = "c87535395d8de249f44684a823cdd50c68980073734a8cf26e6d36c7c7cff5c7";
function chaveDoTimeOk(req) {
  const chave = String(req.headers["x-time-key"] || "");
  if (!chave) return false;
  const hash = require("crypto").createHash("sha256").update(chave).digest("hex");
  return hash === HASH_CHAVE_TIME;
}
const STATUS_VALIDOS = ["novo", "em_andamento", "em_teste", "aguardando_cliente", "aprovado", "publicado", "escalado", "cancelado"];

app.get("/time/alteracoes", (req, res) => {
  if (!chaveDoTimeOk(req)) return res.status(401).json({ erro: "Chave do time inválida." });
  if (!memoria) return res.status(503).json({ erro: "Motor ainda iniciando." });
  const filtro = req.query.status ? String(req.query.status).split(",") : null;
  const lista = Object.entries(memoria.dados.alteracoes)
    .filter(([, a]) => !filtro || filtro.includes(a.status))
    .map(([id, a]) => ({ id, ...a, jid: undefined }))
    .sort((x, y) => x.criadoEm - y.criadoEm);
  res.json({ alteracoes: lista, whatsapp: statusConexao });
});

// Cadastro de clientes de sistema pelo time (o mesmo que o comando #cliente).
app.get("/time/clientes", (req, res) => {
  if (!chaveDoTimeOk(req)) return res.status(401).json({ erro: "Chave do time inválida." });
  if (!memoria) return res.status(503).json({ erro: "Motor ainda iniciando." });
  res.json({ clientes: memoria.dados.sistemas });
});
app.post("/time/clientes", (req, res) => {
  if (!chaveDoTimeOk(req)) return res.status(401).json({ erro: "Chave do time inválida." });
  if (!memoria) return res.status(503).json({ erro: "Motor ainda iniciando." });
  const { numero, cliente, sistema, obs, remover } = req.body || {};
  let n = String(numero || "").replace(/\D/g, "");
  if (n.length >= 10 && n.length <= 11) n = "55" + n;
  if (n.length < 12) return res.status(400).json({ erro: "Número inválido (use DDD + número)." });
  for (const x of Object.keys(memoria.dados.sistemas)) if (ultimos8(x) === ultimos8(n) && x !== n) delete memoria.dados.sistemas[x];
  if (remover) delete memoria.dados.sistemas[n];
  else {
    if (!cliente || !sistema) return res.status(400).json({ erro: "Informe cliente e sistema." });
    memoria.dados.sistemas[n] = { cliente: String(cliente), sistema: String(sistema), ...(obs ? { obs: String(obs) } : {}) };
  }
  memoria.salvar("sistemas");
  res.json({ ok: true, clientes: memoria.dados.sistemas });
});

app.post("/time/alteracoes/:id", async (req, res) => {
  if (!chaveDoTimeOk(req)) return res.status(401).json({ erro: "Chave do time inválida." });
  if (!memoria) return res.status(503).json({ erro: "Motor ainda iniciando." });
  const id = req.params.id;
  const a = memoria.dados.alteracoes[id];
  if (!a) return res.status(404).json({ erro: "Pedido não encontrado." });
  const { status, linkTeste, nota, mensagemCliente, escalarKeller } = req.body || {};
  if (status && !STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: `Status inválido. Use: ${STATUS_VALIDOS.join(", ")}` });
  if ((mensagemCliente || escalarKeller) && (statusConexao !== "conectado" || !sock))
    return res.status(503).json({ erro: "WhatsApp não está conectado agora; tente de novo depois." });

  const agora = Date.now();
  try {
    if (mensagemCliente) {
      await enviar(a.jid, { text: String(mensagemCliente) });
      atendente?.anotarFalaDoTime(a.jid, String(mensagemCliente));
      a.historico.push({ em: agora, de: "time→cliente", texto: String(mensagemCliente) });
    }
    if (escalarKeller) {
      await criarPendencia(a.jid, a.nome, `[Pedido ${id} — ${a.cliente} / ${a.sistema}] ${escalarKeller}`, id);
      a.historico.push({ em: agora, de: "time→keller", texto: String(escalarKeller) });
    }
    if (nota) a.historico.push({ em: agora, de: "time", texto: String(nota) });
    if (linkTeste !== undefined) a.linkTeste = String(linkTeste);
    if (status) a.status = status;
    else if (escalarKeller) a.status = "escalado";
    a.historico = a.historico.slice(-40);
    a.atualizadoEm = agora;
    memoria.salvar("alteracoes");
    res.json({ ok: true, id, status: a.status });
  } catch (erro) {
    console.error("Erro ao atualizar pedido de alteração:", erro);
    res.status(500).json({ erro: "Falha ao atualizar o pedido.", detalhe: erro.message });
  }
});

app.get("/agenda", async (req, res) => {
  try {
    const numeroEmpresa = digitos(sock?.user?.id);
    const todos = await fsdb.listarColecao("agendamentos");
    const meus = todos
      .filter((a) => a.empresaNumero === numeroEmpresa)
      .sort((a, b) => `${a.data}${a.hora}`.localeCompare(`${b.data}${b.hora}`));
    const hoje = new Date().toISOString().slice(0, 10);
    const linhas = meus
      .map((a) => `<tr style="${a.data < hoje ? "opacity:.45" : ""}"><td>${a.data || "-"}</td><td>${a.hora || "-"}</td><td>${a.cliente || "-"}</td><td>${a.servico || "-"}</td><td><a href="https://wa.me/${a.clienteNumero}" target="_blank">abrir chat</a></td></tr>`)
      .join("");
    res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:sans-serif;max-width:720px;margin:30px auto;padding:0 16px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #e3e3e3}</style></head>
      <body><a href="/">← voltar</a><h1>📅 Agenda</h1>
      ${meus.length ? `<table><tr><th>Data</th><th>Hora</th><th>Cliente</th><th>Serviço</th><th></th></tr>${linhas}</table>` : "<p>Nenhum horário marcado ainda.</p>"}
      </body></html>`);
  } catch (erro) {
    console.error("Erro ao carregar agenda:", erro);
    res.status(500).send("Não consegui carregar a agenda agora.");
  }
});

// Ponto Eletrônico: comprovante de cada batida no WhatsApp do colaborador e do gestor.
registrarPonto(app, { enviar, paraJid, estaConectado: () => statusConexao === "conectado" && !!sock });

// O Painel de Leads chama este endpoint pra mandar mensagem automaticamente.
app.post("/enviar", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ erro: "Chave de API inválida." });
  if (statusConexao !== "conectado" || !sock) return res.status(503).json({ erro: "WhatsApp ainda não está conectado." });
  const { numero, mensagem } = req.body || {};
  if (!numero || !mensagem) return res.status(400).json({ erro: "Informe 'numero' e 'mensagem'." });
  try {
    await enviar(paraJid(numero), { text: mensagem });
    res.json({ sucesso: true });
  } catch (erro) {
    console.error("Erro ao enviar mensagem via /enviar:", erro);
    res.status(500).json({ erro: "Falha ao enviar mensagem.", detalhe: erro.message });
  }
});

// Manda mensagem pros leads novos do Painel, com limite diário.
app.post("/auto-enviar", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ erro: "Chave de API inválida." });
  if (statusConexao !== "conectado" || !sock) return res.status(503).json({ erro: "WhatsApp ainda não está conectado." });
  try {
    const hoje = hojeData();
    const contador = await fsdb.getDoc("config/envioAutomatico");
    let enviadosHoje = contador && contador.data === hoje ? contador.enviadosHoje || 0 : 0;
    if (enviadosHoje >= LIMITE_ENVIOS_POR_DIA) {
      return res.json({ enviados: 0, motivo: "Limite diário já atingido", enviadosHoje, limite: LIMITE_ENVIOS_POR_DIA });
    }
    const empresaConfig = (await fsdb.getDoc("config/empresa")) || {};
    const leads = await fsdb.listarColecao("leads");
    const elegiveis = leads.filter((l) => (l.status || "Novo") === "Novo" && l.whatsapp);
    const quantos = Math.min(ENVIOS_POR_EXECUCAO, LIMITE_ENVIOS_POR_DIA - enviadosHoje, elegiveis.length);
    const feitos = [];
    for (let i = 0; i < quantos; i++) {
      const lead = elegiveis[i];
      try {
        await enviar(paraJid(lead.whatsapp), { text: mensagemPadrao(lead, empresaConfig) });
        await fsdb.setCampos(`leads/${lead.id}`, { status: "Contatado" });
        enviadosHoje++;
        feitos.push(lead.empresa || lead.id);
        await fsdb.setCampos("config/envioAutomatico", { data: hoje, enviadosHoje });
        if (i < quantos - 1) await espera(8000);
      } catch (erro) {
        console.error(`Erro ao enviar automático pro lead ${lead.id}:`, erro);
      }
    }
    res.json({ enviados: feitos.length, para: feitos, enviadosHoje, limite: LIMITE_ENVIOS_POR_DIA });
  } catch (erro) {
    console.error("Erro no envio automático:", erro);
    res.status(500).json({ erro: "Falha no envio automático.", detalhe: erro.message });
  }
});

// ---------- Partida ----------
async function principal() {
  memoria = await carregarMemoria(cofre);
  const empresa = carregarEmpresa();
  if (groq && empresa) atendente = criarAtendente({ groq, empresa, memoria, cofre, fsdb });
  app.listen(PORT, () => console.log(`Servidor HTTP ouvindo na porta ${PORT}`));
  await iniciar();

  // Mantém o serviço acordado no plano grátis do Render.
  const urlPublica = process.env.RENDER_EXTERNAL_URL;
  if (urlPublica) {
    setInterval(() => fetch(`${urlPublica}/status`).catch(() => {}), 10 * 60 * 1000);
    console.log(`⏰ Me chamando a cada 10 minutos em ${urlPublica} pra não dormir.`);
  }
}

async function desligar() {
  try {
    await sessao?.gravar();
  } catch {}
  process.exit(0);
}
if (require.main === module) {
  process.on("SIGTERM", desligar);
  process.on("SIGINT", desligar);
  principal().catch((err) => console.error("Erro ao iniciar:", err));
}

// Usado só pelos testes.
module.exports = {
  _teste: {
    preparar: (o) => {
      sock = o.sock;
      memoria = o.memoria;
      atendente = o.atendente;
    },
    tratarMensagem,
    filaCliente,
  },
};
