/**
 * Ponto Eletrônico: avisos de horário no WhatsApp do gestor.
 *
 * - Na hora da batida: chegou depois do horário + tolerância (entrada / volta do almoço)
 *   ou saiu antes do horário - tolerância (saída para almoço / saída).
 * - Quando a tolerância passa: quem ainda não bateu a entrada, e quem saiu para o
 *   almoço e ainda não voltou.
 *
 * O motor não tem login no banco, então ele aprende a equipe pelas batidas
 * (código + nome, guardados criptografados no caderno) e confere cada código
 * pelo documento público do código (ultimaData / qtdDia, gravados pelo tablet).
 */

// Horários combinados com cada empresa (dia da semana: 0 = domingo ... 6 = sábado).
// Os horários e tolerâncias são relidos a cada 10 min de apps/ponto/horarios.json do site
// (assim dá pra mudar sem reiniciar o motor); o que está aqui vale se o arquivo não abrir.
// O número dos avisos fica só aqui no código.
// Dia com 4 horários: entrada, saída almoço, volta almoço, saída. Dia com 2: entrada, saída.
const HORARIOS = {
  "betolubservicosa-cmcx": {
    tolerancia: 10, // minutos (entrada, saída para almoço e volta do almoço)
    toleranciaSaida: 6, // minutos (saída do fim do dia)
    alertas: "14991112441", // WhatsApp que recebe os avisos
    dias: {
      1: ["08:30", "12:00", "13:30", "18:00"],
      2: ["08:30", "12:00", "13:30", "18:00"],
      3: ["08:30", "12:00", "13:30", "18:00"],
      4: ["08:30", "12:00", "13:30", "18:00"],
      5: ["08:30", "12:00", "13:30", "18:00"],
      6: ["08:00", "13:00"],
    },
  },
};

const URL_HORARIOS = "https://kellercamilodeoliveira-del.github.io/apps/ponto/horarios.json";
const FUSO = "America/Sao_Paulo";
const tolDe = (cfg, i, h) => (i === h.length - 1 && Number.isFinite(cfg.toleranciaSaida) ? cfg.toleranciaSaida : cfg.tolerancia);

// junta o que veio do site com o que está no código (só aceita o que tem formato certo)
function mesclarHorarios(base, remoto) {
  const out = {};
  for (const [emp, cfg] of Object.entries(base)) {
    const r = remoto && typeof remoto === "object" ? remoto[emp] : null, novo = { ...cfg };
    if (r && typeof r === "object") {
      const minOk = (v) => Number.isInteger(v) && v >= 0 && v <= 60;
      if (minOk(r.tolerancia)) novo.tolerancia = r.tolerancia;
      if (minOk(r.toleranciaSaida)) novo.toleranciaSaida = r.toleranciaSaida;
      if (r.dias && typeof r.dias === "object") {
        const dias = {};
        let ok = true;
        for (const [d, h] of Object.entries(r.dias)) {
          if (!/^[0-6]$/.test(d) || !Array.isArray(h) || ![2, 4].includes(h.length) || !h.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x))) { ok = false; break; }
          dias[d] = h;
        }
        if (ok) novo.dias = dias;
      }
    }
    out[emp] = novo;
  }
  return out;
}
const JANELA_MIN = 90; // até quantos minutos depois do limite o aviso de ausência ainda sai (cobre reinício do motor)
const EQUIPE_DIAS = 21; // código sem batida há mais que isso sai da lista de conferência
const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

