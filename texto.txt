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

const historico = new Map();
const HISTORICO_MAX_MENSAGENS = 10;

function carregarEmpresa(numeroCliente) {
  const arquivo = path.join(EMPRESAS_DIR, `${numeroCliente}.json`);
  if (fs.existsSync(arquivo)) {
    return JSON.parse(fs.readFileSync(arquivo, "utf-8"));
  }
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

  const usarCodigoDePareamento = !!process.env.PHONE_NUMBER;

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  if (usarCodigoDePareamento && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const codigo = await sock.requestPairingCode(process.env.PHONE_NUMBER);
        console.log("\n📱 CÓDIGO DE PAREAMENTO:", codigo);
        console.log("No WhatsApp: Configurações → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone, e digite esse código.\n");
      } catch (erro) {
        console.error("Erro ao gerar código de pareamento:", erro);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usarCodigoDePareamento) {
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

      const numeroRemetente = msg.key.remoteJid;
      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!texto) continue;

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

const app = express();
app.get("/", (req, res) => res.send("Motor WhatsApp Keller IA está rodando ✅"));
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor HTTP ouvindo na porta ${PORT}`);
  iniciar().catch((err) => console.error("Erro ao iniciar:", err));
});
