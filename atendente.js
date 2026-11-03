/**
 * O "cérebro" do atendente: monta as instruções, conversa com a IA (Groq),
 * transcreve áudio e decide quando chamar o Keller.
 */

const MODELOS = [
  process.env.GROQ_MODELO,
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "llama-3.1-8b-instant",
].filter(Boolean);
const MODELOS_AUDIO = ["whisper-large-v3-turbo", "whisper-large-v3"];
const HISTORICO_MAX = 16;

function dataHoje() {
  return new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function montarInstrucoes(empresa, conhecimento) {
  const servicos = (empresa.servicos || [])
    .map((s) => `- ${s.nome}${s.descricao ? `: ${s.descricao}` : ""}${s.preco ? ` (valor: ${s.preco})` : ""}`)
    .join("\n");
  const aprendido = conhecimento.length
    ? conhecimento.map((c) => `- Pergunta: ${c.p}\n  Resposta do Keller: ${c.r}`).join("\n")
    : "(ainda nada)";

  return `Você é a assistente virtual da ${empresa.nome_empresa}, respondendo pelo WhatsApp do Keller, o dono.
${empresa.segmento ? `O que a empresa faz: ${empresa.segmento}` : ""}

AGORA: ${dataHoje()} (horário de Brasília).

COMO CONVERSAR
- Mensagens curtas, como no WhatsApp de verdade: 1 a 4 frases, tom próximo, educado e confiante. No máximo 1 emoji, e só quando combinar.
- Responda no idioma em que o cliente escreveu (português, inglês, espanhol...).
- No primeiro contato, apresente-se como a assistente virtual do Keller, da ${empresa.nome_empresa}. Se perguntarem se é robô ou IA, diga a verdade: sim, é um atendimento com IA, e é exatamente esse tipo de sistema que a ${empresa.nome_empresa} cria para outras empresas.
- Faça perguntas para entender o negócio do cliente e a dor dele (ramo, cidade, quantos funcionários, como faz hoje).
- Nunca invente preço, prazo, desconto, funcionalidade, cliente atendido, resultado ou compromisso. Use SÓ os dados abaixo e o que o Keller já ensinou.

DADOS DA EMPRESA
- Onde atende: ${empresa.endereco}
- Horário do Keller: ${empresa.horario_funcionamento}
- Contato: ${empresa.contato || ""}
- Como funciona o próximo passo: ${empresa.forma_agendamento}
- Serviços:
${servicos}
${empresa.observacoes ? `- Observações: ${empresa.observacoes}` : ""}

O QUE O KELLER JÁ ENSINOU (vale como verdade; use sempre que servir)
${aprendido}

QUANDO CHAMAR O KELLER
${empresa.quando_chamar_humano}
Também chame quando não tiver certeza da resposta, quando a pergunta não estiver coberta acima, ou quando o cliente quiser marcar uma conversa, reunião, visita ou demonstração (você não marca horário sozinha: diga que o Keller vai confirmar o melhor horário).
Para chamar: responda ao cliente algo como "Boa pergunta! Vou confirmar com o Keller e já te retorno por aqui." e, NO FINAL da sua mensagem, numa linha separada, escreva exatamente:
[CHAMAR_KELLER]{"pergunta":"o que o cliente quer saber, em uma frase clara, com o contexto necessário"}[/CHAMAR_KELLER]
O cliente nunca vê essa linha.

MENSAGEM PESSOAL
O WhatsApp também é o pessoal do Keller. Se a mensagem for claramente pessoal (família, amigos, igreja, futebol, assunto que não é negócio), não responda nada: escreva somente [SILENCIO].`;
}

function extrairMarcas(bruto) {
  let texto = bruto || "";
  if (/\[SILENCIO\]/i.test(texto)) return { silencio: true, texto: "", chamar: null };
  let chamar = null;
  const m = texto.match(/\[CHAMAR_KELLER\]([\s\S]*?)\[\/CHAMAR_KELLER\]/i);
  if (m) {
    texto = texto.replace(m[0], "");
    try {
      chamar = JSON.parse(m[1]);
    } catch {
      chamar = { pergunta: m[1].trim() };
    }
  } else if (/\[CHAMAR_KELLER\]/i.test(texto)) {
    // Marca aberta sem fechamento.
    const partes = texto.split(/\[CHAMAR_KELLER\]/i);
    texto = partes[0];
    try {
      chamar = JSON.parse(partes[1]);
    } catch {
      chamar = { pergunta: (partes[1] || "").trim() || "Dúvida do cliente (ver conversa)" };
    }
  }
  texto = texto.replace(/\[\/?[A-Z_]+\]/g, "").trim();
  return { silencio: false, texto, chamar };
}

function criarAtendente({ groq, empresa, memoria }) {
  const historico = new Map(); // jid -> [{role, content}]

  async function chat(mensagens, opcoes = {}) {
    let ultimoErro;
    for (const modelo of MODELOS) {
      try {
        const r = await groq.chat.completions.create({
          model: modelo,
          messages: mensagens,
          temperature: opcoes.temperatura ?? 0.4,
          max_tokens: opcoes.maxTokens ?? 500,
        });
        const t = r.choices?.[0]?.message?.content;
        if (t) return t.trim();
      } catch (erro) {
        ultimoErro = erro;
        const msg = String(erro?.message || "");
        const modeloInvalido = erro?.status === 404 || /model|decommission|not found|does not exist/i.test(msg);
        if (!modeloInvalido) throw erro;
        console.error(`Modelo ${modelo} indisponível, tentando o próximo.`);
      }
    }
    throw ultimoErro || new Error("Nenhum modelo de IA respondeu.");
  }

  function lembrar(jid, role, content) {
    const h = historico.get(jid) || [];
    h.push({ role, content });
    historico.set(jid, h.slice(-HISTORICO_MAX));
  }

  async function responder(jid, nome, texto) {
    const h = historico.get(jid) || [];
    const quem = nome ? `[Cliente: ${nome}] ` : "";
    const mensagens = [
      { role: "system", content: montarInstrucoes(empresa, memoria.dados.conhecimento) },
      ...h,
      { role: "user", content: quem + texto },
    ];
    const bruto = await chat(mensagens);
    const r = extrairMarcas(bruto);
    lembrar(jid, "user", quem + texto);
    if (!r.silencio && r.texto) lembrar(jid, "assistant", r.texto);
    return r;
  }

  // Transforma a resposta curta do Keller numa mensagem bonita pro cliente,
  // sem mudar nenhuma informação.
  async function redigirResposta(jid, pergunta, respostaKeller) {
    const h = historico.get(jid) || [];
    const contexto = h.slice(-6).map((m) => `${m.role === "user" ? "Cliente" : "Assistente"}: ${m.content}`).join("\n");
    const texto = await chat(
      [
        {
          role: "system",
          content:
            "Você é a assistente virtual da Keller IA no WhatsApp. O Keller respondeu uma dúvida do cliente. Escreva a mensagem para o cliente passando EXATAMENTE a informação do Keller, sem acrescentar nem mudar nada (valores, prazos e condições iguais). Curta, natural, no idioma da conversa, começando com algo como \"Falei com o Keller:\". Não use marcações.",
        },
        {
          role: "user",
          content: `Conversa recente:\n${contexto || "(sem histórico)"}\n\nDúvida do cliente: ${pergunta}\n\nResposta do Keller: ${respostaKeller}`,
        },
      ],
      { temperatura: 0.2, maxTokens: 300 }
    );
    const limpo = texto.replace(/\[\/?[A-Z_]+\]/g, "").trim();
    lembrar(jid, "assistant", limpo);
    return limpo;
  }

  function anotarFalaDoKeller(jid, texto) {
    lembrar(jid, "assistant", `(Keller respondeu pessoalmente) ${texto}`);
  }

  async function transcrever(buffer) {
    const { toFile } = require("groq-sdk");
    let ultimoErro;
    for (const modelo of MODELOS_AUDIO) {
      try {
        const arquivo = await toFile(buffer, "audio.ogg", { type: "audio/ogg" });
        const r = await groq.audio.transcriptions.create({ file: arquivo, model: modelo });
        if (r?.text) return r.text.trim();
      } catch (erro) {
        ultimoErro = erro;
      }
    }
    throw ultimoErro || new Error("Não consegui transcrever o áudio.");
  }

  return { responder, redigirResposta, anotarFalaDoKeller, transcrever };
}

module.exports = { criarAtendente, extrairMarcas };
