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

// Bloco extra pra quem é cliente de um sistema do Keller (cadastrado com #cliente).
// Esses clientes podem pedir alterações: o "time" (agente Mecânico) faz a mudança,
// manda um link de teste e só publica depois que o cliente aprovar.
function instrucoesClienteSistema(cs) {
  if (!cs) return "";
  let teste = "";
  if (cs.testeAberto) {
    teste = `\nAGORA existe uma versão de TESTE esperando a aprovação dessa pessoa: "${cs.testeAberto.pedido}"${cs.testeAberto.link ? ` (link: ${cs.testeAberto.link})` : ""}.
- Se ela aprovar ("ok", "pode publicar", "ficou bom", "aprovado", "pode subir"), responda curto confirmando que vai colocar no ar e escreva no final, numa linha separada: [APROVADO]{}[/APROVADO]
- Se ela pedir correção nesse teste, responda que vai ajustar e mandar de novo, e escreva [ALTERACAO]{"pedido":"ajuste no teste: o que ela quer mudar, completo"}[/ALTERACAO]`;
  } else if (cs.pedidoAberto) {
    teste = `\nJá existe um pedido dessa pessoa em andamento: "${cs.pedidoAberto.pedido}".
- Se ela mandar algo sobre esse pedido (detalhe novo, aceitar ou recusar um valor que você passou, desistir), responda curto e escreva [ALTERACAO]{"pedido":"o que ela disse sobre o pedido, completo"}[/ALTERACAO]
- Se perguntar como está, diga que está sendo preparado e que você manda o link de teste assim que ficar pronto. Não invente prazo.`;
  }
  return `

ESSA PESSOA É CLIENTE DE UM SISTEMA
- Empresa: ${cs.cliente}. Sistema que ela usa: ${cs.sistema}.${cs.obs ? ` Observação: ${cs.obs}.` : ""}
- Se ela pedir alteração, correção, ajuste, campo novo, item novo, mudança de texto ou de layout NESSE sistema, ou relatar um erro nele: você PODE e DEVE aceitar o pedido. Confirme o que entendeu em 1 frase, diga que vai preparar e mandar um link de teste pra ela conferir antes de ir pro ar. Não prometa prazo nem preço.
- Se o pedido estiver vago (ex.: "muda o checklist"), pergunte só o que falta pra entender (qual tela, qual item, como deve ficar) ANTES de registrar.
- Quando o pedido estiver claro, escreva no final, numa linha separada (a pessoa nunca vê):
[ALTERACAO]{"pedido":"descrição completa e clara do que mudar, com todos os detalhes que ela deu"}[/ALTERACAO]
- Nesses casos NÃO use [CHAMAR_KELLER].${teste}`;
}

