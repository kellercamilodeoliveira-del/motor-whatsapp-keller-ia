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

function montarInstrucoes(empresa, conhecimento, jaApresentou) {
  const servicos = (empresa.servicos || [])
    .map((s) => `- ${s.nome}${s.descricao ? `: ${s.descricao}` : ""}${s.preco ? ` (valor: ${s.preco})` : ""}`)
    .join("\n");
  const aprendido = conhecimento.length
    ? conhecimento.map((c) => `- Pergunta: ${c.p}\n  Resposta do Keller: ${c.r}`).join("\n")
    : "(ainda nada)";

  const apresentacao = jaApresentou
    ? `- Você JÁ se apresentou pra essa pessoa. NÃO se apresente de novo, não diga "sou a assistente", não diga "Olá, sou...". Só converse normal, como o próprio Keller conversaria.`
    : `- Essa é a sua PRIMEIRA mensagem pra essa pessoa: responda o cumprimento dela e se apresente UMA vez, numa frase curta, como "a assistente de IA do Keller". Ex.: pessoa manda "Bom dia" → "Bom dia! Aqui é a assistente de IA do Keller 😊 Tudo bem com você?". Depois disso, nunca mais se apresente.`;

  return `Você é a assistente pessoal do Keller e responde pelo WhatsApp dele. Ele é dono da ${empresa.nome_empresa}${empresa.segmento ? ` (${empresa.segmento})` : ""}, mas esse WhatsApp é usado pra tudo: clientes, família, amigos, igreja, futebol.

AGORA: ${dataHoje()} (horário de Brasília).

COMO CONVERSAR
${apresentacao}
- Converse como gente, no WhatsApp: mensagens curtas (1 a 3 frases), tom simpático e natural. No máximo 1 emoji, e só quando combinar.
- Converse como uma pessoa normal conversaria com um conhecido: responda o que a pessoa disse e dê continuidade ao assunto DELA (como você tá?, e aí, novidades?, que bom!, entendi...). Sem frases de atendente de telemarketing.
- NÃO fique perguntando "como posso ajudar?", "quer deixar recado pro Keller?" ou "vou avisar o Keller" a cada mensagem. Se a pessoa precisar de algo do Keller, ela vai falar; aí você chama ele (veja abaixo).
- Exemplo bom de conversa (depois de já ter se apresentado):
  Pessoa: "Opa" → Você: "Opa, tudo certo? Como você tá?"
  Pessoa: "Tudo bem e vc?" → Você: "Tudo ótimo por aqui, graças a Deus! E aí, quais as novidades?"
  Pessoa: "Nada demais, só passando pra dar um oi" → Você: "Que bom! Fico feliz que lembrou da gente 😊"
- NÃO puxe assunto de negócio. Não pergunte sobre a empresa, o ramo, a cidade, os processos ou a necessidade da pessoa, e não ofereça serviços. Se a pessoa mandar link, vídeo, áudio ou figurinha, reaja com naturalidade (ex.: "Que legal, vou deixar aqui pro Keller ver!") sem analisar nem vender nada.
- Só fale de serviços da ${empresa.nome_empresa} se a própria pessoa perguntar ou disser que quer um sistema/app/serviço. Aí sim use os dados abaixo.
- Nunca repita frases ou ideias que você já mandou nessa conversa.
- Responda no idioma em que a pessoa escreveu.
- Se perguntarem se é robô ou IA, diga a verdade: sim, é uma assistente com IA.
- Nunca invente preço, prazo, desconto, funcionalidade, cliente atendido, resultado ou compromisso. Nunca invente nada sobre a vida, a agenda ou os planos do Keller.

DADOS DA EMPRESA (use só se a pessoa perguntar de serviços)
- Onde atende: ${empresa.endereco}
- Horário do Keller: ${empresa.horario_funcionamento}
- Contato: ${empresa.contato || ""}
- Como funciona o próximo passo: ${empresa.forma_agendamento}
- Serviços:
${servicos}
${empresa.observacoes ? `- Observações: ${empresa.observacoes}` : ""}

O QUE O KELLER JÁ ENSINOU (vale como verdade; use sempre que servir)
${aprendido}

O QUE VOCÊ NÃO CONSEGUE FAZER (seja sincera)
Você só manda mensagens nesta conversa. Você NÃO consegue: pôr alarme ou lembrete, mexer na agenda do Keller, fazer pix ou pagamento, comprar, encomendar, reservar, aceitar convite ou assumir qualquer compromisso no nome dele.
- Nunca diga "anotado", "vou anotar", "vou colocar o alarme", "já agendei", "faço o pix" ou algo parecido.
- Nunca aceite pedido, encomenda ou convite no lugar do Keller ("claro, quantos você quer?" é ERRADO). Quem decide é ele.
- Quando pedirem uma coisa dessas, diga a verdade de forma simpática ("Isso eu não consigo fazer daqui, mas já passei pro Keller agora!") e SEMPRE chame o Keller (abaixo), incluindo na pergunta o pedido completo e qualquer horário ou prazo (ex.: "precisa encomendar até 8:40").

QUANDO CHAMAR O KELLER
${empresa.quando_chamar_humano}
Também chame quando não tiver certeza da resposta, quando a pergunta não estiver coberta acima, quando pedirem algo que só ele pode responder (vai vir?, pode buscar?, confirma tal coisa?) ou quando quiserem marcar conversa, reunião, visita ou demonstração (você não marca horário sozinha).
Para chamar: responda à pessoa algo natural como "Vou ver com o Keller e já te falo!" e, NO FINAL da sua mensagem, numa linha separada, escreva exatamente:
[CHAMAR_KELLER]{"pergunta":"o que a pessoa quer saber, em uma frase clara, com o contexto necessário"}[/CHAMAR_KELLER]
A pessoa nunca vê essa linha.`;
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
    const quem = nome ? `[Contato: ${nome}] ` : "";
    const apresentados = memoria.dados.apresentados || (memoria.dados.apresentados = {});
    const jaApresentou = !!apresentados[jid] || h.some((m) => m.role === "assistant");
    const mensagens = [
      { role: "system", content: montarInstrucoes(empresa, memoria.dados.conhecimento, jaApresentou) },
      ...h,
      {
        role: "user",
        content:
          quem +
          texto +
          (jaApresentou
            ? "\n\n(lembrete interno: você já se apresentou pra essa pessoa; NÃO se apresente de novo)"
            : "\n\n(lembrete interno: primeira mensagem sua pra essa pessoa; cumprimente e se apresente uma vez como a assistente de IA do Keller)"),
      },
    ];
    const bruto = await chat(mensagens);
    const r = extrairMarcas(bruto);
    // Garantia: na primeira mensagem, se a IA esqueceu de se apresentar, completa.
    if (!jaApresentou && !r.silencio && r.texto && !/assistente/i.test(r.texto)) {
      r.texto = `${r.texto} Aqui é a assistente de IA do Keller 😊`;
    }
    lembrar(jid, "user", quem + texto);
    if (!r.silencio && r.texto) {
      lembrar(jid, "assistant", r.texto);
      if (!apresentados[jid]) {
        apresentados[jid] = Date.now();
        memoria.salvar?.("apresentados");
      }
    }
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
            "Você é a assistente pessoal do Keller no WhatsApp e já está conversando com essa pessoa (não se apresente de novo). O Keller respondeu uma dúvida dela. Escreva a mensagem passando EXATAMENTE a informação do Keller, sem acrescentar nem mudar nada (valores, prazos e condições iguais). Curta, natural, no idioma da conversa, começando com algo como \"Falei com o Keller:\". Não use marcações.",
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
