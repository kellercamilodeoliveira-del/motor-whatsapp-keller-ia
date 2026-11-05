# Motor de WhatsApp — Keller IA

Atendente de IA no WhatsApp do Keller + envio automático pro Painel de Leads.

## O que ele faz

- **Responde sozinho** quem chama, 24h, com os dados de `empresas/keller-ia.json`
  e com tudo o que o Keller já ensinou. Entende áudio (transcreve) e responde no
  idioma do cliente.
- **Chama o Keller quando não sabe**: diz ao cliente que vai verificar (sem nunca
  citar o Keller) e manda a pergunta na conversa do Keller com ele mesmo ("Você"),
  com um código (#ABC).
- **Aprende**: o Keller responde arrastando a pergunta pro lado (ou escrevendo
  `#ABC resposta`, ou direto na conversa do cliente). O motor repassa ao cliente e
  guarda a resposta pra próximas vezes.
- **Conversa com todo mundo**, inclusive família e amigos (sem inventar nada sobre o
  Keller). Se o Keller digitar numa conversa, o atendente fica quieto nela por 2h.
  Grupos nunca são respondidos.
- **Comandos** (na conversa do Keller com ele mesmo): `#ajuda`, `#status`,
  `#aprendido`, `#ensinar pergunta | resposta`, `#esquecer pergunta`,
  `#ignorar número`, `#liberar número`, `#desligar`, `#ligar`.

## Pedidos de alteração em sistemas (time de agentes)

- Clientes cadastrados com `#cliente 14999999999 | Empresa | Sistema` podem pedir
  alterações no sistema pelo WhatsApp. O atendente entende o pedido e registra.
- O agente **Mecânico** (tarefa agendada) lê os pedidos em `GET /time/alteracoes`,
  faz a mudança, publica uma versão de TESTE e manda o link pro cliente
  (`POST /time/alteracoes/:id` com `mensagemCliente`, `linkTeste`, `status`).
- O cliente aprova pelo WhatsApp → o pedido vira `aprovado` → o Mecânico publica
  no app oficial. O app oficial nunca muda sem a aprovação do cliente.
- O que não for simples (função nova, cobrança, dúvida) o Mecânico manda pro Keller
  (`escalarKeller`). A resposta do Keller volta pro pedido, não direto pro cliente.
- Essas rotas exigem o cabeçalho `x-time-key` (a chave fica só na tarefa do time;
  no código fica só o hash dela).
- Comandos: `#cliente`, `#cliente remover número`, `#clientes`, `#pedidos`.

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