function montarInstrucoes(empresa, conhecimento, jaApresentou, clienteSistema) {
  const servicos = (empresa.servicos || [])
    .map((s) => `- ${s.nome}${s.descricao ? `: ${s.descricao}` : ""}${s.preco ? ` (valor: ${s.preco})` : ""}`)
    .join("\n");
  const aprendido = conhecimento.length
    ? conhecimento.map((c) => `- Pergunta: ${c.p}\n  Resposta certa: ${c.r}`).join("\n")
    : "(ainda nada)";

  const apresentacao = jaApresentou
    ? `- Você JÁ se apresentou pra essa pessoa. NÃO se apresente de novo, não diga "sou a assistente", não diga "Olá, sou...". Só converse normal, como o próprio Keller conversaria.`
    : `- Essa é a sua PRIMEIRA mensagem pra essa pessoa: responda o cumprimento dela e se apresente UMA vez, numa frase curta, como "a assistente de IA do Keller". Ex.: pessoa manda "Bom dia" → "Bom dia! Aqui é a assistente de IA do Keller 😊 Tudo bem com você?". Depois disso, nunca mais se apresente.`;

  return `Você é a assistente pessoal do Keller e responde pelo WhatsApp dele. Ele é dono da ${empresa.nome_empresa}${empresa.segmento ? ` (${empresa.segmento})` : ""}, mas esse WhatsApp é usado pra tudo: clientes, família, amigos, igreja, futebol.

AGORA: ${dataHoje()} (horário de Brasília).

COMO CONVERSAR
${apresentacao}
- Escreva como uma pessoa de verdade escreve no WhatsApp, não como robô nem como atendente de empresa. Tom leve, simpático e próximo, educado sem ser formal. Português do dia a dia do interior de SP: "tá", "pra", "beleza", "show", "tranquilo", "que bom", "opa", "imagina", "pode deixar".
- Espelhe a pessoa: se ela manda mensagem curta, responda curto (às vezes 1 frase basta). Se ela é mais formal (senhor/senhora, empresa séria), seja um pouco mais caprichada, mas sempre calorosa.
- Mensagens curtas: 1 a 3 frases. Nada de listas, tópicos, negrito ou textão. Emoji só de vez em quando (no máximo 1), quando combinar.
- Varie o jeito de falar: não comece toda mensagem do mesmo jeito, não repita "Que legal!", "Entendi!" ou "Perfeito!" toda hora. Nem sempre termine com pergunta; às vezes só comente ou concorde, como numa conversa normal.
- Reaja ao que a pessoa disse antes de responder ("Ah, que bom!", "Nossa, sério?", "Haha verdade"). Mostre que leu de verdade.
- PROIBIDO frases de robô/SAC: "Como posso ajudar?", "Em que posso ser útil?", "Fico à disposição", "Estou aqui para ajudar", "Qualquer dúvida estou à disposição", "Agradecemos o contato", "Prezado(a)", "Olá! Tudo bem? Em que posso ajudar hoje?".
- Exemplos do tom certo (depois de já ter se apresentado):
  Pessoa: "Opa" → "Opa, beleza? Tudo certo por aí?"
  Pessoa: "Tudo e vc?" → "Tudo ótimo, graças a Deus!"
  Pessoa: "Bom dia, abençoado" → "Bom dia! Amém, pra você também 🙏"
  Pessoa: "Kkkkk viu isso?" (manda um vídeo) → "Haha muito bom 😂"
  Pessoa: "Quanto fica um sistema desses?" → "Depende bastante do que você precisa. Me conta rapidinho o que você quer que o sistema faça?"
  Pessoa: "Obrigado!" → "Imagina! Precisando, é só chamar."
- NÃO puxe assunto de negócio. Não pergunte sobre a empresa, o ramo, a cidade, os processos ou a necessidade da pessoa, e não ofereça serviços. Se a pessoa mandar link, vídeo, áudio ou figurinha, reaja com naturalidade (ex.: "Que legal!") sem analisar nem vender nada.
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
- Quando pedirem uma coisa dessas, não confirme nada: responda de forma simpática e neutra ("Deixa eu verificar isso e já te retorno!") e SEMPRE chame o Keller (abaixo), incluindo na pergunta o pedido completo e qualquer horário ou prazo (ex.: "precisa encomendar até 8:40").

QUANDO CHAMAR O KELLER
${empresa.quando_chamar_humano}
Também chame quando não tiver certeza da resposta, quando a pergunta não estiver coberta acima, quando pedirem algo que só ele pode responder (vai vir?, pode buscar?, confirma tal coisa?) ou quando quiserem marcar conversa, reunião, visita ou demonstração (você não marca horário sozinha).
Para chamar: responda à pessoa algo natural e neutro, como "Boa pergunta! Vou verificar isso direitinho e já te retorno." ou "Deixa eu ver isso aqui e já te falo!", e, NO FINAL da sua mensagem, numa linha separada, escreva exatamente:
[CHAMAR_KELLER]{"pergunta":"o que a pessoa quer saber, em uma frase clara, com o contexto necessário"}[/CHAMAR_KELLER]
A pessoa nunca vê essa linha.

REGRA DE OURO: a conversa é sua do começo ao fim. A pessoa NUNCA pode perceber que você consulta alguém ou que o Keller está acompanhando a conversa.
- PROIBIDO dizer: "vou ver com o Keller", "vou conferir com o Keller", "vou perguntar pro Keller", "vou confirmar com o Keller", "já passei pro Keller", "vou avisar o Keller", "falei com o Keller", "o Keller disse", "o Keller vai te responder" ou qualquer variação.
- Quando não souber, diga só que vai verificar e já retorna, sem citar ninguém. Se a pessoa perguntar se vai demorar, responda com gentileza ("Já já te retorno!"), sem citar ninguém.
- Assunto de saúde, remédio ou dose: nunca dê orientação nem informação por conta própria; responda de forma neutra e chame o Keller.${instrucoesClienteSistema(clienteSistema)}`;
}

function extrairJsonMarca(texto, nome) {
  const re = new RegExp(`\\[${nome}\\]([\\s\\S]*?)(\\[\\/${nome}\\]|$)`, "i");
  const m = texto.match(re);
  if (!m) return { texto, valor: null };
  let valor;
  try {
    valor = JSON.parse(m[1].trim() || "{}");
  } catch {
    valor = { pedido: m[1].trim() };
  }
  return { texto: texto.replace(m[0], ""), valor };
}

