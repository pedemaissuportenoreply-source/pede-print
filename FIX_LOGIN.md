# Bug: "Resposta inesperada do servidor (sem token)" no login do pede-print

**Data:** 2026-07-28 · **Escopo lido:** backend `src/auth/*` + `src/main.ts`, frontend `src/config/api.ts`, agente `auth-agent.js` / `config-defaults.js`

---

## Causa raiz

**Eu hardcodei o host errado na Fase 2.** `config-defaults.js` tem
`PROD_URL = 'https://app.pedeplus.com.br'`, que é o host do **frontend (SPA)**.
O backend REST/WS de produção é **`https://api.pedeplus.com.br`**.

Confirmado em `pedemais-frontend/src/config/api.ts:6-7`:

```ts
const PUBLIC_API_ORIGIN =
  (import.meta.env.VITE_PUBLIC_API_ORIGIN as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://api.pedeplus.com.br';
```

e `:59-63` — em domínio público **tanto** `API_URL` **quanto** `WS_URL` saem de
`backendOrigin()`, isto é, `api.pedeplus.com.br`. O `app.pedeplus.com.br` só serve o SPA.

### Como isso produz exatamente a mensagem "sem token"

1. `restBase('https://app.pedeplus.com.br')` → `https://app.pedeplus.com.br/api/v1`
2. `POST https://app.pedeplus.com.br/api/v1/auth/login` cai no **servidor estático do
   frontend**, que responde o SPA — `200 OK` com `Content-Type: text/html`.
3. Em `auth-agent.js`, `_post()` faz `try { data = await res.json() } catch {}` → o parse
   do HTML falha → **`data = null`**, mas `res.ok` é **`true`** (é um 200!).
4. `login()` não vê `!r.ok`, não vê `requiresOtp`, e chama `_afterTokens(url, null)`.
5. `_afterTokens` faz `data && data.accessToken` → `null` → retorna
   **"Resposta inesperada do servidor (sem token)"**.

Ou seja: o login nunca chegou ao backend. A mensagem estava tecnicamente correta e
completamente inútil — escondeu um erro de roteamento atrás de um erro de contrato.

> Efeito colateral do mesmo bug: o **socket** também apontava para
> `app.pedeplus.com.br/realtime` e nunca conectaria. Só não apareceu porque o login
> falha antes.

---

## FASE 1 — Contrato real do backend

### `POST /api/v1/auth/login`

`auth.controller.ts:30-40` → `auth.service.ts:login()`. Corpo: `LoginDto` = `{ email, senha }`
(`auth.dto.ts:23-29`). Header opcional: `x-device-fingerprint`.

**Ramo A — sucesso (`auth.service.ts:229`):**

```js
return { user: safeUser, tenant, ...tokens }   // tokens = { accessToken, refreshToken }
```

`generateTokens` (`:897-914`) devolve **`{ accessToken, refreshToken }`** — camelCase.
Mas o `AuthCookieInterceptor` global (`auth-cookie.interceptor.ts:62-77`) intercepta
qualquer resposta com `refreshToken: string`, move o valor para o cookie HttpOnly
`refresh_token`, cria o cookie `csrf_token` e **remove `refreshToken` do corpo**.

➡️ **Shape que chega no cliente:**

```json
{ "user": { … }, "tenant": { … }, "accessToken": "eyJ…" }
```

| Pergunta | Resposta |
|---|---|
| Nome do campo do token | **`accessToken`** (camelCase) |
| Topo ou aninhado? | **Topo.** Sem `data`, sem `tokens` |
| Refresh vem junto? | **Não** — vira cookie HttpOnly, removido do corpo |
| user/tenant vêm? | **Sim**, ambos no topo. `tenant` traz `nome/cnpj/telefone/endereco/…` (`tenantSelect`, `:46-61`) |

➡️ **`data.accessToken` do agente já estava correto.** O bug não era o nome do campo.

**Ramo B — 2FA (`auth.service.ts:218`):**

```js
return { requiresOtp: true, tempToken, email: maskedEmail }
```

Status **200**, com o e-mail **mascarado**. `tempToken` é um `crypto.randomUUID()` com
validade de 10 min (`:210`).

**Gate do 2FA — detalhe decisivo (`auth.service.ts:198`):**

```js
if (fingerprint && !bypassOtp) { … checa dispositivoConfiavel … }
```

O 2FA **só é avaliado quando a request envia `x-device-fingerprint`**. O agente **não
enviava esse header**, então mesmo num tenant com 2FA ativo o login ia direto pro
Ramo A. Consequência: a tela de código que construí na fase anterior era **código morto**.

