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
const API_KEY = process.env.API_KEY || "";

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

const historico = new Map();
const HISTORICO_MAX_MENSAGENS = 10;

let sock = null;
let ultimoQrDataUrl = null;
let statusConexao = "iniciando";

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

function paraJid(numero) {
  let digitos = String(numero).replace(/\D/g, "");
  if (digitos.length <= 11) digitos = "55" + digitos;
  return `${digitos}@s.whatsapp.net`;
}async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (erro) {
    console.error("Não consegui checar a versão mais recente do WhatsApp, seguindo com a padrão:", erro.message);
    version = undefined;
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      statusConexao = "aguardando_qr";
      try {
        ultimoQrDataUrl = await QRCode.toDataURL(qr);
        console.log("📱 Novo QR code gerado — abre a página inicial do serviço pra escanear.");
      } catch (erro) {
        console.error("Erro ao gerar imagem do QR code:", erro);
      }
    }

    if (connection === "close") {
      statusConexao = "caiu";
      const deveReconectar =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Conexão com o WhatsApp caiu. Reconectar automaticamente?", deveReconectar);
      if (deveReconectar) {
        setTimeout(() => iniciar().catch((e) => console.error("Erro ao reconectar:", e)), 2000);
      }
    } else if (connection === "open") {
      statusConexao = "conectado";
      ultimoQrDataUrl = null;
      console.log("✅ Conectado ao WhatsApp!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" || !groq) return;

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
      if (!empresa) continue;

      console.log(`📩 Mensagem de ${numeroRemetente}: ${texto}`);
      try {
        const resposta = await responderComIA(empresa, numeroRemetente, texto);
        await sock.sendMessage(numeroRemetente, { text: resposta });
        console.log(`📤 Respondido automaticamente: ${resposta}`);
      } catch (erro) {
        console.error("Erro ao responder automaticamente:", erro);
      }
    }
  });
}

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  if (statusConexao === "conectado") {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>✅ Motor WhatsApp Keller IA conectado</h1>
        <p>Pronto pra enviar mensagens automaticamente.</p>
      </body></html>
    `);
  } else if (ultimoQrDataUrl) {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>📱 Escaneie pra conectar seu WhatsApp</h1>
        <p>No celular: WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho</p>
        <img src="${ultimoQrDataUrl}" style="width:300px;height:300px" />
        <p style="color:#888">A página atualiza sozinha a cada 5 segundos.</p>
        <script>setTimeout(() => location.reload(), 5000);</script>
      </body></html>
    `);
  } else {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>⏳ Gerando QR code...</h1>
        <p>Atualiza a página em alguns segundos.</p>
        <script>setTimeout(() => location.reload(), 4000);</script>
      </body></html>
    `);
  }
});

app.get("/status", (req, res) => {
  res.json({ status: statusConexao });
});

app.post("/enviar", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ erro: "Chave de API inválida." });
  }
  if (statusConexao !== "conectado" || !sock) {
    return res.status(503).json({ erro: "WhatsApp ainda não está conectado. Escaneie o QR code na página inicial." });
  }

  const { numero, mensagem } = req.body || {};
  if (!numero || !mensagem) {
    return res.status(400).json({ erro: "Informe 'numero' e 'mensagem' no corpo da requisição." });
  }

  try {
    await sock.sendMessage(paraJid(numero), { text: mensagem });
    res.json({ sucesso: true });
  } catch (erro) {
    console.error("Erro ao enviar mensagem via /enviar:", erro);
    res.status(500).json({ erro: "Falha ao enviar mensagem.", detalhe: erro.message });
  }
});

app.listen(PORT, () => console.log(`Servidor HTTP ouvindo na porta ${PORT}`));

iniciar().catch((err) => console.error("Erro ao iniciar conexão com o WhatsApp:", err));
