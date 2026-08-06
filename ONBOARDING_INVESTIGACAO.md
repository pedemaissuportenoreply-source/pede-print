# pede-print — Investigação de onboarding (FASE 1)

**Data:** 2026-07-28 · **Escopo lido:** `C:\pede+\pede-print` + `pedemais-backend/pedemais/src/{realtime,api-keys,auth,print}`
**Status:** só leitura. Nada alterado.

---

## 1. Como o agente obtém a URL do backend HOJE

**Campo de texto livre na UI de configuração, persistido no `electron-store`.**

| Camada | Local | Detalhe |
|---|---|---|
| UI | `renderer/config.html:268-271` | `<input id="server-url" placeholder="http://localhost:3000">` — campo visível, digitação manual |
| Leitura do form | `renderer/config.js:349` | `serverUrl: document.getElementById('server-url').value.trim()` |
| Preenchimento | `renderer/config.js:335` | `document.getElementById('server-url').value = config.serverUrl \|\| ''` |
| Validação | `renderer/config.js:369` | `if (!config.serverUrl) { feedback('URL do servidor é obrigatória.', true); return }` |
| Persistência | `main.js:521-523` | IPC `save-config` → `store.set('config', data)` |
| Store | `main.js:5-7` | `electron-store` (default: `<userData>/config.json`), chave raiz `config` |

**Consumidores do `serverUrl`:**

| Arquivo:linha | Uso |
|---|---|
| `socket.js:53` | `io(\`${_cfg.serverUrl}/realtime\`, …)` — base do Socket.io |
| `socket.js:188` | `io(\`${url}/realtime\`)` no `validateKey()` (probe de pareamento) |
| `printer-profiles.js:97-102` | `restBase(serverUrl)` → acrescenta `/api/v1` se ainda não houver `/api/vN` |
| `printer-profiles.js:122` | `GET {base}/print-agent/printer-profiles` (catálogo) |
| `printer-profiles.js:159` | `POST {base}/print-agent/unknown-printer` |
| `main.js:182` | `pp.loadCatalog(config.serverUrl, config.apiKey)` |
| `main.js:502` | `startSocket()` aborta se `!config?.serverUrl` |

**Nada de env var para a URL.** A única env lida é `PEDE_PRINT_COM` (`main.js:143`), que é porta serial, não URL.
**Não há verificação de esquema:** o cliente pode salvar `http://` e cair em WS sem TLS sem nenhum aviso.

---

## 2. Como o agente autentica / identifica o tenant HOJE

**Por API key (`pk_live_…`) colada à mão. Não é JWT, e não existe tela de login.**

### Fluxo atual

1. Usuário gera a chave no painel web (**Configurações → Impressoras → Pede+ Print**) — texto do label em `config.html:274`.
2. Cola no campo `#token` (`config.html:275`, `type="password"`, placeholder `pk_live_...`).
3. `renderer/config.js:355-365` → IPC `validate-key` → `socket.js:173` `validateKey()` abre um socket **temporário** e resolve `{ ok, message }` pelo `connect`/`connect_error`.
4. Salva; `main.js:521` persiste `config.apiKey`.

> Há inclusive um guard de UX contra colar JWT: `config.js:41` mostra o aviso se o valor começa com `eyJ` (`config.html:276-278`: *"Parece um JWT — cole a chave gerada no painel"*).

### Conexão Socket.io `/realtime` e sala `tenant:{id}`

Cliente — `socket.js:53-61`:
```js
socket = io(`${_cfg.serverUrl}/realtime`, {
  auth: { apiKey },
  transports: ['websocket'],
  reconnection: true, reconnectionDelay: 3000,
  reconnectionAttempts: 10, randomizationFactor: 0,
})
```
Após `connect` (`socket.js:63-70`) emite `join:cozinha` e escuta `joined`.

