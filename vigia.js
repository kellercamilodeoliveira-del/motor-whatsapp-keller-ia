/**
 * Vigia de Sistemas — Keller IA
 *
 * Confere a cada 5 minutos se os sites e sistemas da lista estão no ar.
 * - Caiu (3 falhas seguidas, ~10-15 min): avisa o Keller no WhatsApp (conversa com ele
 *   mesmo) e no celular (ntfy, se o #aviso estiver ligado).
 * - Voltou: avisa de novo, dizendo quanto tempo ficou fora.
 *
 * "No ar" = o servidor respondeu (qualquer código abaixo de 500). Página de login,
 * 403 ou 404 contam como no ar: quem respondeu está vivo. Fora = sem resposta,
 * demora mais de 20 s ou erro 5xx.
 *
 * Comandos (na conversa do Keller com ele mesmo):
 *   #vigia                         → situação de cada site agora
 *   #vigiar https://site.com Nome  → começa a vigiar
 *   #desvigiar nome ou endereço    → para de vigiar
 *
 * Página pra mostrar a clientes: /vigia/painel   (dados em JSON: /vigia)
 */

const INTERVALO_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20 * 1000;
const FALHAS_PARA_ALERTA = 3;
const FUSO = "America/Sao_Paulo";

// Lista inicial (o Keller muda pelo WhatsApp com #vigiar / #desvigiar).
const SITES_PADRAO = [
  { nome: "Site Keller IA", url: "https://kellercamilodeoliveira-del.github.io/" },
  { nome: "App Ponto Eletrônico", url: "https://kellercamilodeoliveira-del.github.io/apps/ponto/" },
  { nome: "Painel de Leads", url: "https://leads-keller-ia.netlify.app/" },
  { nome: "Banco de dados (Firebase)", url: "https://firestore.googleapis.com/" },
  { nome: "Focus NFe (notas fiscais)", url: "https://api.focusnfe.com.br/" },
  { nome: "Outlook / Microsoft 365", url: "https://outlook.office.com/" },
  { nome: "gov.br", url: "https://www.gov.br/" },
  { nome: "Conab", url: "https://www.conab.gov.br/" },
];

const hora = (ms) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