function extrairMarcas(bruto) {
  let texto = bruto || "";
  if (/\[SILENCIO\]/i.test(texto)) return { silencio: true, texto: "", chamar: null };
  const alt = extrairJsonMarca(texto, "ALTERACAO");
  texto = alt.texto;
  const apr = extrairJsonMarca(texto, "APROVADO");
  texto = apr.texto;
  const alteracao = alt.valor && alt.valor.pedido ? alt.valor : null;
  const aprovado = !!apr.valor;
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
  return { silencio: false, texto, chamar, alteracao, aprovado };
}


// Garantia: tira da mensagem qualquer frase dizendo que vai consultar/falou com o Keller.
const VERBO_CONSULTA = /(ver|vejo|conferir|confiro|confirmar|confirmo|perguntar|pergunto|checar|consultar|falar|falo|passar|passei|avisar|avisei|aviso|verificar|chamar|levar|encaminh|falei|conversei|perguntei|confirmei|consultei|disse|falou|respond|retorn|aguard|deixar|deixei|mandei|mandar)/i;
function semConsultaAoKeller(texto, escalando = false) {
  if (!texto || !/keller/i.test(texto)) return texto;
  texto = texto.replace(/(^|[.!?]\s*)(falei|conversei|confirmei|verifiquei|perguntei)\s+(aqui\s+)?com\s+o\s+keller\s*[:,\-–]?\s*/gi, "$1Verifiquei aqui: ");
  const frases = texto.match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [texto];
  let tirou = false;
  const ficou = frases.filter((f) => {
    if (/keller/i.test(f) && VERBO_CONSULTA.test(f) && !/assistente/i.test(f)) {
      tirou = true;
      return false;
    }
    return true;
  });
  let limpo = ficou.join("").replace(/\s+([.!?,])/g, "$1").trim();
  if (tirou && escalando && !/verific|já te retorno|já te falo/i.test(limpo)) {
    limpo = "Vou verificar isso e já te retorno!" + (limpo ? " " + limpo : "");
  }
  return limpo;
}

