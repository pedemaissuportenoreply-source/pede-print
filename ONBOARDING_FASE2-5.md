# pede-print — Onboarding self-serve (Fases 2-5)

**Data:** 2026-07-28 · Continuação de [ONBOARDING_INVESTIGACAO.md](./ONBOARDING_INVESTIGACAO.md)

Premissa da Fase 1, mantida: **o login não substitui a apiKey — ele provisiona uma.**
O socket continua conectando por apiKey, porque é isso que faz o gateway marcar
`isPrintAgent` (`realtime.gateway.ts:56`) e ligar a fila `receipt:print`/`print:ack`.
`socket.js` **não foi alterado**.

---

## Múltiplas apiKeys por tenant — como se comportam (pedido antes de codar)

Investigado em `realtime.gateway.ts` e `print.service.ts` antes de escrever a revogação:

1. **O gateway aceita N chaves, mas nunca N agentes.** `apiKeysService.validate()` (`api-keys.service.ts:44`) aceita qualquer chave não-revogada do tenant, então N chaves ativas autenticam. Mas `handleConnection` (`realtime.gateway.ts:78-86`) varre a sala `tenant:{id}` e **desconecta todo socket com `isPrintAgent`** que não seja o novo. Resultado: sempre exatamente 1 agente vivo por tenant, independente de quantas chaves existam.
2. **A fila é por TENANT, não por socket.** `PrintService.activeAgent` é um `Map<tenantId, socketId>` (`print.service.ts:53`) e `dispatchJob` faz unicast para `activeAgent.get(tenantId)` (`:333-341`) — nunca broadcast.
3. **Os jobs vivem no banco, não na memória do socket.** São linhas de `printJob` com status `PENDING`. `onAgentConnected` chama `resendPending(tenantId)` (`:210`), que redespacha **todos** os PENDING do tenant. O ack tem timeout de 15 s e `RETRY_LIMIT` 3 (`:10`, `:353-378`).
4. **Logo, revogar chave não pode deixar job órfão.** Sem ack, o job continua `PENDING`; quando o agente novo conecta, `resendPending` o reenvia. E `onAgentDisconnected` (`:213-222`) só limpa `activeAgent` se o socket que saiu **era** o ativo — o socket antigo cai no ramo "socket fantasma" e não apaga o registro do novo.

### Decisão de desenho que isso motivou

**O provision revoga as chaves antigas mas NÃO derruba o socket do agente antigo.**
`validate()` só roda no *handshake*, então o agente que já está conectado segue
imprimindo normalmente até o agente novo conectar — aí o gateway faz a troca sozinho,
na ordem que ele já implementa. Isso evita a janela sem agente que um
`disconnect` forçado no provision criaria (o `resendPending` dispararia contra ninguém).

O único risco residual é o que já existia antes desta mudança: se o agente antigo
imprimiu e morreu **antes** de mandar o `print:ack`, o job segue `PENDING` e o
agente novo o reimprime. O `_printedJobIds` do agente (`main.js:86-95`, cap FIFO 1000)
cobre o caso dentro de um mesmo processo; entre processos diferentes, não. **Comportamento
inalterado por esta fase** — não introduzimos nem agravamos isso.

---

## Backend — o único ponto tocado

### `POST /api/v1/print-agent/provision`

`src/print/print-agent.controller.ts`

- **Sem `@Public()`** → os guards globais (`JwtAuthGuard` + `PlanoAtivoGuard`, `app.module.ts:72-73`) valem. Tenant com assinatura vencida recebe o **403/402 do `PlanoAtivoGuard`, nunca 401** — não alteramos nada nesse caminho.
- `tenantId` vem **só** de `@GetUser('tenantId')`, isto é, do JWT. Nunca de body, query ou header.
- Retorna `{ apiKey, apiKeyId, tenant: { id, nome, cnpj, telefone, endereco } }`. O `endereco` é montado a partir de `endereco/numero/bairro/cidade/estado/cep` para o cabeçalho do cupom.

### `DELETE /api/v1/print-agent/provision`

Autenticado por **`ApiKeyGuard`** (`@Public()` + `@UseGuards(ApiKeyGuard)`), porque no
logout o agente tem a apiKey em mãos, não um JWT. `tenantId` vem do `req` preenchido
pelo guard. Mesmo mecanismo já usado por `printer-profiles` e `sectors`.