Reconexão: 10 tentativas rápidas a 3 s (`socket.js:5-7`); no `reconnect_failed` (`socket.js:90-93`) cai num **timer lento de 30 s** (`_scheduleSlowReconnect`) que reabre a conexão indefinidamente. **Já é automática — nada a construir na Fase 5.**

Servidor — `src/realtime/realtime.gateway.ts:47-68`, middleware `server.use`:
```
apiKey (handshake.auth.apiKey OU header x-api-key)
  → apiKeysService.validate(raw)        // linha 50
  → client.data.tenantId = tenant.id    // linha 54
  → client.data.isPrintAgent = true     // linha 56  ← DECISIVO
senão
  → JWT (extractToken/verifyToken)      // linhas 60-67
  → client.data.tenantId = payload.tenantId
```

`handleConnection` (`:71-92`): `client.join(\`tenant:${tenantId}\`)`; se `isPrintAgent`, derruba agentes anteriores do mesmo tenant (**um agente por tenant**, `:78-86`) e chama `printService.onAgentConnected(tenantId, client.id)` (`:90`).
`join:cozinha` (`:154-162`) entra em `tenant:{id}:cozinha` — a sala de onde vem o `order:new` com as flags de cozinha.

### ⚠️ Achado que determina o desenho da Fase 3

**`isPrintAgent` só é setado no ramo da apiKey (`gateway:56`).** Ele governa:
- `printService.onAgentConnected/onAgentDisconnected` (`gateway:90`, `:97`) — a **fila de comprovantes** (`receipt:print` + `print:ack`);
- a desconexão de agentes duplicados.

➡️ **Se o agente passar a conectar o socket com o JWT do login, ele deixa de ser reconhecido como print agent e a fila `receipt:print` para de funcionar.** Isso violaria a não-regressão.

**Desenho correto:** login (email+senha) → JWT → **trocar o JWT por uma apiKey do agente** num endpoint novo → conectar o socket **com a apiKey, exatamente como hoje**. O socket, o gateway e a fila ficam **byte-idênticos**.

### Endpoint novo é necessário — e por quê

`api-keys.service.ts:10-11` guarda **só o hash**:
```js
const raw = 'pk_live_' + randomBytes(24).toString('hex')
const keyHash = createHash('sha256').update(raw).digest('hex')
```
`list()` (`:21-27`) devolve `{ id, name, createdAt, lastUsedAt }` — **nunca o valor bruto**. Logo **não há como recuperar** uma chave existente; só emitir uma nova.

`POST /api-keys` já existe (`api-keys.controller.ts:19-25`, guard `JwtAccessGuard`, `tenantId` via `@GetUser('tenantId')`), mas chamá-lo a cada login acumularia chaves órfãs indefinidamente.

➡️ **Um endpoint em `print-agent`** que revoga as chaves anteriores com um nome reservado e emite uma nova — idempotente por instalação. Local natural: `src/print/print-agent.controller.ts` (já concentra o que é do agente).

### Login disponível

`POST /api/v1/auth/login` (`auth.controller.ts:30-40`, `@Public()`, 200).
Retorna `{ user, tenant, accessToken, refreshToken }` (`auth.service.ts:229`) **ou** `{ requiresOtp: true, tempToken, email }` (`:218`) quando o 2FA está ativo — **o assistente precisa tratar esse segundo caso**.
`tenantSelect` (`auth.service.ts:46-61`) traz `nome, cnpj, telefone, endereco, numero, bairro, cidade, estado, cep, logoUrl` → dá para **preencher o cabeçalho do cupom automaticamente** e aposentar os 4 campos manuais de `config.html:242-261`.

---

## 3. Como o agente escolhe a impressora HOJE

**Detecção automática já existe e é boa. O que sobra de manual é a UI, não a lógica.**

### Detecção