### `POST /api/v1/auth/verify-otp`

`VerifyOtpDto` (`auth.dto.ts:70-79`): `{ tempToken, code, fingerprint }` — **os três
obrigatórios** (`@IsString()`).
`auth.service.ts:256-272`: com `fingerprint` presente, faz `upsert` em
`dispositivoConfiavel` com validade de **30 dias** → o próximo login com o mesmo
fingerprint **não pede código**.
Retorno (`:280`): **idêntico ao Ramo A** — `{ user, tenant, accessToken }` (refresh vira cookie).

Erros: código errado → **401** com contagem de tentativas restantes (máx. 5);
expirado/inexistente → 401 `'Código inválido ou expirado'`.

### `POST /api/v1/auth/resend-otp`

`ResendOtpDto` = `{ tempToken }`. Invalida o OTP anterior e emite outro; limite de
**3 reenvios** (`:289`), depois `400 'Limite de reenvios atingido'`.

---

## FASE 1 — Onde o agente lia o token

| Local | Código | Veredito |
|---|---|---|
| `auth-agent.js` `_afterTokens()` | `const accessToken = data && data.accessToken` | ✅ **correto** — casa com o contrato |
| `auth-agent.js` `login()` | corpo `{ email, senha }` | ✅ correto (`forbidNonWhitelisted` exige exatidão) |
| `auth-agent.js` `login()` | **não envia `x-device-fingerprint`** | ❌ 2FA nunca dispara |
| `auth-agent.js` `_post()` | `try { data = await res.json() } catch {}` sem checar content-type | ❌ engole resposta HTML e vira "sem token" |
| `config-defaults.js` | `PROD_URL = 'https://app.pedeplus.com.br'` | ❌ **causa raiz** — host do SPA, não da API |

**Divergência exata:** não é nome de campo nem aninhamento. É **host errado** — a
requisição ia para o frontend. O tratamento de erro do agente é o cúmplice: mascarou
"recebi HTML de outro serviço" como "faltou token".

---

## FASE 2 — Correções (só no pede-print)

### 1. Host de produção correto — `config-defaults.js`

```diff
-const PROD_URL = 'https://app.pedeplus.com.br'
+const PROD_URL = 'https://api.pedeplus.com.br'
```

Corrige o login **e** o socket `/realtime` de uma vez.

### 2. Enviar o fingerprint no login — `auth-agent.js` + `main.js`

`login()` passou a aceitar `fingerprint` e o envia como header `x-device-fingerprint`
(o mesmo `deviceFingerprint()` já usado no `verify-otp`). Com isso:

- 1ª entrada nesta máquina → backend devolve `requiresOtp` → tela do código → `verify-otp`
  registra o dispositivo por 30 dias;
- entradas seguintes → sem código.

O caminho de OTP deixou de ser código morto e passou a ser o fluxo real de quem tem 2FA.

### 3. Não confundir "resposta de outro serviço" com "sem token" — `auth-agent.js`

`_post()` agora devolve `contentType` e um trecho do corpo cru. Erros distintos:

| Situação | Mensagem |
|---|---|
| Resposta não-JSON (HTML do SPA, proxy, captive portal) | "O endereço configurado não é o servidor do Pede+ (respondeu HTML em vez de dados). Verifique a URL em Configurações avançadas." |
| 200 JSON mas sem `accessToken` e sem `requiresOtp` | "O servidor respondeu sem token de acesso (campos: user, tenant)." — lista as chaves recebidas |
| 401 | "E-mail ou senha incorretos." |
| 402/403 `SUBSCRIPTION_EXPIRED` | "A assinatura do restaurante está vencida…" |
| 429 | "Muitas tentativas…" |
| 5xx | "O servidor do Pede+ está indisponível…" |
| rede/timeout | "Não foi possível conectar ao servidor: …" / "Tempo esgotado…" |

Nenhum ramo cai mais num "sem token" genérico.

### 4. Provision intacto

`POST /print-agent/provision` só roda **depois** de haver `accessToken`, exatamente como
antes. Nada mudou no provision, na apiKey, no socket por apiKey, em `isPrintAgent`/
`onAgentConnected`, na fila `receipt:print`/`print:ack`, na detecção de impressora ou no
`deviceKey`.

---

## Validação

```
node --check config-defaults.js  → OK
node --check auth-agent.js       → OK
node --check main.js             → OK
resolveServerUrl: 13 casos       → produção = https://api.pedeplus.com.br
```

**Backend: nenhum arquivo tocado** — só leitura do contrato, como esperado.