### `ApiKeysService` — 2 métodos novos, geração reusada

`src/api-keys/api-keys.service.ts`

```
PRINT_AGENT_KEY_NAME = 'Pede+ Print (agente)'   // nome RESERVADO

provisionPrintAgent(tenantId)   // revoga as com esse nome -> generate() -> nova
revokePrintAgent(tenantId)      // revoga as com esse nome, sem emitir
```

`provisionPrintAgent` **reusa `generate()`** — não há segunda implementação de
`randomBytes`/`sha256`. A revogação filtra **pelo nome reservado**, então chaves que
o usuário criou à mão no painel (nome livre) **nunca são revogadas**, mesmo que ele
as use no agente.

Nada mais no backend foi tocado: gateway `/realtime`, `PrintService`, `ApiKeyGuard`,
`orderToPedido.ts`, `sanitizeOutgoing()` — todos intactos.

---

## pede-print — o que mudou

| Arquivo | Mudança |
|---|---|
| `config-defaults.js` | **novo** — `PROD_URL` fixa + normalização/promoção https |
| `auth-agent.js` | **novo** — login, 2FA (verify/resend), provision, revoke |
| `renderer/setup.html` | **novo** — assistente 3 passos + painel avançado escondido |
| `renderer/setup.js` | **novo** — lógica do assistente |
| `main.js` | `serverUrl()`/`effectiveConfig()`, IPC de login/otp/logout, tray com nome do restaurante |
| `config-window.js` | carrega `setup.html`; `hideConfigWindow()` para a bandeja |
| `printer-routing.js` | **1 campo aditivo**: `manufacturer` no target (a UI monta o nome sem reparsear o `label`) |
| `package.json` | exclui `renderer/_legacy/**` do build |
| `renderer/_legacy/` | `config.html` + `config.js` antigos **movidos**, não apagados |

### Fase 2 — URL fixa

`https://app.pedeplus.com.br` em `config-defaults.js`. **Nenhum campo de URL no fluxo
do cliente.** O override fica no painel "Configurações avançadas", aberto por
**Ctrl+Shift+D** ou **5 cliques na linha da versão** — invisível no caminho normal.

`resolveServerUrl()` só honra o override quando `devMode === true` **e** a URL é válida.
Fora disso devolve produção. `http://` é promovido a `https://` sempre que o host **não**
é local (`localhost`, `127.0.0.1`, `192.168.x`, `10.x`, `172.16-31.x`). Testado:

| Entrada | Resultado |
|---|---|
| sem config | `https://app.pedeplus.com.br` |
| `devMode:false` + `http://evil.com` | `https://app.pedeplus.com.br` |
| `devMode:true` + `http://localhost:3000` | `http://localhost:3000` |
| `devMode:true` + `http://192.168.1.24:3000` | `http://192.168.1.24:3000` |
| `devMode:true` + `http://app.pedeplus.com.br` | `https://app.pedeplus.com.br` ⬅ promovido |
| `devMode:true` + `staging.pedeplus.com.br` | `https://staging.pedeplus.com.br` |
| `ftp://x.com` / `javascript:alert(1)` / `lixo::` / vazio | `https://app.pedeplus.com.br` |
| `devMode:'yes'` (truthy, não `true`) | `https://app.pedeplus.com.br` |

> Um bug foi encontrado e corrigido nesse teste: `ftp://x.com` virava `https://ftp` porque
> o prepend de esquema acontecia antes da validação. Agora esquema explícito
> não-http/https é rejeitado antes do prepend.

**Nenhum ponto lê `config.serverUrl` direto** — tudo passa por `serverUrl()`/`effectiveConfig()`
em `main.js`. O IPC `validate-key` (legado, sem UI) também deixou de aceitar URL do renderer.

### Fase 3 — login que provisiona

`agent-login` → `POST /auth/login` com o corpo **exato** do `LoginDto` (`{ email, senha }`).
O `ValidationPipe` global roda com `forbidNonWhitelisted: true` (`main.ts:167-168`), então
qualquer campo extra viraria 400 — conferido no DTO antes de escrever.