| Camada | Local | O que faz |
|---|---|---|
| Portas seriais | `printer-profiles.js:177-197` | `SerialPort.list()` → `{ path, manufacturer, vendorId, productId, pnpId, locationId, serialNumber, profile }` |
| Match VID/PID | `printer-profiles.js:89-91` | `matchProfile()` contra o catálogo corrente |
| Auto-detect | `printer-profiles.js:203-218` | 1 match → `{ port, profile }`; 0 → `null`; 2+ → `{ candidates }` |
| USB nativa (spooler) | `printer-routing.js:40-51` | `@thiagoelg/node-printer`.`getPrinters()` — térmicas que **não** criam COM só aparecem aqui |
| Enumeração unificada | `printer-routing.js:62-96` | `detectTargets()` → serial + spooler, dedup por `deviceKey` |
| Boot | `main.js:175-243` | `autoConfigurePrinter()`: catálogo → override manual → auto VID/PID → genérico |
| Boot (roteamento) | `main.js:697` | `routing.init()` → `detectTargets` + `ensureConfig` + `logMapping` |

Filosofia registrada em `printer-routing.js:6-8`: **VID/PID nunca filtra nem exclui** — toda porta e toda impressora do spooler vira alvo; VID/PID só *sugere* o perfil.

### `deviceKey` estável — **NÃO REESCREVER**

`printer-routing.js:30-34`:
```js
function serialKey(p) {
  const id = p.pnpId || p.locationId || p.serialNumber || p.path || ''
  return 'serial:' + String(id).trim()
}
function windowsKey(name) { return 'win:' + String(name || '').trim() }
```
Precedência **pnpId → locationId → serialNumber → path**, exatamente como o brief exige. Duas impressoras idênticas geram chaves distintas porque pnpId/locationId diferem por porta.
Sobrevive à renumeração da COM pelo Windows: `reResolveTarget()` (`printer-routing.js:235-255`) reencontra o alvo pela `deviceKey` e **persiste** a porta nova; `main.js:328-341` retenta a impressão uma vez (erro de *open* ⇒ nada foi impresso ⇒ retry não duplica).

### Mapa `deviceKey → setor` persistente — **já existe**

- Arquivo: `<userData>/printers-config.json` (`printer-routing.js:27`)
- Formato: `{ version, defaultDeviceKey, printers: { [deviceKey]: { setor, profileId, kind, target, label, cortarPapel, override? } } }` (`:111-118`)
- Setores: `SETORES = ['COZINHA', 'CAIXA', 'BAR']` (`:21`)
- `ensureConfig()` (`:122-143`) cria/migra **sem apagar** o mapeamento do usuário e escolhe `targets[0]` como default se não houver.
- Roteamento: `resolveForSetor()` (`:188-211`) — **retorna `null` com ≤1 impressora**, caindo no caminho legado; `resolveDefault()` (`:216-227`) vale para qualquer quantidade.

### O que é manual hoje (o que a Fase 4 deve matar)

| Ponto | Local | Problema |
|---|---|---|
| Nome técnico como título do card | `renderer/config.js:114` | `title.textContent = t.suggestedProfileName ? \`${t.target} — ${t.suggestedProfileName}\` : t.target` → mostra **"COM7"** |
| `deviceKey` cru + VID/PID na UI | `renderer/config.js:127-130` | `meta.textContent = t.deviceKey + ' · VID/PID …'` → ruído para o cliente |
| Override de porta digitada | `main.js:139-149` | `_printerTarget()` aceita `config.comPort` = `COMx` digitado |
| Sem pré-seleção com 1 impressora | `main.js:216-222` | 2+ matches → `_activeSource = 'ambiguous'`, **exige seleção manual** |
| Sem botão de reescanear | — | `get-print-targets` re-detecta a cada chamada (`main.js:584-596`), mas **nenhum botão** na UI dispara |
| Setor/perfil expostos sempre | `renderer/config.js:143-156` | dropdowns de Setor e Perfil visíveis mesmo com 1 impressora |

**Já pronto e reaproveitável:** teste por impressora (`renderer/config.js:272-289` → IPC `test-print` em `main.js:645-661`), que já honra perfil, codepage, encoding e `cortarPapel`.

---

