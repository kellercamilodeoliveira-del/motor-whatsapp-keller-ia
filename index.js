/**
 * Motor de secretária virtual de IA para WhatsApp — Keller IA
 *
 * O que isso faz:
 *  - Conecta num número de WhatsApp (o SEU número de testes, escaneando um QR Code)
 *  - Quando alguém manda mensagem, busca os dados da empresa cadastrados em /empresas
 *  - Pede pra uma IA (Groq, gratuito) responder usando SÓ esses dados
 *  - Se a IA não souber responder com o que tem, avisa que vai chamar um humano
 *
 * O que isso NÃO faz:
 *  - Não manda mensagem pra ninguém sozinho. Só responde quem já escreveu primeiro.
 *  - Não garante 100% de uptime no plano gratuito (ver README).
 *
 * Importante: usa a biblioteca Baileys, que fala com o WhatsApp de forma NÃO oficial
 * (não é a API paga do Meta). Isso é de graça, mas tecnicamente não é endossado pelo
 * WhatsApp — funciona bem pra testar e validar o produto com poucos clientes, mas
 * carrega algum risco de o número ser sinalizado se o volume de mensagens ficar alto.
 */

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const Groq = require("groq-sdk");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");

const EMPRESAS_DIR = path.join(__dirname, "empresas");
const AUTH_DIR = path.join(__dirname, "auth_info");
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Memória de conversa por número (em RAM — reseta se o processo reiniciar).
// Pra um MVP gratuito está ótimo; se quiser persistência depois, trocar por um banco.
const historico = new Map();
const HISTORICO_MAX_MENSAGENS = 10;

function carregarEmpresa(numeroCliente) {
  // numeroCliente = número de quem está sendo atendido (a empresa dona do WhatsApp)
  const arquivo = path.join(EMPRESAS_DIR, `${numeroCliente}.json`);
  if (fs.existsSync(arquivo)) {
    return JSON.parse(fs.readFileSync(arquivo, "utf-8"));
  }
  // fallback pro exemplo, só pra nunca quebrar em branco
  return JSON.parse(fs.readFileSync(path.join(EMPRESAS_DIR, "exemplo.json"), "utf-8"));
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
- Serviços e preços: ${empresa.servicos.map(s => `${s.nome} (${s.preco})`).join(", ")}
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

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Escaneie este QR Code no WhatsApp (Aparelhos conectados):\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const deveReconectar =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Conexão caiu. Reconectar?", deveReconectar);
      if (deveReconectar) iniciar();
    } else if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const numeroRemetente = msg.key.remoteJid; // quem mandou a mensagem
      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!texto) continue;

      // Número do WhatsApp conectado = número da própria empresa dona do atendimento.
      // Numa versão multi-cliente de verdade, cada empresa roda sua própria instância
      // deste processo (cada uma com seu próprio número e seu próprio arquivo em /empresas).
      const numeroEmpresa = sock.user?.id?.split(":")[0];
      const empresa = carregarEmpresa(numeroEmpresa);

      console.log(`📩 Mensagem de ${numeroRemetente}: ${texto}`);

      try {
        const resposta = await responderComIA(empresa, numeroRemetente, texto);
        await sock.sendMessage(numeroRemetente, { text: resposta });
        console.log(`📤 Respondido: ${resposta}`);
      } catch (erro) {
        console.error("Erro ao responder:", erro);
      }
    }
  });
}

// Servidor HTTP mínimo só pra manter o host (Render/etc) satisfeito e permitir
// um "ping" externo que evita o serviço dormir no plano gratuito.
const app = express();
app.get("/", (req, res) => res.send("Motor WhatsApp Keller IA está rodando ✅"));
app.listen(PORT, () => console.log(`Servidor HTTP ouvindo na porta ${PORT}`));

iniciar().catch((err) => console.error("Erro ao iniciar:", err));