`agent-verify-otp` → `POST /auth/verify-otp` com `{ tempToken, code, fingerprint }`.
`fingerprint` é **obrigatório** no `VerifyOtpDto` (`auth.dto.ts:70-79`); geramos um id
estável por instalação (`deviceFingerprint()`, guardado no store, não identifica pessoa).

O JWT é usado só para provisionar e **descartado** — só a apiKey é persistida.

Erros traduzidos: 401 → credenciais; 402/403 com `SUBSCRIPTION_EXPIRED` → "assinatura
vencida, regularize no painel"; 429 → excesso de tentativas; 5xx → servidor indisponível.

### Fase 4 — detecção: só UI

**Zero mudança de lógica.** `deviceKey` (`pnpId→locationId→serialNumber→path`),
`printers-config.json`, `ensureConfig`, `resolveForSetor`, `resolveDefault` e
`reResolveTarget` estão byte-idênticos. O assistente consome os mesmos IPC
`get-print-targets` e `save-printer-mapping` que já existiam.

O que mudou na apresentação:

- **Nome legível:** modelo reconhecido → `manufacturer` → nome do spooler → "Impressora térmica". Nunca "COM7" cru, nunca `deviceKey`, nunca VID/PID. A porta aparece só como texto de apoio ("Conectada por USB · porta COM7").
- **1 impressora:** pré-selecionada; o cliente só confirma com "Imprimir teste". Sem dropdown de setor (não há o que rotear).
- **2+ impressoras:** escolhe a principal por card e atribui setor num select amigável ("Só cozinha" / "Só caixa" / "Só bar" / "Todos os pedidos").
- **"Reescanear"** re-detecta (o IPC já re-detectava a cada chamada; faltava o botão).
- **Portas de sistema** (serial sem VID/PID e sem perfil, ex. `ACPI\PNP0501`) ficam **fora** da lista — não são impressora e só confundiriam.
- `finishPrinterStep` **preserva** `profileId`, `cortarPapel` e `override` já salvos: o assistente escreve setor e padrão, e não zera o que foi ajustado no modo avançado.

### Fase 5 — assistente + bandeja

`Entrar → (código 2FA) → Impressora → Pronto`, com trilha de passos visível.
"Minimizar para a bandeja" chama `hide-to-tray` → `hideConfigWindow()`; o tray segue
vivo e o auto-print continua. `openConfigWindow` agora dá `.show()` se a janela
estiver escondida. `window-all-closed` continua prevenido (`main.js`).

Status conectado/desconectado no topo via o IPC `status-changed` que já existia; o tray
mostra o nome do restaurante no tooltip e no menu. **A reconexão automática de
`socket.js` (10 tentativas a 3 s → timer lento de 30 s) não foi tocada.**

### Cabeçalho do cupom automático

`persistProvision` grava `tenantName/tenantAddress/tenantPhone/tenantCnpj` a partir do
tenant devolvido pelo provision, com `prev.X || backend.X` — **um valor que o usuário
editou à mão sempre ganha**. Os 4 campos saíram do fluxo normal e vivem num
`<details>` dentro do painel avançado, como override opcional. Por padrão o cliente
não digita nada.

---

## Confirmações pedidas

### (a) Provisionar 2× no mesmo tenant não deixa impressão órfã nem duas chaves ativas

**Duas chaves ativas: impossível.** `provisionPrintAgent` faz `updateMany({ tenantId,
name: PRINT_AGENT_KEY_NAME, revoked: false } → { revoked: true })` **antes** de
`generate()`. Ao fim da chamada existe exatamente 1 chave de agente ativa por tenant.

**Impressão órfã: não acontece**, pela cadeia verificada acima:
1. provision revoga a chave antiga e emite a nova. O socket antigo **continua vivo** (validate só roda no handshake) e segue imprimindo — sem janela morta.
2. O agente novo conecta com a chave nova → o gateway derruba o anterior (`realtime.gateway.ts:78-86`) → `onAgentConnected` → `activeAgent.set(tenant, novoSocket)` → `resendPending(tenantId)` redespacha todo `PENDING`.
3. O `handleDisconnect` do socket antigo vê que `activeAgent.get(tenantId) !== seuId` e cai no ramo "socket fantasma" (`print.service.ts:219-221`) — **não** apaga o agente novo.

