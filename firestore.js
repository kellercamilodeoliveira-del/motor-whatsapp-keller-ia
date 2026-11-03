/**
 * Acesso simples ao Firestore (projeto escritorio-c3acb) pela API REST.
 * As regras do banco liberam leitura e escrita pública nas coleções
 * "leads", "config" e "agendamentos" — por isso tudo o que é privado
 * (sessão do WhatsApp, perguntas de clientes) é gravado CRIPTOGRAFADO.
 */

const FIRESTORE_PROJECT = "escritorio-c3acb";
const FIRESTORE_API_KEY = "AIzaSyBZyZ4Dqs0BI5VSsm3HB2TNGpk7Z7330CE";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;

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

async function getDoc(caminho) {
  const resp = await fetch(`${FIRESTORE_BASE}/${caminho}?key=${FIRESTORE_API_KEY}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Firestore GET ${caminho} falhou: ${resp.status}`);
  const data = await resp.json();
  return fsCamposParaJs(data.fields || {});
}

async function listarColecao(nome) {
  const resp = await fetch(`${FIRESTORE_BASE}/${nome}?pageSize=300&key=${FIRESTORE_API_KEY}`);
  if (!resp.ok) throw new Error(`Firestore LIST ${nome} falhou: ${resp.status}`);
  const data = await resp.json();
  return (data.documents || []).map((doc) => {
    const id = doc.name.split("/").pop();
    return { id, ...fsCamposParaJs(doc.fields || {}) };
  });
}

/**
 * Atualiza só os campos informados. Campo com valor `undefined` é APAGADO
 * do documento (entra na máscara, mas não vai no corpo).
 */
async function setCampos(caminho, campos) {
  const nomes = Object.keys(campos);
  if (nomes.length === 0) return;
  const mask = nomes.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const fields = {};
  for (const k of nomes) if (campos[k] !== undefined) fields[k] = jsParaFsValor(campos[k]);
  const resp = await fetch(`${FIRESTORE_BASE}/${caminho}?${mask}&key=${FIRESTORE_API_KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Firestore PATCH ${caminho} falhou: ${resp.status}`);
}

async function apagarDoc(caminho) {
  const resp = await fetch(`${FIRESTORE_BASE}/${caminho}?key=${FIRESTORE_API_KEY}`, { method: "DELETE" });
  if (!resp.ok && resp.status !== 404) throw new Error(`Firestore DELETE ${caminho} falhou: ${resp.status}`);
}

async function criarDoc(colecao, campos) {
  const fields = {};
  for (const k in campos) fields[k] = jsParaFsValor(campos[k]);
  const resp = await fetch(`${FIRESTORE_BASE}/${colecao}?key=${FIRESTORE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Firestore POST ${colecao} falhou: ${resp.status}`);
}

module.exports = { getDoc, listarColecao, setCampos, apagarDoc, criarDoc };