function duracao(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h}h${m ? String(m).padStart(2, "0") : ""}`;
  return `${Math.floor(h / 24)} dia(s) e ${h % 24}h`;
}

function normalizarUrl(texto) {
  let u = String(texto || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol) || !x.hostname.includes(".")) return null;
    return x.toString();
  } catch {
    return null;
  }
}

/** Testa um endereço. Retorna { ok, codigo, ms, erro }. */
async function testar(url, fetchFn = fetch) {
  const inicio = Date.now();
  try {
    const r = await fetchFn(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (Vigia de Sistemas Keller IA)" },
    });
    try { r.body?.cancel?.(); } catch {}
    return { ok: r.status < 500, codigo: r.status, ms: Date.now() - inicio, erro: r.status >= 500 ? `erro ${r.status} no servidor` : null };
  } catch (e) {
    const tempo = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, codigo: null, ms: Date.now() - inicio, erro: tempo ? "não respondeu em 20 s" : "sem resposta (" + (e?.cause?.code || e?.message || "erro") + ")" };
  }
}

/**
 * Aplica o resultado de um teste no estado de um site e diz se precisa avisar.
 * Função pura (pra testar). Retorna "caiu", "voltou" ou null.
 */
function aplicarResultado(est, res, agora) {
  est.ultima = agora;
  est.ms = res.ms;
  est.codigo = res.codigo;
  if (res.ok) {
    const estavaAvisado = !!est.avisadoQueda;
    if (est.ok !== true) est.desde = agora;
    est.ok = true;
    est.falhas = 0;
    est.erro = null;
    if (estavaAvisado) {
      est.voltouApos = agora - (est.caiuEm || agora);
      est.avisadoQueda = false;
      return "voltou";
    }
    return null;
  }
  est.falhas = (est.falhas || 0) + 1;
  est.erro = res.erro;
  if (est.falhas === 1) est.caiuEm = agora;
  if (est.ok !== false) { est.ok = false; est.desde = agora; }
  if (est.falhas >= FALHAS_PARA_ALERTA && !est.avisadoQueda) return "caiu";
  return null;
}

function linhaStatus(s, est) {
  if (!est || est.ok == null) return `⏳ ${s.nome} — ainda não conferi`;
  if (est.ok) return `🟢 ${s.nome} — no ar (${est.ms} ms)`;
  return `🔴 ${s.nome} — FORA desde ${hora(est.caiuEm || est.desde)} (${est.erro || "sem resposta"})`;
}

function iniciarVigia({ memoria, avisarKeller, notificarCelular, estaConectado, fetchFn = fetch }) {
  const dados = () => {
    const mem = memoria();
    if (!mem) return null;
    const v = (mem.dados.vigia = mem.dados.vigia || {});
    if (!Array.isArray(v.sites)) v.sites = SITES_PADRAO.map((s) => ({ ...s }));
    v.estado = v.estado || {};
    return { mem, v };
  };

  async function avisar(titulo, texto) {
    if (!estaConectado()) return false;
    const ok = await avisarKeller(texto);
    await notificarCelular(titulo, texto.replace(/\*/g, ""));
    return !!ok;
  }

  let rodando = false;
  async function conferir() {
    const d = dados();
    if (!d || rodando) return;
    rodando = true;
    try {
      const { mem, v } = d;
      const agora = Date.now();
      const resultados = await Promise.all(v.sites.map((s) => testar(s.url, fetchFn)));
      v.ultimaRodada = agora;
      for (let i = 0; i < v.sites.length; i++) {
        const s = v.sites[i];
        const est = (v.estado[s.url] = v.estado[s.url] || {});
        const evento = aplicarResultado(est, resultados[i], agora);
        if (evento === "caiu") {
          const ok = await avisar(
            `🔴 ${s.nome} fora do ar`,
            `🔴 *${s.nome} está FORA DO AR*\n${s.url}\n\nFalhou ${est.falhas} vezes seguidas desde ${hora(est.caiuEm)} (${est.erro}).\nAviso de novo quando voltar.`
          );
          if (ok) est.avisadoQueda = true; // se não deu pra avisar, tenta na próxima rodada
        } else if (evento === "voltou") {
          await avisar(`🟢 ${s.nome} voltou`, `🟢 *${s.nome} voltou ao ar*\nFicou fora por ${duracao(est.voltouApos)}.`);
        }
      }
      // limpa estado de sites que saíram da lista
      for (const url of Object.keys(v.estado)) if (!v.sites.some((s) => s.url === url)) delete v.estado[url];

      // primeira rodada: manda um resumo uma única vez
      if (!v.apresentado && estaConectado()) {
        const ok = await avisarKeller(
          "🛰️ *Vigia de Sistemas ligado*\nConfiro estes sites a cada 5 min e te aviso se algum cair ou voltar:\n\n" +
            v.sites.map((s) => linhaStatus(s, v.estado[s.url])).join("\n") +
            "\n\nComandos: #vigia (situação agora), #vigiar endereço Nome, #desvigiar nome." +
            "\nSe algum aparecer 🔴 já agora e estiver abrindo pra você, pode ser bloqueio a acesso de fora do Brasil: me mande #desvigiar nele."
        );
        if (ok) v.apresentado = true;
      }
      mem.salvar("vigia");
    } catch (e) {
      console.error("Vigia: erro na conferência:", e.message);
    } finally {
      rodando = false;
    }
  }

  setTimeout(conferir, 30 * 1000).unref?.();
  setInterval(conferir, INTERVALO_MS).unref?.();

  /** Trata #vigia / #vigiar / #desvigiar. Retorna o texto da resposta ou null se não for comando do vigia. */
  function comando(cmd, arg) {
    const d = dados();
    if (!["vigia", "vigiar", "desvigiar"].includes(cmd)) return null;
    if (!d) return "⏳ O vigia ainda está iniciando. Tente em 1 minuto.";
    const { mem, v } = d;
    if (cmd === "vigia") {
      const quando = v.ultimaRodada ? `Última conferência: ${hora(v.ultimaRodada)}` : "Primeira conferência ainda não terminou.";
      return `🛰️ *Vigia de Sistemas* (${v.sites.length} sites)\n\n${v.sites.map((s) => linhaStatus(s, v.estado[s.url])).join("\n")}\n\n${quando}`;
    }
    if (cmd === "vigiar") {
      const [primeiro, ...resto] = arg.split(/\s+/);
      const url = normalizarUrl(primeiro);
      if (!url) return "Escreva assim: #vigiar https://site.com.br Nome do sistema";
      if (v.sites.some((s) => s.url === url)) return `🛰️ Já estou vigiando ${url}.`;
      if (v.sites.length >= 40) return "🛰️ Limite de 40 sites. Tire algum com #desvigiar.";
      const nome = resto.join(" ").trim() || new URL(url).hostname;
      v.sites.push({ nome, url });
      mem.salvar("vigia");
      setTimeout(conferir, 2000);
      return `🛰️ Vou vigiar *${nome}* (${url}). Confiro a cada 5 min.`;
    }
    // desvigiar
    const alvo = arg.trim().toLowerCase();
    if (!alvo) return "Escreva assim: #desvigiar nome do sistema (ou o endereço)";
    const antes = v.sites.length;
    v.sites = v.sites.filter((s) => !(s.nome.toLowerCase().includes(alvo) || s.url.toLowerCase().includes(alvo)));
    const tirados = antes - v.sites.length;
    mem.salvar("vigia");
    return tirados ? `🗑️ Parei de vigiar ${tirados} site(s).` : `Não achei "${arg}" na lista. Mande #vigia pra ver os nomes.`;
  }

  function situacao() {
    const d = dados();
    if (!d) return { iniciando: true, sites: [] };
    const { v } = d;
    return {
      ultimaRodada: v.ultimaRodada || null,
      sites: v.sites.map((s) => {
        const e = v.estado[s.url] || {};
        return { nome: s.nome, url: s.url, ok: e.ok ?? null, desde: e.ok === false ? e.caiuEm || e.desde : e.desde || null, ms: e.ms ?? null, erro: e.ok === false ? e.erro : null };
      }),
    };
  }

  return { comando, situacao, conferir };
}