Job em andamento sem ack fica `PENDING` no banco e é reenviado no passo 2. Nada se perde.

### (b) Login com 2FA passa pelo assistente sem travar

`POST /auth/login` respondendo `{ requiresOtp: true, tempToken, email }` **não** é tratado
como erro: `agent-login` devolve esse estado, o assistente troca para o painel
`panel-otp` mostrando o e-mail mascarado que o backend enviou, e o passo 3 do fluxo
segue normalmente após `agent-verify-otp`. Detalhes:

- campo de 6 dígitos que aceita só números e **auto-envia** ao completar;
- "Reenviar código" via `POST /auth/resend-otp`, absorvendo o `tempToken` rotacionado;
- "Voltar" limpa o estado de OTP e retorna ao login;
- código errado (400/401) → mensagem própria + campo limpo e focado, sem sair da tela;
- `fingerprint` obrigatório do DTO é enviado, então a chamada não quebra na validação.

Tenant **sem** 2FA não vê essa tela: vai de "Entrar" direto para "Impressora".

### (c) "Sair" revoga/limpa a apiKey local

`agent-logout` faz, nesta ordem:
1. `DELETE /print-agent/provision` com `x-api-key` → backend revoga as chaves de agente do tenant (best-effort);
2. `cleanupSocket()` + status `disconnected`;
3. remove do store `apiKey`, `apiKeyId`, `tenantId`, `userEmail` e os 4 campos de cabeçalho.

A limpeza local roda **mesmo se o backend estiver offline** — o passo 1 não bloqueia o 2
e o 3. Sem `apiKey`, `startSocket()` retorna cedo e `_needsSetup()` é verdadeiro, então a
próxima abertura cai no login. **Sessão não vaza entre estabelecimentos.** A mensagem
distingue os dois casos ("chave revogada" × "sessão encerrada neste computador").

---

## Validação

```
pede-print (node --check, sem tsc):
  main.js  config-defaults.js  auth-agent.js  config-window.js
  printer-routing.js  renderer/setup.js                          → todos OK
  package.json → JSON válido

backend: npx tsc -b → exit 0, zero erros
```

Testes de comportamento executados: matriz de 13 casos de `resolveServerUrl` (tabela acima).

### Âncoras de não-regressão reconferidas depois das edições

| Item | Estado |
|---|---|
| Auto-print só no `order:new` | `socket.js:101` intacto (gate `_kitchenOnly`/`_cozinhaAutoPrint`) |
| `noCut` respeitado | `main.js:351` intacto; `printer.js` **não foi tocado** |
| `isPrintAgent` / fila por tenant | socket segue com `auth: { apiKey }` (`socket.js:53-54`); gateway e `PrintService` intactos |
| `deviceKey` estável | `printer-routing.js:30-34` byte-idêntico |
| `reResolveTarget` | intacto |
| `drainSafe()` | `src/serial-print.js` **não foi tocado** |
| dedup `jobKey` / `:viaN` | `main.js` `_isDuplicate`/`_rememberJobId` intactos; vias no backend intactas |
| Catálogo homologado | `printer-profiles.js:24-38` **não foi tocado** (Epson TM-T20 cp860/ESC t 3, Daruma DR800 ESC t 7/cp1252 + corte `[29,86,65,0]`, Elgin i9, Bematech) |
| `brandFooter` | `printer.js` **não foi tocado** |
| COM + USB nativa | `detectTargets` preserva os dois ramos; só ganhou o campo `manufacturer` |
| `SUBSCRIPTION_EXPIRED` 403/402 | `PlanoAtivoGuard` global não foi tocado; o agente só traduz a mensagem |

## Pendência conhecida

O provision usa `updateMany` seguido de `create` **sem transação**. Se o processo morrer
entre os dois, o tenant fica sem chave de agente ativa e o cliente precisa entrar de novo
— não há perda de job (os `PENDING` continuam no banco e são reenviados quando um agente
volta). Envolver em `prisma.$transaction` é uma melhoria de robustez que deixei fora
por não ter sido pedida; digo aqui para ficar registrado.
