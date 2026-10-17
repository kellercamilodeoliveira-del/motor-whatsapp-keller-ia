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

function dataHojeExtenso() {
  const agora = new Date();
  const formatado = agora.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  return formatado;
}

const TEM_AGENDA = (empresa) => !!(empresa && empresa.usa_agenda !== false);

function montarPrompt(empresa) {
  let prompt = `Você é a secretária virtual de "${empresa.nome_empresa}", um(a) ${empresa.segmento}.

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

  if (TEM_AGENDA(empresa)) {
    prompt += `
HOJE É: ${dataHojeExtenso()} (use isso pra calcular datas como "amanhã" ou "sexta-feira").

AGENDAMENTO AUTOMÁTICO:
Quando o cliente confirmar um horário com você (ele aceitou um dia, hora e serviço específicos),
você deve ANOTAR esse agendamento automaticamente. Pra isso, no FINAL da sua mensagem de confirmação
pro cliente, inclua uma linha extra, exatamente neste formato (o cliente nunca vê essa linha, ela é
removida antes de enviar):
[AGENDAMENTO]{"servico":"nome do serviço","data":"AAAA-MM-DD","hora":"HH:MM","cliente":"nome do cliente se ele disse, senão 'Cliente'"}[/AGENDAMENTO]
Só inclua essa linha quando o horário estiver REALMENTE confirmado (dia, hora e serviço definidos),
nunca enquanto ainda estiver negociando ou sugerindo horários.
`;
  }

  return prompt;
}

function extrairAgendamento(texto) {
  const match = texto.match(/\[AGENDAMENTO\]([\s\S]*?)\[\/AGENDAMENTO\]/);
  if (!match) return { textoLimpo: texto.trim(), agendamento: null };
  const textoLimpo = texto.replace(match[0], "").trim();
  try {
    const dados = JSON.parse(match[1]);
    return { textoLimpo, agendamento: dados };
  } catch {
    return { textoLimpo, agendamento: null };
  }
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
    max_tokens: 350,
  });

  const bruto = resposta.choices[0]?.message?.content?.trim()
    || "Desculpa, deu um probleminha aqui. Já já alguém da equipe te responde!";

  const { textoLimpo, agendamento } = extrairAgendamento(bruto);

  const novoHistorico = [
    ...historicoConversa,
    { role: "user", content: textoRecebido },
    { role: "assistant", content: textoLimpo },
  ].slice(-HISTORICO_MAX_MENSAGENS);
  historico.set(numeroConversa, novoHistorico);

  return { texto: textoLimpo, agendamento };
}

// Transforma "5514988324456" ou "14988324456" no formato que o Baileys espera (JID).
function paraJid(numero) {
  let digitos = String(numero).replace(/\D/g, "");
  if (digitos.length <= 11) digitos = "55" + digitos; // assume Brasil se vier sem DDI
  return `${digitos}@s.whatsapp.net`;
}

// ---------- Envio automático diário dos leads do Painel (Firestore) ----------
// Usa a API REST do Firestore direto (as regras do banco já permitem leitura/escrita
// pública nessas coleções, então não precisa de credencial de servidor).
const FIRESTORE_PROJECT = "escritorio-c3acb";
const FIRESTORE_API_KEY = "AIzaSyBZyZ4Dqs0BI5VSsm3HB2TNGpk7Z7330CE";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;
const LIMITE_ENVIOS_POR_DIA = 20;
const ENVIOS_POR_EXECUCAO = 2; // quantos leads tenta mandar a cada vez que o /auto-enviar roda

function fsValorParaJs(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return fsCamposParaJs(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsValorParaJs);
  return null;
}
function fsCamposParaJs(fields) {
  const obj = {};
  for (const k in fields) obj[k] = fsValorParaJs(fields[k]);
  return obj;
}
function jsParaFsValor(v) {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  return { nullValue: null };
}

async function firestoreGetDoc(caminho) {
  const resp = await fetch(`${FIRESTORE_BASE}/${caminho}?key=${FIRESTORE_API_KEY}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Firestore GET ${caminho} falhou: ${resp.status}`);
  const data = await resp.json();
  return fsCamposParaJs(data.fields || {});
}

async function firestoreListarColecao(nome) {
  const resp = await fetch(`${FIRESTORE_BASE}/${nome}?pageSize=300&key=${FIRESTORE_API_KEY}`);
  if (!resp.ok) throw new Error(`Firestore LIST ${nome} falhou: ${resp.status}`);
  const data = await resp.json();
  return (data.documents || []).map((doc) => {
    const id = doc.name.split("/").pop();
    return { id, ...fsCamposParaJs(doc.fields || {}) };
  });
}

async function firestoreSetCampos(caminho, campos) {
  const mask = Object.keys(campos).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const fields = {};
  for (const k in campos) fields[k] = jsParaFsValor(campos[k]);
  const resp = await fetch(`${FIRESTORE_BASE}/${caminho}?${mask}&key=${FIRESTORE_API_KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Firestore PATCH ${caminho} falhou: ${resp.status}`);
}

async function firestoreCriarDoc(colecao, campos) {
  const fields = {};
  for (const k in campos) fields[k] = jsParaFsValor(campos[k]);
  const resp = await fetch(`${FIRESTORE_BASE}/${colecao}?key=${FIRESTORE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Firestore POST ${colecao} falhou: ${resp.status}`);
}

// Mesma lógica de mensagem padrão usada no Painel de Leads (netlify-site/index.html).
const ABERTURAS = [
  "Oi! Tudo bem? Me chamo Keller",
  "Olá! Aqui é o Keller",
  "Oi, bom dia! Me chamo Keller",
  "Olá! Tudo certo? Aqui é o Keller",
];
const FECHOS = [
  "Posso te mostrar rapidinho como funciona?",
  "Topa dar uma olhada?",
  "Faz sentido pra vocês? Posso te explicar melhor.",
  "Quer que eu te mande mais detalhes?",
];
function hashIndex(str, mod) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % mod;
}
function mensagemPadrao(lead, empresaConfig) {
  const empresaLead = lead.empresa || "tudo bem";
  const seed = String(lead.id || empresaLead || "");
  const abertura = ABERTURAS[hashIndex(seed, ABERTURAS.length)];
  const fecho = FECHOS[hashIndex(seed + "x", FECHOS.length)];
  let msg = "";
  if (empresaConfig && empresaConfig.nome) {
    msg += `${abertura}, da ${empresaConfig.nome}. `;
    if (empresaConfig.nicho) {
      msg += `Vi o ${empresaLead} aqui${lead.cidade ? " em " + lead.cidade : ""} e trabalho com ${empresaConfig.nicho}. `;
    } else {
      msg += `Vi o ${empresaLead} aqui. `;
    }
    if (empresaConfig.promocao) {
      msg += `Essa semana estamos com uma condição especial: ${empresaConfig.promocao}. `;
    }
    msg += fecho;
    return msg;
  }
  const segmento = (lead.segmento || "").toLowerCase();
  msg += `${abertura}, da Keller IA. `;
  if (segmento) {
    msg += `Vi o ${empresaLead} aqui e ajudo negócios de ${segmento} a responder clientes no WhatsApp automaticamente, com atendimento de IA 24h, sem perder nenhuma mensagem. `;
  } else {
    msg += `Vi o ${empresaLead} aqui e ajudo empresas a terem um atendimento automático de IA no WhatsApp, respondendo clientes 24h. `;
  }
  msg += fecho;
  return msg;
}

function hojeData() {
  // Data no formato AAAA-MM-DD, fuso de São Paulo (UTC-3), só pra controlar o limite diário.
  const agora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return agora.toISOString().slice(0, 10);
}

async function iniciar() {
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
    if (type !== "notify" || !groq) return; // sem IA configurada, não responde sozinho

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
        const { texto: respostaTexto, agendamento } = await responderComIA(empresa, numeroRemetente, texto);
        await sock.sendMessage(numeroRemetente, { text: respostaTexto });
        console.log(`📤 Respondido automaticamente: ${respostaTexto}`);

        if (agendamento) {
          try {
            await firestoreCriarDoc("agendamentos", {
              empresaNumero: numeroEmpresa,
              clienteNumero: String(numeroRemetente).split("@")[0],
              cliente: agendamento.cliente || "Cliente",
              servico: agendamento.servico || "",
              data: agendamento.data || "",
              hora: agendamento.hora || "",
              status: "confirmado",
              criadoEm: new Date().toISOString(),
            });
            console.log(`🗓️  Agendamento salvo: ${agendamento.servico} em ${agendamento.data} ${agendamento.hora}`);
          } catch (erroAgenda) {
            console.error("Erro ao salvar agendamento:", erroAgenda);
          }
        }
      } catch (erro) {
        console.error("Erro ao responder automaticamente:", erro);
      }
    }
  });
}

// ---------- Servidor HTTP ----------
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  if (statusConexao === "conectado") {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>✅ Motor WhatsApp Keller IA conectado</h1>
        <p>Pronto pra enviar mensagens automaticamente.</p>
        <p><a href="/agenda" style="color:#1a7a3c;font-weight:600">📅 Ver agenda de horários marcados</a></p>
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

// Página simples com os horários que a IA marcou sozinha, conversando no WhatsApp.
app.get("/agenda", async (req, res) => {
  try {
    const numeroEmpresa = sock?.user?.id?.split(":")[0] || "";
    const todos = await firestoreListarColecao("agendamentos");
    const meus = todos
      .filter((a) => a.empresaNumero === numeroEmpresa)
      .sort((a, b) => `${a.data}${a.hora}`.localeCompare(`${b.data}${b.hora}`));

    const hoje = new Date().toISOString().slice(0, 10);
    const linhas = meus.map((a) => {
      const passou = a.data < hoje;
      return `<tr style="${passou ? "opacity:.45" : ""}">
        <td>${a.data || "-"}</td>
        <td>${a.hora || "-"}</td>
        <td>${a.cliente || "-"}</td>
        <td>${a.servico || "-"}</td>
        <td><a href="https://wa.me/${a.clienteNumero}" target="_blank" style="color:#1a7a3c">abrir chat</a></td>
      </tr>`;
    }).join("");

    res.send(`
      <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{font-family:sans-serif;max-width:720px;margin:30px auto;padding:0 16px;color:#222}
        table{width:100%;border-collapse:collapse;margin-top:16px}
        th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e3e3e3;font-size:.92rem}
        th{color:#666;font-weight:600;font-size:.8rem;text-transform:uppercase}
        a.voltar{color:#666;text-decoration:none;font-size:.9rem}
      </style></head>
      <body>
        <a class="voltar" href="/">← voltar</a>
        <h1>📅 Agenda</h1>
        <p style="color:#666">Horários marcados automaticamente pela IA nas conversas do WhatsApp. Os já passados aparecem apagados.</p>
        ${meus.length === 0
          ? '<p style="color:#888">Nenhum horário marcado ainda.</p>'
          : `<table><tr><th>Data</th><th>Hora</th><th>Cliente</th><th>Serviço</th><th></th></tr>${linhas}</table>`}
      </body></html>
    `);
  } catch (erro) {
    console.error("Erro ao carregar agenda:", erro);
    res.status(500).send("Não consegui carregar a agenda agora. Tenta de novo em instantes.");
  }
});

// O Painel de Leads chama este endpoint pra mandar mensagem automaticamente.
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

// Roda sozinho (chamado por um agendamento) e manda mensagem pros leads novos do
// Painel, respeitando um limite diário pra não arriscar o número ser bloqueado.
app.post("/auto-enviar", async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ erro: "Chave de API inválida." });
  }
  if (statusConexao !== "conectado" || !sock) {
    return res.status(503).json({ erro: "WhatsApp ainda não está conectado." });
  }

  try {
    const hoje = hojeData();
    let contador = await firestoreGetDoc("config/envioAutomatico");
    let enviadosHoje = contador && contador.data === hoje ? (contador.enviadosHoje || 0) : 0;

    if (enviadosHoje >= LIMITE_ENVIOS_POR_DIA) {
      return res.json({ enviados: 0, motivo: "Limite diário já atingido", enviadosHoje, limite: LIMITE_ENVIOS_POR_DIA });
    }

    const empresaConfig = (await firestoreGetDoc("config/empresa")) || {};
    const leads = await firestoreListarColecao("leads");
    const elegiveis = leads.filter((l) => (l.status || "Novo") === "Novo" && l.whatsapp);

    const quantos = Math.min(ENVIOS_POR_EXECUCAO, LIMITE_ENVIOS_POR_DIA - enviadosHoje, elegiveis.length);
    const enviadosNestaExecucao = [];

    for (let i = 0; i < quantos; i++) {
      const lead = elegiveis[i];
      const mensagem = mensagemPadrao(lead, empresaConfig);
      try {
        await sock.sendMessage(paraJid(lead.whatsapp), { text: mensagem });
        await firestoreSetCampos(`leads/${lead.id}`, { status: "Contatado" });
        enviadosHoje++;
        enviadosNestaExecucao.push(lead.empresa || lead.id);
        await firestoreSetCampos("config/envioAutomatico", { data: hoje, enviadosHoje });
        if (i < quantos - 1) await new Promise((r) => setTimeout(r, 8000)); // pequena pausa entre envios
      } catch (erro) {
        console.error(`Erro ao enviar automático pro lead ${lead.id}:`, erro);
      }
    }

    res.json({ enviados: enviadosNestaExecucao.length, para: enviadosNestaExecucao, enviadosHoje, limite: LIMITE_ENVIOS_POR_DIA });
  } catch (erro) {
    console.error("Erro no envio automático:", erro);
    res.status(500).json({ erro: "Falha no envio automático.", detalhe: erro.message });
  }
});

app.listen(PORT, () => console.log(`Servidor HTTP ouvindo na porta ${PORT}`));

iniciar().catch((err) => console.error("Erro ao iniciar conexão com o WhatsApp:", err));