## 4. Bandeja / fluxo atual

| Item | Local | Estado |
|---|---|---|
| Tray | `main.js:685-689` | criado no boot; clique/duplo-clique abre config |
| Ícone por status | `main.js:34-49` | laranja `#FF6B00` conectado, cinza `#888` desconectado |
| Menu | `main.js:51-62` | status · Configurações · Reconectar · Atualizações · Sair |
| Status na UI | `main.js:73-80` → `config.js:388-393` | IPC `status-changed`, badge conectado/desconectado |
| `window-all-closed` | `main.js:707` | `e.preventDefault()` — fechar a janela **não** encerra o app |
| Gate de primeiro uso | `main.js:348-350`, `:701` | `_needsSetup()` = sem `apiKey` **ou** sem `_printerTarget()` → abre config |
| Auto-print | `main.js:485-489` | só quando `data._cozinhaAutoPrint === true`; caso contrário popup (`kitchen-prompt.js`) |

**Tray, status e reconexão automática já existem.** A Fase 5 é encadear as telas num assistente e usar o tray como destino do "Pronto" — não construir tray nem reconexão de novo.

---

## 5. Âncoras de não-regressão localizadas

| Item | Local |
|---|---|
| Auto-print só no `order:new` | `socket.js:96-115` (gate `_kitchenOnly`/`_cozinhaAutoPrint` em `:101`), `main.js:485` |
| `noCut` respeitado | `printer.js:376`, `:512`, `:767`, `:1021`, `:1110`, `:1249-1251`, `:1299-1312`; injetado em `main.js:318-320` |
| Roteamento por setor | `printer-routing.js:188-211` |
| `deviceKey` estável | `printer-routing.js:30-34` |
| `drainSafe()` | `src/serial-print.js:42`, chamado em `:100` |
| Dedup `jobKey` / vias | `main.js:84-115` (`_isDuplicate`, `_isDuplicatePago`, `_rememberJobId` cap 1000), vias em `main.js:374-381` |
| Catálogo homologado | `printer-profiles.js:24-38` (Epson TM-T20 cp860/ESC t 3; Daruma DR800 cp1252/ESC t 7 + corte `[29,86,65,0]`; Elgin i9; Bematech) |
| `brandFooter` | `printer.js:335` |
| COM + USB nativa | `printer-routing.js:62-96` |

---

## 6. Plano derivado (a implementar nas fases 2-5)

| Fase | Ação | Arquivos |
|---|---|---|
| 2 | `PROD_URL = 'https://app.pedeplus.com.br'` como constante; remover `#server-url` do fluxo normal; override dev atrás de Ctrl+Shift+D / 5 cliques na versão; forçar `https` fora do override | novo `config-defaults.js`, `main.js`, `renderer/*` |
| 3 | Tela de login email+senha → `POST /api/v1/auth/login` (tratar `requiresOtp`) → `POST /api/v1/print-agent/provision` devolve `apiKey` → socket conecta **com apiKey, como hoje**; token/apiKey no `electron-store`; botão "Sair" | novo `auth-agent.js`, `main.js`, `renderer/*`, **backend:** `print-agent.controller.ts` + `api-keys.service.ts` |
| 4 | Cards com nome legível (perfil/marca, não `COM7`); 1 impressora → pré-selecionar; 2+ → atribuir setor visualmente; botão "Reescanear" reusando `get-print-targets`; **`deviceKey` e `printers-config.json` intactos** | `renderer/*`, `main.js` (só IPC novo) |
| 5 | Assistente Entrar → Impressora → Pronto; "Pronto" esconde para o tray; status já existe | `renderer/*`, `config-window.js`, `main.js` |

**Backend:** um endpoint novo (`POST /print-agent/provision`, `JwtAccessGuard`, `tenantId` **só** do JWT) + um método no `ApiKeysService`. Nada mais é tocado — o gateway `/realtime`, a fila de impressão e o `ApiKeyGuard` ficam como estão.