function registrarVigia(app, vigia) {
  app.get("/vigia", (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(vigia.situacao());
  });

  app.get("/vigia/painel", (req, res) => {
    res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status dos sistemas · Keller IA</title>
<style>
  :root{--bg:#0f1115;--card:#181b22;--txt:#e9ecf1;--sub:#8a93a3;--ok:#22c55e;--off:#ef4444;--wait:#eab308}
  *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--txt)}
  main{max-width:640px;margin:0 auto;padding:28px 16px 40px}
  h1{font-size:22px;margin:0 0 4px}.sub{color:var(--sub);font-size:14px;margin:0 0 20px}
  .geral{padding:16px;border-radius:14px;margin-bottom:16px;font-weight:600}
  .site{display:flex;align-items:center;gap:12px;background:var(--card);border-radius:12px;padding:14px;margin-bottom:8px}
  .dot{width:12px;height:12px;border-radius:50%;flex:none}.nome{font-weight:600}.det{color:var(--sub);font-size:13px;margin-top:2px}
  footer{color:var(--sub);font-size:12px;text-align:center;margin-top:24px}
</style></head><body><main>
<h1>🛰️ Status dos sistemas</h1><p class="sub" id="quando">Carregando…</p>
<div id="geral" class="geral"></div><div id="lista"></div>
<footer>Vigia de Sistemas · Keller IA · confere a cada 5 minutos</footer>
</main><script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt=ms=>new Date(ms).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
async function carregar(){
  try{
    const d=await (await fetch("/vigia",{cache:"no-store"})).json();
    const fora=d.sites.filter(s=>s.ok===false);
    const g=document.getElementById("geral");
    g.textContent=fora.length?("⚠️ "+fora.length+" sistema(s) fora do ar"):"✅ Todos os sistemas no ar";
    g.style.background=fora.length?"rgba(239,68,68,.15)":"rgba(34,197,94,.15)";
    document.getElementById("quando").textContent=d.ultimaRodada?("Última conferência: "+fmt(d.ultimaRodada)):"Primeira conferência em andamento…";
    document.getElementById("lista").innerHTML=d.sites.map(s=>{
      const cor=s.ok===true?"var(--ok)":s.ok===false?"var(--off)":"var(--wait)";
      const det=s.ok===true?("No ar · "+s.ms+" ms"):s.ok===false?("Fora desde "+fmt(s.desde)+" · "+esc(s.erro)):"Aguardando conferência";
      return '<div class="site"><span class="dot" style="background:'+cor+'"></span><div><div class="nome">'+esc(s.nome)+'</div><div class="det">'+det+'</div></div></div>';
    }).join("");
  }catch(e){document.getElementById("quando").textContent="Não consegui carregar agora. Tentando de novo…";}
}
carregar();setInterval(carregar,60000);
</script></body></html>`);
  });
}

module.exports = { iniciarVigia, registrarVigia, SITES_PADRAO, _teste: { aplicarResultado, testar, normalizarUrl, duracao } };
