/**
 * Guarda o login do WhatsApp (sessão do Baileys) no Firestore, criptografado.
 *
 * Por quê: no plano grátis do Render o disco é apagado a cada reinício, e aí o
 * WhatsApp pedia QR code de novo. Com a sessão salva aqui, o motor volta sozinho.
 *
 * Como: as chaves ficam espalhadas em 8 documentos "config/waSessao0..7"
 * (cada campo = uma chave criptografada). As gravações são juntadas e enviadas
 * a cada 30 segundos, para não estourar a cota grátis do Firestore.
 * Chaves de grupo (sender-key) ficam só na memória: o atendente não fala em grupo.
 */
const { initAuthCreds, proto } = require("@whiskeysockets/baileys");
const fsdb = require("./firestore");

const SHARDS = 8;
const PREFIXO_DOC = process.env.SESSAO_PREFIXO || "config/waSessao";
const TIPOS_SO_MEMORIA = new Set(["sender-key", "sender-key-memory"]);
const INTERVALO_GRAVACAO_MS = 30 * 1000;

async function usarSessaoFirestore(cofre) {
  const cache = new Map(); // nome -> valor
  const sujos = new Map(); // nome -> valor (null = apagar)
  const campoDe = (nome) => "h" + cofre.hash(nome);
  const shardDe = (campo) => parseInt(campo.slice(1, 3), 16) % SHARDS;

  // Carrega o que já estava salvo.
  for (let i = 0; i < SHARDS; i++) {
    const doc = await fsdb.getDoc(`${PREFIXO_DOC}${i}`);
    if (!doc) continue;
    for (const campo in doc) {
      try {
        const { k, v } = cofre.decifrar(doc[campo]);
        cache.set(k, v);
      } catch {
        // Gravado com outro segredo ou corrompido: ignora.
      }
    }
  }

  const creds = cache.get("creds") || initAuthCreds();
  const tinhaSessao = cache.has("creds");

  let gravando = false;
  async function gravar() {
    if (gravando || sujos.size === 0) return;
    gravando = true;
    try {
      await gravarLote();
    } finally {
      gravando = false;
    }
  }
  async function gravarLote() {
    const lote = [...sujos];
    sujos.clear();
    const porShard = new Map();
    for (const [nome, valor] of lote) {
      const campo = campoDe(nome);
      const s = shardDe(campo);
      if (!porShard.has(s)) porShard.set(s, {});
      porShard.get(s)[campo] = valor === null ? undefined : cofre.cifrar({ k: nome, v: valor });
    }
    for (const [s, campos] of porShard) {
      const nomes = Object.keys(campos);
      for (let i = 0; i < nomes.length; i += 150) {
        const parte = {};
        for (const n of nomes.slice(i, i + 150)) parte[n] = campos[n];
        try {
          await fsdb.setCampos(`${PREFIXO_DOC}${s}`, parte);
        } catch (erro) {
          console.error("Erro ao salvar sessão no Firestore (tento de novo em 30s):", erro.message);
          // Devolve para a fila só o que não foi atualizado de novo nesse meio tempo.
          for (const [nome, valor] of lote) {
            if (!sujos.has(nome) && campoDe(nome) in parte) sujos.set(nome, valor);
          }
        }
      }
    }
  }
  const timer = setInterval(() => gravar().catch(() => {}), INTERVALO_GRAVACAO_MS);
  timer.unref();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out = {};
        for (const id of ids) {
          let v = cache.get(`${type}-${id}`);
          if (v && type === "app-state-sync-key") v = proto.Message.AppStateSyncKeyData.fromObject(v);
          if (v) out[id] = v;
        }
        return out;
      },
      set: async (data) => {
        for (const type in data) {
          for (const id in data[type]) {
            const nome = `${type}-${id}`;
            const valor = data[type][id];
            cache.set(nome, valor);
            if (!valor) cache.delete(nome);
            if (TIPOS_SO_MEMORIA.has(type)) continue;
            sujos.set(nome, valor || null);
          }
        }
      },
    },
  };

  async function saveCreds() {
    cache.set("creds", creds);
    sujos.set("creds", creds);
    await gravar();
  }

  async function apagarTudo() {
    sujos.clear();
    cache.clear();
    for (let i = 0; i < SHARDS; i++) {
      try {
        await fsdb.apagarDoc(`${PREFIXO_DOC}${i}`);
      } catch (erro) {
        console.error("Erro ao apagar sessão salva:", erro.message);
      }
    }
  }

  return { state, saveCreds, gravar, apagarTudo, tinhaSessao };
}

module.exports = { usarSessaoFirestore };
