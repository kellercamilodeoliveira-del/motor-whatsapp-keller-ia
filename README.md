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

## Ponto Eletrônico (comprovante por WhatsApp)

- `POST /ponto/comprovante` com `{ empresa, marcacao }` — chamado pelo tablet do app
  `kellercamilodeoliveira-del.github.io/apps/ponto` a cada batida.
- O motor lê a batida direto no Firestore (`ponto_empresas/...`), só aceita batida feita
  nos últimos 15 minutos e só uma vez, gera o comprovante em PDF (`ponto.js`) e manda no
  WhatsApp do colaborador (campo `whatsapp` do código) e do gestor (`whatsappGestor` da empresa).

### Avisos de horário (tolerância) — `pontoAlertas.js`

- Horários de cada empresa no mapa `HORARIOS` (tolerância em minutos e o WhatsApp que recebe os avisos). Horários e tolerâncias são relidos a cada 10 min de `apps/ponto/horarios.json` do site, então mudar horário não precisa reiniciar o motor.
  Betolub: seg–sex 08:30 / 12:00 / 13:30 / 18:00, sáb 08:00 / 13:00, tolerância 10 min (saída do fim do dia 6 min), avisos no (14) 99111-2441.
- Na batida: avisa entrada ou volta do almoço depois do horário + tolerância, e saída (almoço ou fim do dia) antes do horário − tolerância.
- Passou a tolerância: avisa quem ainda não bateu a entrada e quem saiu para o almoço e não voltou (1 aviso por dia em cada horário).
- Feriado cadastrado no app = sem aviso. A equipe é aprendida pelas batidas (guardada criptografada no caderno); código apagado sai da lista.

## Vigia de Sistemas — `vigia.js` (DESLIGADO: `VIGIA_LIGADO = false` no index.js)

- Confere a cada 5 min se os sites da lista estão no ar. "No ar" = o servidor respondeu
  (qualquer código abaixo de 500); fora = sem resposta, mais de 20 s ou erro 5xx.
- Caiu (3 falhas seguidas): avisa na conversa do Keller com ele mesmo e no celular (ntfy,
  se o `#aviso` estiver ligado). Voltou: avisa de novo com o tempo que ficou fora.
- Comandos: `#vigia` (situação agora), `#vigiar https://site.com.br Nome`, `#desvigiar nome`.
- Lista e estado ficam no caderno (campo `vigia`, criptografado). Lista inicial em `SITES_PADRAO`.
- Página pra mostrar a clientes: `/vigia/painel` (dados em JSON: `/vigia`).
- O vigia não enxerga o próprio motor: quem cuida dele é o Plantonista do Motor.

## DuaPi.NFe — nota fiscal direto na Sefaz (`nfe.js`)

- App: `kellercamilodeoliveira-del.github.io/apps/nfe` (repositório do site). O motor faz a parte da Sefaz.
- Sem serviço pago: XML, assinatura e envio pela biblioteca `node-sped-nfe` (MIT); DANFE por `node-sped-pdf` (MIT).
  O `nfe.js` ajusta uma linha do `node-sped-pdf` ao iniciar (protocolo no DANFE e fuso de Brasília).
- Empresa criada pelo Keller: `#nfe nova Nome` → código + senha. `#nfe empresas`, `#nfe senha código`.
- Certificado A1: aceito em qualquer formato de .pfx, regravado em 3DES (OpenSSL 3 lê sem "legacy"),
  guardado criptografado em `config/nfe-emp-<id>`. Notas autorizadas (nfeProc) em `config/nfe-xml-<id>-<chave>`.
- Rotas (`Authorization: Bearer <token>` do `/nfe/login`): `/nfe/eu`, `/nfe/dados`, `/nfe/certificado`, `/nfe/sefaz`,
  `/nfe/emitir`, `/nfe/ambiente`, `/nfe/senha`, `/nfe/nota/:chave/xml|pdf`, `/nfe/nota/:chave/cancelar|whatsapp`.
- Começa em homologação; produção só depois de 1 nota de teste autorizada. Versão 1: Simples Nacional e MEI.
- Se o cliente informar WhatsApp, o motor manda o DANFE (PDF) e o XML pra ele.
