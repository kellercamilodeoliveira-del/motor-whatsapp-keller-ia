# Motor de Secretária Virtual de IA — Keller IA

Responde no WhatsApp automaticamente, usando só os dados que a empresa cadastrou
(serviço, preço, horário). Não inventa informação.

## Antes de começar — leia isso

- **É um teste/MVP, não o produto final para múltiplos clientes.** Essa versão conecta
  em **um único número de WhatsApp por vez** (o da empresa que você quer validar primeiro).
  Pra atender várias empresas ao mesmo tempo como o app completo prevê, cada uma precisaria
  rodar sua própria cópia deste motor — isso é o próximo passo, depois de validar que
  funciona.
- **Usa uma biblioteca não-oficial (Baileys)**, não a API paga do WhatsApp. É de graça,
  mas tecnicamente fora do "combinado" do WhatsApp — funciona bem pra validar com poucas
  conversas, mas não é o caminho pra quando o volume crescer de verdade (aí sim vale a API
  oficial, que você já conhece as vantagens).
- **Comece testando no SEU número** (ou um número reserva), nunca direto no WhatsApp
  principal de um cliente, até ter certeza que está tudo redondo.

## Passo a passo (tudo grátis)

### 1. Criar conta na Groq (a "IA" que gera as respostas)
1. Acesse https://console.groq.com e crie uma conta grátis.
2. Vá em "API Keys" e crie uma chave.
3. Guarde essa chave — você vai colar no passo 4.

### 2. Subir este código num repositório
1. Crie uma conta grátis no GitHub (github.com), se não tiver.
2. Crie um repositório novo (ex: `motor-whatsapp-keller-ia`) e suba esta pasta inteira.

### 3. Criar o serviço no Render (hospedagem grátis)
1. Acesse https://render.com e crie uma conta grátis (dá pra entrar com o GitHub).
2. Clique em "New +" → "Web Service".
3. Selecione o repositório que você acabou de subir.
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Em "Environment Variables", adicione:
   - `GROQ_API_KEY` → cole a chave que você pegou no passo 1
6. Clique em "Create Web Service" e espere o deploy terminar.

### 4. Conectar seu WhatsApp
1. No Render, abra a aba "Logs" do serviço.
2. Vai aparecer um QR Code desenhado em texto.
3. No celular: WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho →
   escaneie o QR Code que apareceu nos logs.
4. Quando aparecer "✅ Conectado ao WhatsApp!" nos logs, está pronto.

### 5. Testar
Mande uma mensagem de outro número pro WhatsApp que você conectou. O motor deve responder
usando os dados do arquivo `empresas/exemplo.json`.

## Como cadastrar uma empresa de verdade

Edite (ou duplique) o arquivo `empresas/exemplo.json` com os dados reais — nome, serviços,
preços, horário. Pra essa primeira versão (um número só), o motor sempre usa os dados do
WhatsApp conectado; o cadastro por-cliente completo (cada empresa com seu próprio arquivo,
identificado automaticamente) é o próximo passo depois de validar que o motor responde bem.

## Limitação do plano gratuito do Render

O plano free "dorme" depois de ~15 minutos sem receber requisição HTTP, e demora uns 30-50
segundos pra "acordar" na próxima mensagem. Pra esse teste inicial não é grave — o cliente
pode notar uma demora na primeira resposta do dia, só isso. Se quiser eliminar essa demora
mais pra frente, aí sim entra uma solução paga (bem barata, tipo US$7/mês) ou a API oficial.

## Dúvidas comuns

**"Desconectou sozinho":** O WhatsApp Web (que o Baileys imita) às vezes pede reconexão.
O motor tenta reconectar sozinho; se não voltar, repita o passo 4.

**"A resposta veio estranha ou inventou informação":** Revise o arquivo da empresa — quanto
mais completo e claro o `quando_chamar_humano`, melhor a IA sabe quando recuar.
