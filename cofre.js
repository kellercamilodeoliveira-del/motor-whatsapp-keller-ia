/**
 * Criptografia (AES-256-GCM) de tudo o que o motor grava no Firestore.
 * A chave vem da variável SEGREDO_SESSAO; se ela não existir, usa a GROQ_API_KEY
 * (que já fica guardada só no Render). Sem nenhuma das duas, nada é salvo.
 */
const crypto = require("crypto");
const { BufferJSON } = require("@whiskeysockets/baileys");

function criarCofre() {
  const segredo = process.env.SEGREDO_SESSAO || process.env.GROQ_API_KEY || "";
  if (!segredo) return null;
  const chave = crypto.createHash("sha256").update("keller-ia-cofre:" + segredo).digest();

  function cifrar(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", chave, iv);
    const dados = Buffer.concat([c.update(JSON.stringify(obj, BufferJSON.replacer), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), dados]).toString("base64");
  }

  function decifrar(b64) {
    const buf = Buffer.from(b64, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", chave, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const texto = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    return JSON.parse(texto, BufferJSON.reviver);
  }

  function hash(texto) {
    return crypto.createHmac("sha256", chave).update(texto).digest("hex").slice(0, 24);
  }

  return { cifrar, decifrar, hash };
}

module.exports = { criarCofre };
