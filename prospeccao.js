// Mensagem padrão de prospecção (mesma lógica do Painel de Leads).
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
  // AAAA-MM-DD no fuso de São Paulo (UTC-3), só pra controlar o limite diário.
  const agora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return agora.toISOString().slice(0, 10);
}

module.exports = { mensagemPadrao, hojeData };
