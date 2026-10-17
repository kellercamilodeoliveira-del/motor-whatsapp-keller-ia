/**
 * Motor de WhatsApp — Keller IA
 *
 * O que isso faz:
 *  - Conecta num número de WhatsApp (o SEU número, escaneando um QR Code na página inicial)
 *  - Expõe um endpoint POST /enviar que o Painel de Leads chama pra mandar mensagem
 *    automaticamente pro cliente, sem precisar abrir o WhatsApp manualmente
 *  - (Opcional) Se a variável GROQ_API_KEY estiver configurada, também responde
 *    sozinho quem mandar mensagem, usando os dados da empresa em /empresas
 *
 * Importante: usa a biblioteca Baileys, que fala com o WhatsApp de forma NÃO oficial
 * (não é a API paga do Meta). É de graça, mas carrega algum risco de o número ser
 * sinalizado se o volume de mensagens ficar muito alto ou repetitivo.
 *
 * ATENÇÃO SOBRE O PLANO GRATUITO DO RENDER:
 * O disco é apagado toda vez que o serviço reinicia (o que acontece depois de um
 * tempo sem uso, ou a cada novo deploy). Isso significa que a sessão do WhatsApp
 * (o "login") pode precisar ser refeita de vez em quando — vai aparecer um novo QR
 * code na página inicial quando isso acontecer. Se isso incomodar, o plano pago do
 * Render com disco persistente resolve de vez (fica sempre conectado).
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
} = require("@whiskeysockets/baileys");

const EMPRESAS_DIR = path.join(__dirname, "empresas");
const AUTH_DIR = path.join(__dirname, "auth_info");
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ""; // chave que o painel de leads usa pra autenticar o envio

// IA opcional de auto-resposta — só ativa se a chave estiver configurada.
let groq = null;
if (process.env.GROQ_API_KEY) {
  try {
    const Groq = require("groq-sdk");
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log("🤖 Auto-resposta por IA ativada (GROQ_API_KEY encontrada).");
  } catch (erro) {
    console.error("Não consegui iniciar a IA de auto-resposta (seguindo sem ela):", erro.message);
  }
} else {
  console.log("ℹ️  GROQ_API_KEY não configurada — auto-resposta por IA desativada (só envio manual via /enviar vai funcionar).");
}

// Memória de conversa por número (em RAM — reseta se o processo reiniciar).
const historico = new Map();
const HISTORICO_MAX_MENSAGENS = 10;

let sock = null;
let ultimoQrDataUrl = null;
let statusConexao = "iniciando"; // iniciando | aguardando_qr | conectado | caiu

function carregarEmpresa(numeroCliente) {
  const arquivo = path.join(EMPRESAS_DIR, `${numeroCliente}.json`);
  if (fs.existsSync(arquivo)) {
    return JSON.parse(fs.readFileSync(arquivo, "utf-8"));
  }
  const exemplo = path.join(EMPRESAS_DIR, "exemplo.json");
  if (fs.existsSync(exemplo)) {
    return JSON.parse(fs.readFileSync(exemplo, "utf-8"));
  }
  return null;
}

function montarPrompt(empresa) {
  return `Você é a secretária virtual de "${empresa.nome_empresa}", um(a) ${empresa.segmento}.

REGRAS IMPORTANTES:
- Responda SOMENTE com base nas informações abaixo. NUNCA invente preço, horário, serviço ou qualquer dado que não esteja aqui.
- Se perguntarem algo que você não tem informação pra responder, diga educadamente que vai confirmar com a equipe e que alguém vai retornar.
- Seja breve, simpática e direta — mensagens curtas, como se estivesse no WhatsApp de verdade.
- Nunca se apresente como "inteligência artificial" a menos que perguntem diretamente; aí seja honesta.

DADOS DA EMPRESA:
- Endereço: ${empresa.endereco}
- Horário de funcionamento: ${empresa.horario_funcionamento}
- Serviços e preços: ${(empresa.servicos || []).map(s => `${s.nome} (${s.preco})`).join(", ")}
- Como agendar: ${empresa.forma_agendamento}
- Quando chamar um humano: ${empresa.quando_chamar_humano}
`;
}

async function responderComIA(empresa, numeroConversa, textoRecebido) {
  const historicoConversa = historico.get(numeroConversa) || [];
  const mensagens = [
    { role: "system", content: montarPrompt(empresa) },
    ...historicoConversa,
    { role: "user", content: textoRecebido },
  ];

  const resposta = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: mensagens,
    temperature: 0.4,
    max_tokens: 300,
  });

  const textoResposta = resposta.choices[0]?.message?.content?.trim()
    || "Desculpa, deu um probleminha aqui. Já já alguém da equipe te responde!";

  const novoHistorico = [
    ...historicoConversa,
    { role: "user", content: textoRecebido },
    { role: "assistant", content: textoResposta },
  ].slice(-HISTORICO_MAX_MENSAGENS);
  historico.set(numeroConversa, novoHistorico);

  return textoResposta;
}

// Transforma "5514988324456" ou "14988324456" no formato que o Baileys espera (JID).
function paraJid(numero) {
  let digitos = String(numero).replace(/\D/g, "");
  if (digitos.length <= 11) digitos = "55" + digitos; // assume Brasil se vier sem DDI
  return `${digitos}@s.whatsapp.net`;
}

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (erro) {