// ---------- Anti-repetição ----------
function normalizar(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function parecida(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const A = new Set(na.split(" "));
  const B = new Set(nb.split(" "));
  let comum = 0;
  for (const w of A) if (B.has(w)) comum++;
  return comum / Math.max(A.size, B.size) >= 0.6;
}
// Frases de "vou verificar": a pessoa já ouviu uma vez, não precisa ouvir de novo.
const FRASE_DE_ESPERA = /(verific|ja te retorno|ja te falo|ja ja|deixa eu ver|vou ver|te retorno|um instante|so um minuto|aguarda)/;
const RESPOSTAS_CURTAS = ["Beleza 👍", "Fechado!", "Tá certo!", "Pode deixar.", "Combinado!", "Show!", "Tranquilo!", "Certo 👍"];

function criarAtendente({ groq, empresa, memoria }) {
  const historico = new Map(); // jid -> [{role, content}]

  async function chat(mensagens, opcoes = {}) {
    let ultimoErro;
    for (const modelo of MODELOS) {
      try {
        const r = await groq.chat.completions.create({
          model: modelo,
          messages: mensagens,
          temperature: opcoes.temperatura ?? 0.7,
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

  async function responder(jid, nome, texto, clienteSistema = null) {
    const h = historico.get(jid) || [];
    const quem = nome ? `[Contato: ${nome}] ` : "";
    const apresentados = memoria.dados.apresentados || (memoria.dados.apresentados = {});
    const jaApresentou = !!apresentados[jid] || h.some((m) => m.role === "assistant");
    const minhasUltimas = h.filter((m) => m.role === "assistant").slice(-5).map((m) => m.content);
    const esperandoResposta = Object.values(memoria.dados.pendencias || {}).some((p) => p.jid === jid);
    const jaDisseQueVaiVerificar = minhasUltimas.some((t) => FRASE_DE_ESPERA.test(normalizar(t)));
    let lembrete = jaApresentou
      ? "(lembrete interno: você já se apresentou pra essa pessoa; NÃO se apresente de novo)"
      : "(lembrete interno: primeira mensagem sua pra essa pessoa; cumprimente e se apresente uma vez como a assistente de IA do Keller)";
    if (minhasUltimas.length) {
      lembrete += `\n(o que você já mandou nessa conversa — NÃO repita nenhuma dessas frases nem o sentido delas: ${minhasUltimas.map((t) => `"${t}"`).join(" | ")})`;
    }
    if (esperandoResposta && jaDisseQueVaiVerificar) {
      lembrete +=
        "\n(você JÁ disse que ia verificar o pedido dessa pessoa. NÃO diga de novo que vai verificar/retornar. Só reaja ao que ela mandou agora, bem curto e natural: ex. \"Beleza 👍\", \"Fechado!\", \"Tá certo!\". Se ela mandou informação nova (número, horário, quantidade), inclua essa informação no [CHAMAR_KELLER].)";
    }
    const mensagens = [
      { role: "system", content: montarInstrucoes(empresa, memoria.dados.conhecimento, jaApresentou, clienteSistema) },
      ...h,
      {
        role: "user",
        content:
          quem +
          texto +
          "\n\n" +
          lembrete,
      },
    ];
    const bruto = await chat(mensagens);
    const r = extrairMarcas(bruto);
    if (r.texto) r.texto = semConsultaAoKeller(r.texto, !!r.chamar);
    // Garantia: não repetir o que já disse (nem repetir "vou verificar").
    if (r.texto) {
      const repetiu = minhasUltimas.some((t) => parecida(t, r.texto));
      const esperaDeNovo = jaDisseQueVaiVerificar && FRASE_DE_ESPERA.test(normalizar(r.texto));
      if (repetiu || esperaDeNovo) {
        try {
          const outra = extrairMarcas(
            await chat(
              [
                ...mensagens,
                { role: "assistant", content: r.texto },
                {
                  role: "user",
                  content:
                    "(interno) Você repetiu algo que já tinha dito. Reescreva a resposta com outras palavras, mais curta e natural, sem dizer de novo que vai verificar ou retornar. Mantenha a linha [CHAMAR_KELLER] se precisar.",
                },
              ],
              { temperatura: 0.9 }
            )
          );
          if (outra.chamar && !r.chamar) r.chamar = outra.chamar;
          if (outra.alteracao && !r.alteracao) r.alteracao = outra.alteracao;
          if (outra.aprovado) r.aprovado = true;
          outra.texto = semConsultaAoKeller(outra.texto || "", !!r.chamar);
          const aindaRepete =
            !outra.texto ||
            minhasUltimas.some((t) => parecida(t, outra.texto)) ||
            (jaDisseQueVaiVerificar && FRASE_DE_ESPERA.test(normalizar(outra.texto)));
          r.texto = aindaRepete ? null : outra.texto;
        } catch {
          r.texto = null;
        }
        if (!r.texto) {
          const livres = RESPOSTAS_CURTAS.filter((f) => !minhasUltimas.some((t) => parecida(t, f)));
          const lista = livres.length ? livres : RESPOSTAS_CURTAS;
          r.texto = lista[Math.floor(Math.random() * lista.length)];
        }
      }
    }
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
            "Você é a assistente pessoal do Keller no WhatsApp e já está conversando com essa pessoa (não se apresente de novo). O Keller respondeu uma dúvida dela. Escreva a mensagem passando EXATAMENTE essa informação, sem acrescentar nem mudar nada (valores, prazos e condições iguais), como se VOCÊ mesma tivesse verificado. Curta e natural, do jeito que uma pessoa escreve no WhatsApp (sem tom de SAC), no idioma da conversa. Pode começar com algo como \"Vi aqui:\", \"Prontinho!\" ou direto na resposta. NUNCA cite o Keller, nunca diga que falou, perguntou ou confirmou com alguém. Não use marcações.",
        },
        {
          role: "user",
          content: `Conversa recente:\n${contexto || "(sem histórico)"}\n\nDúvida do cliente: ${pergunta}\n\nResposta do Keller: ${respostaKeller}`,
        },
      ],
      { temperatura: 0.4, maxTokens: 300 }
    );
    const limpo = semConsultaAoKeller(texto.replace(/\[\/?[A-Z_]+\]/g, "").trim()) || respostaKeller;
    lembrar(jid, "assistant", limpo);
    return limpo;
  }

  function anotarFalaDoKeller(jid, texto) {
    lembrar(jid, "assistant", `(Keller respondeu pessoalmente) ${texto}`);
  }

  // Mensagem que o time (agente Mecânico) mandou pelo motor: entra no histórico
  // como fala da própria assistente, pra conversa continuar natural.
  function anotarFalaDoTime(jid, texto) {
    lembrar(jid, "assistant", texto);
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

  return { responder, redigirResposta, anotarFalaDoKeller, anotarFalaDoTime, transcrever };
}

module.exports = { criarAtendente, extrairMarcas };

