/**
 * "Caderno" do atendente: o que o Keller ensinou, perguntas esperando resposta,
 * conversas pausadas e números que o atendente nunca responde.
 * Fica no Firestore (config/atendenteMemoria), criptografado, e em memória.
 */
const fsdb = require("./firestore");

const DOC = process.env.MEMORIA_DOC || "config/atendenteMemoria";
const CAMPOS = ["conhecimento", "pendencias", "pausas", "ajustes", "apresentados"];

async function carregarMemoria(cofre) {
  const dados = {
    conhecimento: [], // [{ p, r, em }]
    pendencias: {}, // codigo -> { jid, nome, pergunta, criadaEm, alertaId }
    pausas: {}, // jid -> ate (ms)
    ajustes: { ativo: true, ignorar: [] }, // ignorar = só dígitos do número
    apresentados: {}, // jid -> quando a assistente se apresentou (ms); só se apresenta 1 vez por pessoa
  };

  if (cofre) {
    try {
      const doc = await fsdb.getDoc(DOC);
      for (const campo of CAMPOS) {
        if (doc && doc[campo]) {
          try {
            dados[campo] = cofre.decifrar(doc[campo]);
          } catch {
            console.error(`Não consegui ler "${campo}" da memória (segredo mudou?). Começando vazio.`);
          }
        }
      }
    } catch (erro) {
      console.error("Erro ao carregar memória do atendente:", erro.message);
    }
  }

  const sujos = new Set();
  let timer = null;
  function salvar(campo) {
    sujos.add(campo);
    if (!cofre || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      const campos = {};
      for (const c of sujos) campos[c] = cofre.cifrar(dados[c]);
      sujos.clear();
      try {
        await fsdb.setCampos(DOC, campos);
      } catch (erro) {
        console.error("Erro ao salvar memória do atendente:", erro.message);
        for (const c in campos) salvar(c);
      }
    }, 3000);
  }

  return { dados, salvar };
}

module.exports = { carregarMemoria };
