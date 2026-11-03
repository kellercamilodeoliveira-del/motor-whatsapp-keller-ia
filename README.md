# Motor de WhatsApp — Keller IA

Atendente de IA no WhatsApp do Keller + envio automático pro Painel de Leads.

## O que ele faz

- **Responde sozinho** quem chama, 24h, com os dados de `empresas/keller-ia.json`
  e com tudo o que o Keller já ensinou. Entende áudio (transcreve) e responde no
  idioma do cliente.
- **Chama o Keller quando não sabe**: diz ao cliente que vai confirmar e manda a
  pergunta na conversa do Keller com ele mesmo ("Você"), com um código (#ABC).
- **Aprende**: o Keller responde arrastando a pergunta pro lado (ou escrevendo
  `#ABC resposta`, ou direto na conversa do cliente). O motor repassa ao cliente e
  guarda a resposta pra próximas vezes.
- **Respeita o pessoal**: se o Keller digitar numa conversa, o atendente fica quieto
  nela por 24h. Grupos nunca são respondidos. Mensagem claramente pessoal é ignorada.
- **Comandos** (na conversa do Keller com ele mesmo): `#ajuda`, `#status`,
  `#aprendido`, `#ensinar pergunta | resposta`, `#esquecer pergunta`,
  `#ignorar número`, `#liberar número`, `#desligar`, `#ligar`.

## Plano grátis do Render

- A sessão do WhatsApp e o "caderno" do atendente ficam salvos no Firestore,
  **criptografados** (chave derivada de `SEGREDO_SESSAO` ou, se não existir, da
  `GROQ_API_KEY`). Reinício não pede QR code de novo.
  Se trocar a `GROQ_API_KEY` sem ter `SEGREDO_SESSAO`, vai pedir QR code uma vez.
- O motor se chama a cada 10 minutos (`RENDER_EXTERNAL_URL`) pra não dormir.
- O plano grátis dá 750 horas/mês por conta: dá pra 1 serviço ligado o mês todo.

## Variáveis no Render

- `GROQ_API_KEY` — obrigatória pro atendente (grátis em https://console.groq.com).
- `SEGREDO_SESSAO` — opcional, qualquer frase longa secreta.
- `API_KEY` — opcional, protege `/enviar` e `/auto-enviar`.
- `GROQ_MODELO` — opcional, troca o modelo de IA.

## Arquivos

- `index.js` — conexão, regras do atendente, servidor HTTP.
- `atendente.js` — instruções e chamadas à IA.
- `sessao.js` — login do WhatsApp salvo no Firestore.
- `memoria.js` — ensinamentos, pendências, pausas e números ignorados.
- `cofre.js` — criptografia.
- `firestore.js` — acesso ao banco.
- `prospeccao.js` — mensagem padrão pros leads.