const hm2min = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const min2hm = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const durTxt = (n) => (n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? String(n % 60).padStart(2, "0") : ""}` : `${n} min`);

// data, dia da semana e minuto do dia no horário de Brasília
function agoraSP(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(d).map((x) => [x.type, x.value])
  );
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { dia: `${p.year}-${p.month}-${p.day}`, dow, min: Number(p.hour) * 60 + Number(p.minute) };
}

// qual horário do dia essa batida representa (índice no array do dia) ou -1
function indiceDaBatida(tipo, horariosDoDia) {
  if (tipo === "Entrada") return 0;
  if (tipo === "Saída para almoço") return horariosDoDia.length === 4 ? 1 : -1;
  if (tipo === "Volta do almoço") return horariosDoDia.length === 4 ? 2 : -1;
  if (tipo === "Saída") return horariosDoDia.length - 1;
  return -1;
}
const NOMES = { 0: "a entrada", 1: "a saída para o almoço", 2: "a volta do almoço", 3: "a saída" };

/**
 * Decide se uma batida merece aviso. Retorna o texto ou null.
 * (Função pura, para testar.)
 */
function avisoDaBatida(cfg, tipo, ts, nome) {
  const sp = agoraSP(ts), h = cfg.dias[sp.dow];
  if (!h) return null;
  const i = indiceDaBatida(tipo, h);
  if (i < 0) return null;
  const previsto = hm2min(h[i]), dif = sp.min - previsto, tol = tolDe(cfg, i, h);
  const primeiro = String(nome || "").trim();
  if (i % 2 === 0 && dif > tol) {
    return `⏰ *${primeiro}* chegou *${durTxt(dif)} atrasado* n${i === 0 ? "a entrada" : "a volta do almoço"}.\nHorário: ${h[i]} · bateu às ${min2hm(sp.min)} (tolerância ${tol} min).`;
  }
  if (i % 2 === 1 && dif < -tol) {
    const qual = h.length === 4 && i === 1 ? "para o almoço" : "do trabalho";
    return `⏰ *${primeiro}* saiu ${qual} *${durTxt(-dif)} antes* do horário.\nHorário: ${h[i]} · bateu às ${min2hm(sp.min)} (tolerância ${tol} min).`;
  }
  return null;
}

/**
 * Quem está fora do combinado num ponto de conferência (índice 0 = entrada, 2 = volta do almoço).
 * codigos: [{ nome, ultimaData, qtdDia }]. (Função pura, para testar.)
 */
function quemFalta(indice, dia, codigos) {
  if (indice === 0) return codigos.filter((c) => c.ultimaData !== dia).map((c) => c.nome);
  if (indice === 2) return codigos.filter((c) => c.ultimaData === dia && c.qtdDia === 2).map((c) => c.nome);
  return [];
}

function iniciarAlertasPonto({ lerDoc, enviar, paraJid, estaConectado, memoria }) {
  let horarios = HORARIOS;
  async function recarregarHorarios() {
    try {
      const r = await fetch(URL_HORARIOS + "?t=" + Date.now(), { signal: AbortSignal.timeout(15000) });
      if (r.ok) horarios = mesclarHorarios(HORARIOS, await r.json());
    } catch (e) {}
  }
  recarregarHorarios();
  setInterval(recarregarHorarios, 10 * 60 * 1000);

  const caderno = () => {
    const mem = memoria();
    if (!mem) return null;
    mem.dados.pontoEquipe = mem.dados.pontoEquipe || {};
    mem.dados.pontoAvisos = mem.dados.pontoAvisos || {};
    return mem;
  };

  async function ehFeriado(empresa, dia) {
    try { return !!(await lerDoc(`ponto_empresas/${empresa}/feriados/${dia}`)); } catch (e) { return false; }
  }

  async function mandar(cfg, texto) {
    if (!estaConectado()) return false;
    try { await enviar(paraJid(cfg.alertas), { text: texto }); return true; } catch (e) {
      console.error("Ponto: erro ao mandar aviso de horário:", e.message);
      return false;
    }
  }

  // chamada a cada batida conferida (ponto.js)
  async function aoBater(empresa, m) {
    const cfg = horarios[empresa];
    if (!cfg) return;
    const mem = caderno();
    if (mem && m.codigo) {
      const eq = (mem.dados.pontoEquipe[empresa] = mem.dados.pontoEquipe[empresa] || {});
      eq[m.codigo] = { nome: m.nome || "", visto: Date.now() };
      mem.salvar("pontoEquipe");
    }
    const texto = avisoDaBatida(cfg, m.tipo, m.ts, m.nome);
    if (!texto) return;
    if (await ehFeriado(empresa, agoraSP(m.ts).dia)) return;
    await mandar(cfg, texto);
  }

  // conferência de ausências, 1 vez por minuto
  async function conferir() {
    const mem = caderno();
    if (!mem || !estaConectado()) return;
    const sp = agoraSP();
    for (const [empresa, cfg] of Object.entries(horarios)) {
      const h = cfg.dias[sp.dow];
      if (!h) continue;
      for (const indice of h.length === 4 ? [0, 2] : [0]) {
        const limite = hm2min(h[indice]) + cfg.tolerancia;
        if (sp.min <= limite || sp.min > limite + JANELA_MIN) continue;
        const chave = `${empresa}|${sp.dia}|${indice}`;
        if (mem.dados.pontoAvisos[chave]) continue;
        if (await ehFeriado(empresa, sp.dia)) { mem.dados.pontoAvisos[chave] = Date.now(); mem.salvar("pontoAvisos"); continue; }
        const eq = mem.dados.pontoEquipe[empresa] || {};
        const lidos = [];
        for (const [codigo, info] of Object.entries(eq)) {
          if (Date.now() - (info.visto || 0) > EQUIPE_DIAS * 864e5) { delete eq[codigo]; continue; }
          let c = null;
          try { c = await lerDoc(`ponto_empresas/${empresa}/codigos/${codigo}`); } catch (e) { c = undefined; }
          if (c === null) { delete eq[codigo]; continue; } // código apagado (saiu da empresa / trocou o código)
          if (c === undefined) continue; // erro de rede: não conta como falta
          lidos.push({ nome: c.nome || info.nome, ultimaData: c.ultimaData, qtdDia: c.qtdDia || 0 });
        }
        mem.salvar("pontoEquipe");
        const faltam = quemFalta(indice, sp.dia, lidos);
        if (faltam.length) {
          const titulo = indice === 0
            ? `🚨 Já são ${min2hm(sp.min)} (entrada ${h[0]} + ${cfg.tolerancia} min) e ainda não bateram a entrada:`
            : `🚨 Já são ${min2hm(sp.min)} (volta do almoço ${h[2]} + ${cfg.tolerancia} min) e ainda não voltaram do almoço:`;
          const ok = await mandar(cfg, `${titulo}\n${faltam.map((n) => `• ${n}`).join("\n")}`);
          if (!ok) continue; // tenta de novo no próximo minuto
        }
        mem.dados.pontoAvisos[chave] = Date.now();
        for (const k of Object.keys(mem.dados.pontoAvisos)) if (Date.now() - mem.dados.pontoAvisos[k] > 3 * 864e5) delete mem.dados.pontoAvisos[k];
        mem.salvar("pontoAvisos");
      }
    }
  }

  let rodando = false;
  setInterval(async () => {
    if (rodando) return;
    rodando = true;
    try { await conferir(); } catch (e) { console.error("Ponto: erro na conferência de horários:", e.message); }
    rodando = false;
  }, 60 * 1000);

  return { aoBater };
}

module.exports = { iniciarAlertasPonto, HORARIOS, _teste: { avisoDaBatida, quemFalta, agoraSP, mesclarHorarios } };
