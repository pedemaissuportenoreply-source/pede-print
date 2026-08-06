'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage } = require('electron')
const path = require('path')
const Store = require('electron-store')

const store = new Store()
const { createSocket, reconnect: reconnectSocket, cleanup: cleanupSocket, emitToServer, validateKey } = require('./socket')
const { openConfigWindow, getConfigWindow, hideConfigWindow } = require('./config-window')
const { showKitchenPrompt } = require('./kitchen-prompt')
const { initUpdater, checkForUpdatesNow } = require('./updater')
const routing = require('./printer-routing')
const queue = require('./print-queue')
const defaults = require('./config-defaults')
const agentAuth = require('./auth-agent')

// URL efetiva do backend. O cliente NUNCA digita isso: é a de produção, em https,
// salvo override de dev (config.devMode + config.devServerUrl). Toda leitura de
// serverUrl passa por aqui — nada mais lê config.serverUrl direto.
function serverUrl(config) {
  return defaults.resolveServerUrl(config || store.get('config') || {})
}

// Config com o serverUrl resolvido — é o que socket.js e printer-profiles.js
// consomem, sem saber se veio de produção ou do override de dev.
function effectiveConfig() {
  const config = store.get('config') || {}
  return { ...config, serverUrl: serverUrl(config) }
}

// Id estável desta instalação (o VerifyOtpDto exige fingerprint). Gerado uma vez
// e guardado no store — não identifica o usuário, só o computador.
function deviceFingerprint() {
  let fp = store.get('deviceFingerprint')
  if (!fp) {
    fp = 'pede-print-' + require('crypto').randomBytes(16).toString('hex')
    store.set('deviceFingerprint', fp)
  }
  return fp
}

let tray = null
let currentStatus = 'disconnected'

// Pedidos aguardando confirmação de impressão da cozinha (auto-print desligado).
const _pendingKitchen = new Map()
let _kitchenSeq = 0

// Largura padrão única do cupom (80mm = 48 colunas)
const DEFAULT_COLS = 48

// Single instance
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => openConfigWindow())

// ─── Tray icon ────────────────────────────────────────────────────────────────

function makeTrayIcon(connected) {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  // Orange (#FF6B00) when connected, gray (#888) when not
  const r = connected ? 0xFF : 0x88
  const g = connected ? 0x6B : 0x88
  const b = 0x00
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    buf[o]     = b    // BGRA on Windows
    buf[o + 1] = g
    buf[o + 2] = r
    buf[o + 3] = 0xFF
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function buildTrayMenu() {
  const statusLabel = currentStatus === 'connected' ? '● Conectado' : '● Desconectado'
  const cfg = store.get('config') || {}
  const items = [{ label: `Pede+ Print  —  ${statusLabel}`, enabled: false }]
  // Conta conectada SEMPRE visível na bandeja: sem isso não dava para saber em
  // qual estabelecimento este computador está pareado.
  const quem = cfg.estabelecimento || cfg.tenantName
  if (quem) items.push({ label: `Conectado em: ${quem}`, enabled: false })
  // Pendências: o que está na fila (sai sozinho quando a impressora voltar) e o
  // que venceu o TTL (só sai por reimpressão manual daqui).
  const pend = queue.pendingAll()
  const venc = queue.expiredAll()
  if (pend.length || venc.length) {
    items.push({ type: 'separator' })
    if (pend.length) {
      items.push({ label: `Na fila: ${pend.length} recibo(s) aguardando a impressora`, enabled: false })
      items.push({ label: 'Tentar imprimir agora', click: () => { void drainPending('bandeja') } })
    }
    if (venc.length) {
      items.push({
        label: `Não impressos: ${venc.length}`,
        submenu: venc.map((j) => ({
          label: `Reimprimir #${j.code ?? '?'} — ${j.label || ''}`,
          click: () => { void reprintExpired(j.id) },
        })),
      })
    }
  }
  items.push(
    { type: 'separator' },
    { label: cfg.apiKey ? 'Abrir' : 'Configurar', click: () => openConfigWindow() },
    { label: 'Reconectar',    click: () => startSocket() },
    { label: 'Trocar conta',  click: () => { openConfigWindow(); void trocarConta() } },
    { label: 'Verificar atualizações', click: () => checkForUpdatesNow() },
    { type: 'separator' },
    { label: 'Sair',          click: () => app.quit() },
  )
  return Menu.buildFromTemplate(items)
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return
  const cfg = store.get('config') || {}
  const who = cfg.tenantName ? ` · ${cfg.tenantName}` : ''
  tray.setImage(makeTrayIcon(currentStatus === 'connected'))
  tray.setToolTip(`Pede+ Print — ${currentStatus === 'connected' ? 'Conectado' : 'Desconectado'}${who}`)
  tray.setContextMenu(buildTrayMenu())
}

// ─── Status / broadcast ───────────────────────────────────────────────────────

function handleStatusChange(status) {
  const antes = currentStatus
  currentStatus = status
  refreshTray()
  // Reconectou: boa hora pra tentar drenar o que ficou pendente offline.
  if (status === 'connected' && antes !== 'connected') void drainPending('reconexão')
  const win = getConfigWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('status-changed', status)
  }
}

// ─── Print events ─────────────────────────────────────────────────────────────

const _printedIds     = new Set()
const _paidPrintedIds = new Set()
const _printedJobIds  = new Set() // idempotência por jobId da fila nova (cinturão de segurança)
const _MAX_PRINTED_JOB_IDS = 1000 // cap FIFO: evita crescimento ilimitado em uptime longo
// Insere jobId protegendo contra duplicata e descartando o mais antigo ao estourar o cap.
// Set preserva ordem de inserção => o primeiro do iterador é o mais antigo.
function _rememberJobId(jobId) {
  _printedJobIds.add(jobId)
  while (_printedJobIds.size > _MAX_PRINTED_JOB_IDS) {
    _printedJobIds.delete(_printedJobIds.values().next().value)
  }
}

function _isDuplicate(data) {
  const ids = [data?.id, data?.numeroPedido, data?.code, data?.orderCode]
    .filter((value) => value != null && String(value).trim() !== '')
    .map((value) => String(value))
  if (ids.length === 0) return false
  if (ids.some((id) => _printedIds.has(id))) return true
  ids.forEach((id) => _printedIds.add(id))
  setTimeout(() => ids.forEach((id) => _printedIds.delete(id)), 30_000)
  return false
}

function _isDuplicatePago(data) {
  const key = String(data?.id ?? data?.numeroPedido ?? data?.code ?? data?.orderCode ?? '').trim()
  if (!key) return false
  if (_paidPrintedIds.has(key)) return true
  _paidPrintedIds.add(key)
  setTimeout(() => _paidPrintedIds.delete(key), 30_000)
  return false
}

// Inclui status em PT (backend) e EN (orders module)
const PRINT_STATUSES = new Set([
  'PENDENTE', 'PREPARO', 'CONFIRMADO',
  'PREPARING', 'IN_PROGRESS', 'SENT', 'CONFIRMED',
])

function _getPrintStatus(data) {
  const raw = data?.status ?? data?.orderStatus ?? data?.pedidoStatus ?? data?.situacao
  return raw == null ? '' : String(raw).toUpperCase()
}

// Estado da autoconfiguração (preenchido por autoConfigurePrinter no boot).
let _autoPort = null          // porta auto-detectada por VID/PID
let _appliedProfile = null    // perfil RUNTIME aplicado (do catálogo)
let _activeSource = null      // como o perfil foi escolhido (auto-vidpid|generic-fallback|manual|manual+vidpid|ambiguous)
let _catalogSource = null     // de onde veio o catálogo (backend|cache|seed)

// Resolve o alvo de impressão. Prioridade:
//   1) override manual explícito: config.comPort = COMx (e != 'AUTO')
//   2) porta auto-detectada por VID/PID (_autoPort)
//   3) env PEDE_PRINT_COM (fallback configurável)
//   4) printerName (spooler do Windows)
function _printerTarget(config) {
  const manual = String(config.comPort || '').trim().toUpperCase()
  if (manual && manual !== 'AUTO' && /^COM\d{1,2}$/.test(manual)) return manual
  if (_autoPort && /^COM\d{1,2}$/.test(_autoPort)) return _autoPort
  const env = String(process.env.PEDE_PRINT_COM || '').trim().toUpperCase()
  if (/^COM\d{1,2}$/.test(env)) return env
  if (config.printerName) return config.printerName
  // Surface única: sem campos globais, o alvo vem do device PADRÃO do printers-config.
  try { const d = routing.resolveDefault(); if (d && d.target) return d.target } catch { /* ignore */ }
  return ''
}

// Resumo do que foi aplicado — enviado pra UI de configuração refletir.
function _appliedInfo() {
  return {
    source: _activeSource,
    catalogSource: _catalogSource,
    port: _autoPort || null,
    profile: _appliedProfile && {
      name: _appliedProfile.name, brand: _appliedProfile.brand,
      vendorId: _appliedProfile.vendorId, productId: _appliedProfile.productId,
      encoding: _appliedProfile.encoding, codepageEscT: _appliedProfile.codepageEscT,
      columns: _appliedProfile.columns, isGeneric: _appliedProfile.isGeneric,
    },
  }
}
function _reportConfigToUI() {
  try {
    const win = getConfigWindow()
    if (win && !win.isDestroyed()) win.webContents.send('printer-applied', _appliedInfo())
  } catch { /* janela fechada — ignora */ }
}

// Descoberta AUTÔNOMA no startup: carrega catálogo (backend>cache>seed), detecta
// porta por VID/PID, aplica o perfil (encoding/codepage/cut/cols) e usa genérico
// como fallback. Override manual continua tendo prioridade.
async function autoConfigurePrinter() {
  const config = effectiveConfig()
  const manual = String(config.comPort || '').trim().toUpperCase()
  const pp = require('./printer-profiles')
  const { setActiveProfile } = require('./printer')

  // 1) Catálogo de perfis: backend (x-api-key) > cache local > seed embarcado.
  const cat = await pp.loadCatalog(config.serverUrl, config.apiKey)
  _catalogSource = cat.source

  // 2) Override manual explícito (COMx e != AUTO): respeita a porta; tenta casar
  // o perfil por VID/PID dessa porta; senão segue a config do usuário.
  if (manual && manual !== 'AUTO' && /^COM\d{1,2}$/.test(manual)) {
    _activeSource = 'manual'
    try {
      const ports = await pp.listSerialPorts()
      const hit = ports.find((p) => String(p.path).toUpperCase() === manual && p.profile)
      if (hit) {
        _appliedProfile = hit.profile; setActiveProfile(hit.profile); _activeSource = 'manual+vidpid'
        console.log(`[printer] MANUAL ${manual} | perfil: ${hit.profile.name} (VID/PID do catálogo)`)
      } else {
        console.log(`[printer] MANUAL ${manual} | perfil: config do usuário (VID/PID não reconhecido)`)
      }
    } catch { console.log(`[printer] MANUAL ${manual}`) }
    _reportConfigToUI()
    return
  }

  // 3) Auto-detect por VID/PID.
  let result = null
  try { result = await pp.detectPrinterPort() } catch (e) { console.warn('[printer] auto-detect falhou:', e?.message || e) }

  if (result && result.port) {
    _autoPort = result.port; _appliedProfile = result.profile; _activeSource = 'auto-vidpid'
    setActiveProfile(result.profile)
    console.log(`[printer] AUTO-CONFIG | porta: ${result.port} | perfil: ${result.profile.name} | motivo: match VID/PID | catálogo: ${_catalogSource}`)
    _reportConfigToUI()
    return
  }

  // 2+ matches: não escolhe sozinho — mantém seleção manual.
  if (result && Array.isArray(result.candidates)) {
    _activeSource = 'ambiguous'
    console.warn('[printer] múltiplas impressoras detectadas — seleção manual necessária:',
      result.candidates.map((c) => `${c.profile.name}@${c.port}`).join(', '))
    _reportConfigToUI()
    return
  }

  // 0 matches: aplica genérico (fallback) e reporta VID/PIDs desconhecidos.
  const generic = pp.genericProfile()
  if (generic) {
    _appliedProfile = generic; setActiveProfile(generic); _activeSource = 'generic-fallback'
    console.log(`[printer] FALLBACK genérico: ${generic.name} | catálogo: ${_catalogSource} | motivo: nenhum VID/PID reconhecido`)
  }
  try {
    const ports = await pp.listSerialPorts()
    for (const prt of ports.filter((p) => !p.profile && (p.vendorId || p.productId))) {
      void pp.reportUnknown(config.serverUrl, config.apiKey, {
        vendorId: prt.vendorId, productId: prt.productId,
        rawDeviceInfo: `${prt.manufacturer || ''} ${prt.path}`.trim(),
      })
    }
  } catch { /* ignore */ }
  const fallback = _printerTarget(config)
  if (fallback) console.warn(`[printer] alvo de porta: ${fallback} (perfil genérico). Ajuste manual disponível na config.`)
  else console.warn('[printer] sem porta — aguardando seleção do usuário na janela de configuração.')
  _reportConfigToUI()
}

// Parâmetros ESC/POS por job. Em AUTO (catálogo) o perfil aplicado manda; em
// modo manual/override a config salva do usuário tem prioridade.
function _printOpts(config) {
  if ((_activeSource === 'auto-vidpid' || _activeSource === 'generic-fallback') && _appliedProfile) {
    return { encoding: _appliedProfile.encoding, codepage: _appliedProfile.codepageEscT }
  }
  return { encoding: config.encoding, codepage: config.codepage }
}

// Largura de colunas: tenant > config local > perfil aplicado > default.
function _cols(data, config) {
  return data._receiptOpts?.larguraColunas
    || config.balcaoCols
    || (_appliedProfile && _appliedProfile.columns)
    || DEFAULT_COLS
}

// Despacho ÚNICO de impressão com ROTEAMENTO por setor. Com 2+ impressoras
// detectadas e mapeadas, acha o alvo do setor (perfil próprio) e imprime nele.
// Com <=1 impressora (ou sem mapeamento/sem setor) cai no caminho LEGADO —
// idêntico ao comportamento atual de tenant com uma única impressora.
// "Porta sumiu": abertura da COM falhou porque o device não existe (impressora
// desconectada ou COM renumerada pelo Windows). É um erro de OPEN — nada foi
// enviado, então re-resolver + retentar é seguro (não duplica impressão).
function _isPortMissing(err) {
  const code = err && err.code
  const msg = String((err && err.message) || err || '')
  return code === 'ENOENT'
    || /File not found|cannot find|no such (file|device)|does not exist|ENOENT/i.test(msg)
}

// "Impressora offline": porta sumiu, device não abre, spooler diz que não dá.
// É o critério para ENFILEIRAR em vez de descartar o job.
function _isOffline(err) {
  if (_isPortMissing(err)) return true
  const code = err && err.code
  const msg = String((err && err.message) || err || '')
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENXIO'
    || code === 'ETIMEDOUT' || code === 'ENODEV'
    || /EPERM|EBUSY|EACCES|ENXIO|ETIMEDOUT|ENODEV/i.test(msg)
    || /offline|desligad|desconectad|indispon[ií]vel|n[aã]o (est[aá] )?dispon|not available|unavailable|access is denied|acesso negado|falha ao abrir|cannot open/i.test(msg)
}

// TTL das pendências (minutos) — configurável no store, default 15 min.
function _ttlMs() {
  const min = Number((store.get('config') || {}).pendingTtlMin)
  return Number.isFinite(min) && min > 0 ? min * 60_000 : queue.DEFAULT_TTL_MS
}

// Enriquece o erro de impressão com setor + impressora + porta tentada, e dá a
// orientação de como confirmar/reapontar a COM quando a porta não existe.
function _enrichPrintError(err, ctx) {
  const reason = (err && err.message) || String(err)
  const onde = ctx.setor ? `setor ${String(ctx.setor).toUpperCase()}` : 'impressora padrão'
  const quem = ctx.label ? `"${ctx.label}"` : (ctx.target || 'impressora')
  const porta = ctx.target || '(desconhecida)'
  const dica = _isPortMissing(err)
    ? ` — a porta ${porta} não existe (impressora desligada/desconectada ou COM renumerada pelo Windows).`
      + ` Confira em Gerenciador de Dispositivos > Portas (COM e LPT) e reaponte o setor nas configurações do agente.`
    : ''
  const e = new Error(`${onde} · ${quem} · porta ${porta}: ${reason}${dica}`)
  e.cause = err
  return e
}

// jobKey do dedup: jobId da fila > código do pedido > id. Com a via, forma
// `jobKey:viaN` — a unidade que não pode sair duas vezes na mesma impressora.
function _jobKey(data) {
  return String(data?.jobId ?? data?.orderCode ?? data?.code ?? data?.numeroPedido ?? data?.id ?? '?').trim()
}

// Fan-out: imprime em TODAS as impressoras ATIVAS cujo setor casa com o job.
// Falha por impressora OFFLINE não descarta o job: vira PENDÊNCIA em disco
// (drenada quando aquele deviceKey voltar). Só propaga erro se nenhuma imprimiu
// NEM foi enfileirada — assim o backend não reenvia e duplica na que funcionou.
async function _printRouted(enriched, data, config, setor, via) {
  // Alvos ESPERADOS vêm da CONFIG ativa (não da presença): impressora desligada
  // continua sendo alvo do setor — vira pendência em vez de sumir do roteamento.
  let routedList = []
  try {
    routedList = routing.expectedForSetor(setor) || []
  } catch (e) { console.warn('[routing] resolve falhou:', e?.message || e) }

  if (!routedList.length) {
    let d = null
    try { d = routing.resolveDefault() } catch { /* ignore */ }
    if (d && d.target) routedList = [{ ...d, present: true }]
  }

  // Fallback final (sem nenhum device resolvido): porta/perfil/cols legados.
  if (!routedList.length) {
    console.warn(`[routing] job setor=${setor || '(none)'} sem alvo esperado na config — caminho legado`)
    return _printLegacy(enriched, data, config, setor)
  }

  const dedup = queue.dedupKey(_jobKey(data), via || 1)
  const presentes = routedList.filter((r) => r.present !== false)
  const ausentes = routedList.filter((r) => r.present === false)
  console.log(`[routing] job ${dedup} | setor=${setor || '(none)'} | esperados: ${routedList.map((r) => r.deviceKey).join(', ')}`
    + ` | presentes: ${presentes.map((r) => r.deviceKey).join(', ') || '(nenhuma)'}`
    + ` | ausentes: ${ausentes.map((r) => r.deviceKey).join(', ') || '(nenhuma)'}`)

  const erros = []
  let ultimo = null
  let sucessos = 0
  let enfileirados = 0

  // Ausente no envio: não tenta escrever (não há porta) — enfileira direto.
  for (const routed of ausentes) {
    console.warn(`[routing] ${routed.deviceKey} (${routed.label}) AUSENTE no envio -> enfileirou`)
    if (_enqueuePending(routed, enriched, data, setor, dedup)) enfileirados++
  }

  for (const routed of presentes) {
    try {
      ultimo = await _printOne(routed, enriched, data, config, setor)
      queue.markPrinted(queue.mark(dedup, routed.deviceKey))
      console.log(`[routing] ${routed.deviceKey} -> imprimiu`)
      sucessos++
    } catch (err) {
      // Offline no meio da escrita (presente mas caiu): guarda pra quando voltar.
      if (_isOffline(err) && _enqueuePending(routed, enriched, data, setor, dedup)) {
        console.warn(`[routing] ${routed.deviceKey} falhou offline no envio -> enfileirou`)
        enfileirados++
        continue
      }
      erros.push(err)
      console.error(`[routing] falha em ${routed.deviceKey} (${routed.target}):`, err.message || err)
    }
  }
  if (!sucessos && !enfileirados) throw erros[0] || new Error('Nenhuma impressora ativa respondeu.')
  if (erros.length) {
    new Notification({ title: 'Pede+ Print — Impressora com erro', body: erros[0].message || String(erros[0]) }).show()
  }
  return ultimo
}

// Guarda o job pendente daquela impressora + avisa o cliente. Retorna false se
// já estava na fila/impresso (nada a fazer, mas o job também não se perdeu).
function _enqueuePending(routed, enriched, data, setor, dedup) {
  let res = 'dup'
  try {
    res = queue.enqueue({
      deviceKey: routed.deviceKey,
      dedup,
      label: routed.label || routed.target,
      setor: setor || null,
      jobId: data?.jobId ?? null,
      code: data?.orderCode ?? data?.code ?? data?.numeroPedido ?? null,
      enriched,
      receiptOpts: data?._receiptOpts || null,
      ttlMs: _ttlMs(),
    })
  } catch (e) {
    console.warn('[queue] falha ao enfileirar pendência:', e?.message || e)
    return false
  }
  if (res === 'queued') {
    const code = data?.orderCode ?? data?.code ?? data?.numeroPedido ?? '?'
    console.warn(`[queue] ${routed.deviceKey} offline — job #${code} (${dedup}) na fila de pendências`)
    new Notification({
      title: 'Pede+ Print — Impressora offline',
      body: `${routed.label || routed.target} está offline. Recibo #${code} ficou na fila e sai quando ela voltar.`,
    }).show()
    refreshTray()
  }
  return true
}

async function _printLegacy(enriched, data, config, setor) {
  const { printCupom } = require('./printer')
  const legacyTarget = _printerTarget(config)
  try {
    return await printCupom(enriched, legacyTarget, _cols(data, config), _printOpts(config))
  } catch (err) {
    throw _enrichPrintError(err, { setor, label: config.printerName || legacyTarget, target: legacyTarget, deviceKey: null })
  }
}

async function _printOne(routed, enriched, data, config, setor) {
  const { printCupom } = require('./printer')
  // Per-impressora manda: tenant > perfil/override do card > default.
  const cols = data._receiptOpts?.larguraColunas
    || (routed.profile && routed.profile.columns) || config.balcaoCols || DEFAULT_COLS
  const opts = routed.profile
    ? { encoding: routed.profile.encoding, codepage: routed.profile.codepageEscT, profile: routed.profile }
    : _printOpts(config)
  // Corte por impressora: cortarPapel=false suprime GS V (Epson/i9) / ESC m (Daruma)
  // no rodapé, mantendo o feed final (ver noCut em printer.js).
  if (routed.cortarPapel === false) {
    enriched = { ...enriched, _receiptOpts: { ...(enriched._receiptOpts || {}), noCut: true } }
  }
  console.log(`[routing] setor=${setor || '(none)'} -> ${routed.deviceKey} (${routed.kind}:${routed.target}) | perfil: ${routed.profile ? routed.profile.name : '(default)'} | corte: ${routed.cortarPapel === false ? 'OFF' : 'on'}`)
  try {
    return await printCupom(enriched, routed.target, cols, opts)
  } catch (err) {
    // Porta serial não abriu? Re-resolve pela device key estável (pnpId/locationId)
    // e retenta UMA vez na porta atual (a COM pode ter renumerado). Erro de open =>
    // nada foi impresso, retry não duplica.
    if (_isPortMissing(err) && routed.kind === 'serial' && routed.deviceKey) {
      let fresh = null
      try { fresh = await routing.reResolveTarget(routed.deviceKey) }
      catch (e) { console.warn('[routing] re-resolve falhou:', e?.message || e) }
      if (fresh && fresh.target && fresh.target !== routed.target) {
        console.warn(`[routing] porta ${routed.target} sumiu; re-resolvida p/ ${fresh.target} (deviceKey ${routed.deviceKey}). Retentando.`)
        try {
          const res = await printCupom(enriched, fresh.target, cols, opts)
          new Notification({ title: 'Pede+ Print', body: `Porta da impressora ${fresh.label || ''} mudou para ${fresh.target} — impressão concluída` }).show()
          return res
        } catch (err2) {
          throw _enrichPrintError(err2, { setor, label: fresh.label || routed.label, target: fresh.target, deviceKey: routed.deviceKey })
        }
      }
    }
    throw _enrichPrintError(err, { setor, label: routed.label, target: routed.target, deviceKey: routed.deviceKey })
  }
}

// ─── Fila de pendências: dreno + vigia da volta da impressora ─────────────────

let _drainTimer = null
let _draining = false

// Imprime UM pendente na sua impressora (re-resolvida agora: porta/perfil/corte
// atuais). `force` ignora o TTL — é o caminho da reimpressão manual.
async function _printPending(job, force) {
  const config = effectiveConfig()
  const m = queue.mark(job.dedup, job.deviceKey)
  if (!force && queue.isPrinted(m)) {
    console.log('[queue] pendente já impresso (dedup', m + ') — descartado')
    queue.removeById(job.id)
    return false
  }
  const routed = routing.resolveByKey(job.deviceKey)
  if (!routed || !routed.target) throw new Error('Impressora ainda não disponível.')
  const data = { ...(job.enriched || {}), _receiptOpts: job.receiptOpts || job.enriched?._receiptOpts || null }
  // noCut/cols saem de routed + _receiptOpts dentro de _printOne — igual ao vivo.
  await _printOne(routed, job.enriched, data, config, job.setor)
  queue.markPrinted(m) // remove o próprio pendente também
  queue.removeById(job.id)
  return true
}

// Drena as pendências das impressoras PRESENTES agora. TTL vencido não imprime
// sozinho: vira "recibo não impresso" com reimpressão manual pela bandeja.
async function drainPending(reason) {
  if (_draining || !queue.hasPending()) return
  _draining = true
  try {
    let targets = []
    try { targets = await routing.detectTargets() } catch (e) { console.warn('[queue] detect falhou:', e?.message || e); return }
    routing.setTargets(targets)
    const presentes = new Set(targets.map((t) => t.deviceKey))
    const now = Date.now()
    let ok = 0
    const expirados = []

    for (const job of queue.pendingAll()) {
      if (queue.isExpired(job, now)) {
        queue.expire(job)
        expirados.push(job)
        continue
      }
      if (!presentes.has(job.deviceKey)) continue
      try {
        if (await _printPending(job, false)) ok++
      } catch (err) {
        console.warn(`[queue] dreno falhou p/ ${job.deviceKey}:`, err?.message || err)
      }
    }

    if (ok) {
      console.log(`[queue] dreno (${reason}): ${ok} pendente(s) impresso(s)`)
      new Notification({
        title: 'Pede+ Print',
        body: ok === 1 ? 'Impressora voltou — recibo impresso.' : `Impressora voltou — ${ok} recibos impressos.`,
      }).show()
    }
    for (const job of expirados) {
      console.warn(`[queue] pendente EXPIRADO (TTL): #${job.code ?? '?'} em ${job.label}`)
      const n = new Notification({
        title: 'Pede+ Print — Recibo não impresso',
        body: `O recibo #${job.code ?? '?'} passou do tempo e não foi impresso automaticamente. Clique para reimprimir agora.`,
      })
      n.on('click', () => { void reprintExpired(job.id) })
      n.show()
    }
    if (ok || expirados.length) refreshTray()
  } finally {
    _draining = false
  }
}

// Reimpressão MANUAL de um expirado (bandeja/notificação): ignora o TTL.
async function reprintExpired(id) {
  const job = queue.takeExpired(id)
  if (!job) return
  try {
    let targets = []
    try { targets = await routing.detectTargets() } catch { /* usa os atuais */ }
    if (targets.length) routing.setTargets(targets)
    await _printPending({ ...job, id: job.id }, true)
    new Notification({ title: 'Pede+ Print', body: `Recibo #${job.code ?? '?'} reimpresso.` }).show()
  } catch (err) {
    queue.expire(job) // volta pra lista de não impressos p/ nova tentativa
    new Notification({ title: 'Pede+ Print — Erro ao reimprimir', body: err?.message || String(err) }).show()
  }
  refreshTray()
}

// Vigia da volta: sem evento de device add no Electron, redetecta periodicamente
// enquanto houver pendência (o dreno em si já valida se a impressora abriu).
function startPendingWatcher() {
  if (_drainTimer) return
  _drainTimer = setInterval(() => { void drainPending('watcher') }, 20_000)
  if (_drainTimer.unref) _drainTimer.unref()
}

// Setup precisa abrir no primeiro uso: sem chave OU sem impressora configurada.
function _needsSetup(config) {
  return !config || !config.apiKey || !_printerTarget(config)
}

function _tenantEnrich(data, config) {
  return {
    ...data,
    tenantName:    config.tenantName    || data.tenantName    || 'ESTABELECIMENTO',
    tenantAddress: config.tenantAddress || data.tenantAddress || null,
    tenantPhone:   config.tenantPhone   || data.tenantPhone   || null,
    tenantCnpj:    config.tenantCnpj    || data.tenantCnpj    || null,
    _logoSource:   config.logoPath || data.tenantLogoUrl || data.logoUrl || data.logo_url
      || data.tenantLogo || data.tenant?.logoUrl || data.tenant?.logo || null,
    // default false; só liga via toggle local. Config do tenant pode FORÇAR off.
    _logoEnabled:  config.logoEnabled === true && data._receiptOpts?.exibirLogo !== false,
  }
}

// Rotina ÚNICA de impressão da comanda da cozinha (silenciosa, serial/spooler).
// Usada tanto pelo auto-print quanto pelo botão "Imprimir" do popup próprio.
function runKitchenPrint(data, config) {
  const printType = 'kitchen'
  // Largura: tenant > config local > perfil aplicado > default.
  const cols = _cols(data, config)
  const code = data.orderCode || data.code || data.numeroPedido || '?'
  const enriched = _tenantEnrich({ ...data, _printType: printType }, config)
  const vias = Math.min(3, Math.max(1, Number(data._cozinhaVias ?? 1) || 1))
  console.log('[3/5] printCupom cozinha | printerName:', config.printerName ?? '(não config)', '| cols:', cols, '| vias:', vias)
  return (async () => {
    try {
      for (let i = 0; i < vias; i++) {
        // setor COZINHA (backend manda data.setor; fallback explícito aqui).
        await _printRouted(enriched, data, config, data.setor || 'COZINHA', i + 1)
      }
      new Notification({ title: 'Pede+ Print', body: `Comanda #${code} impressa` }).show()
    } catch (err) {
      console.error('[pede-print] ERRO no auto-print:', err.message)
      new Notification({ title: 'Pede+ Print — Erro de impressão', body: err.message || String(err) }).show()
    }
  })()
}

// Resumo curto (Mesa/Cliente) para o popup de confirmação.
function _kitchenInfo(data) {
  const mesa = data.mesa?.numero ?? data.table ?? null
  const cliente = data.customer_name ?? data.nomeCliente ?? data.cliente?.nome
    ?? (typeof data.customer === 'string' ? data.customer : data.customer?.name ?? data.customer?.nome) ?? null
  const isDelivery = String(data.serviceType ?? data.type ?? data.tipo ?? '').toUpperCase() === 'DELIVERY'
    || !!data.deliveryAddress || !!data.delivery_code
  const parts = []
  if (isDelivery) parts.push('Delivery')
  else if (mesa != null) parts.push('Mesa ' + mesa)
  if (cliente) parts.push(String(cliente))
  return parts.join(' • ')
}

function handlePrintEvent(event, data) {
  console.log('[handlePrintEvent] evento:', event, '| id:', data?.id ?? data?.numeroPedido ?? '?', '| code:', data?.code ?? data?.orderCode ?? '?')
  const config = effectiveConfig()
  console.log('[handlePrintEvent] config.printerName:', config.printerName ?? '(não configurado)')

  // ── Comprovante (fila nova com jobId — única via de comprovante) ──────────
  if (event === 'receipt:print') {
    const jobId = data.jobId
    const code = data.orderCode ?? data.code ?? data.numeroPedido ?? '?'
    // IDEMPOTÊNCIA: ignora jobId já impresso (bloqueia duplicação por qualquer causa).
    if (jobId != null) {
      if (_printedJobIds.has(jobId)) {
        console.log('[receipt:print] jobId repetido ignorado:', jobId, '-> reenviando ack')
        emitToServer('print:ack', { jobId }) // reconfirma p/ backend cancelar reenvio
        return
      }
      _rememberJobId(jobId)
    }
    // Relatorio de caixa usa o template caixa (não marca _via:'cliente', que
    // forçaria o comprovante de pagamento). Pedidos/pagamentos seguem como antes.
    // COMANDA (type=kitchen, reimpressão manual do KDS): também NÃO marca
    // _via:'cliente' — o builder cai em buildKitchenVia e sai a comanda.
    const isCaixa = data.type === 'caixa'
    const isKitchen = data.type === 'kitchen'
    console.log('[REPRINT-DEBUG] receipt:print | type:', data.type, '| setor:', data.setor ?? '(sem)', '| via:', (isCaixa || isKitchen) ? '(template do type)' : 'cliente')
    const enriched = _tenantEnrich((isCaixa || isKitchen) ? { ...data } : { ...data, _via: 'cliente' }, config)
    ;(async () => {
      try {
        console.log('[receipt:print] IMPRIMINDO jobId:', jobId ?? '(sem)', '| code:', code)
        // setor: backend manda data.setor (COZINHA p/ comanda; CAIXA p/ recibo).
        await _printRouted(enriched, data, config, data.setor || (isKitchen ? 'COZINHA' : 'CAIXA'), 1)
        // ACK imediato após sucesso -> backend marca PRINTED e cancela reenvio.
        if (jobId != null) emitToServer('print:ack', { jobId })
        new Notification({ title: 'Pede+ Print', body: `${isKitchen ? 'Comanda' : 'Comprovante'} #${code} impresso` }).show()
      } catch (err) {
        if (jobId != null) _printedJobIds.delete(jobId) // permite retry do backend
        console.error('[pede-print] Erro comprovante:', err.message)
        new Notification({ title: 'Pede+ Print — Erro', body: err.message || String(err) }).show()
      }
    })()
    return
  }

  // ── LEGADO desativado: comprovante agora sai SÓ pela fila (receipt:print). ──
  // Mantido o recebimento do evento p/ não quebrar UI, mas SEM imprimir (evita
  // 2ª via duplicada). Cozinha permanece intocada.
  if (event === 'pedido_pago' || event === 'caixa_pagamento') {
    console.log(`[${event}] legado: impressão de comprovante desativada (usa fila receipt:print)`)
    return
  }

  // ── Novo pedido (cozinha ou balcão) ───────────────────────────────────────
  if (event !== 'novo_pedido_cozinha' && event !== 'novo_pedido') {
    console.log('[handlePrintEvent] evento ignorado:', event)
    return
  }
  if (_isDuplicate(data)) {
    console.log('[handlePrintEvent] duplicata ignorada, id:', data?.id ?? data?.numeroPedido ?? data?.code ?? data?.orderCode)
    return
  }

  // Para pedidos novos no cozinha sempre imprime (status PENDENTE é esperado).
  // Para order:new (online) verifica status.
  if (event !== 'novo_pedido_cozinha') {
    const status = _getPrintStatus(data)
    if (!PRINT_STATUSES.has(status)) {
      console.log('[SKIP] status nao imprimivel:', status || '(sem status)')
      return
    }
  }

  const rawItems = data.items ?? data.itens ?? []
  console.log('[handlePrintEvent] itens encontrados:', rawItems.length)
  if (rawItems.length === 0) {
    console.log('[SKIP] pedido sem itens, ignorando')
    return
  }

  // Auto-print da COZINHA controlado pela config do tenant. Regra: SÓ imprime
  // direto quando === true. Qualquer outro valor (false/undefined) => popup
  // PRÓPRIO perguntando; nunca imprime silenciosamente sem confirmação.
  const autoOn = data._cozinhaAutoPrint === true
  if (autoOn) {
    runKitchenPrint(data, config)
    return
  }

  console.log('[cozinha] auto-print desligado -> popup de confirmação')
  const code = data.orderCode || data.code || data.numeroPedido || '?'
  const token = String(++_kitchenSeq)
  _pendingKitchen.set(token, { data, config })
  showKitchenPrompt({ token, code, info: _kitchenInfo(data) })
}

// ─── Socket lifecycle ─────────────────────────────────────────────────────────

function startSocket() {
  // serverUrl vem SEMPRE de config-defaults (produção https, ou override de dev).
  const config = effectiveConfig()
  if (!config.serverUrl || !config.apiKey) return
  if (!_printerTarget(config)) {
    cleanupSocket()
    handleStatusChange('disconnected')
    new Notification({
      title: 'Pede+ Print',
      body: 'Configure uma impressora ou porta serial antes de conectar.',
    }).show()
    return
  }
  console.log('[main] startSocket | serverUrl:', config.serverUrl, '| printerName:', config.printerName ?? '(não configurado)')
  cleanupSocket()
  createSocket(config, handlePrintEvent, handleStatusChange, handleRevogado)
}

// Credencial revogada no painel: limpa o token local e volta pra tela de
// pareamento. Não chama o servidor de volta (a credencial já morreu lá).
function handleRevogado() {
  void trocarConta({ revogarNoServidor: false })
  new Notification({
    title: 'Pede+ Print',
    body: 'Esta impressora foi desconectada pelo painel. Pareie novamente com um novo código.',
  }).show()
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => store.get('config') || {})

// Versão do app + default de dev p/ a tela avançada (nada sensível).
ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  devUrlDefault: defaults.DEV_URL_DEFAULT,
}))

// Prévia da URL que o agente usaria com um dado par (devMode, devServerUrl) —
// mostra ao dev que http público é promovido a https.
ipcMain.handle('preview-server-url', (_, data) => defaults.resolveServerUrl(data || {}))

// Reaplica porta/perfil + roteamento e reconecta. Usado após login/save avançado.
async function reapplyAndConnect() {
  _autoPort = null; _appliedProfile = null; _activeSource = null
  await autoConfigurePrinter()
  try { await routing.init() } catch (e) { console.warn('[routing] init falhou:', e?.message || e) }
  startSocket()
  void drainPending('config')
}

ipcMain.handle('save-config', async (_, data) => {
  console.log('[config] salvando | apiKey=', data.apiKey ? data.apiKey.slice(0, 16) + '...' : '(vazio)')
  store.set('config', data)
  await reapplyAndConnect()
  return true
})

// Configurações avançadas (dev) + override opcional do cabeçalho do cupom.
// Campos em branco do cabeçalho voltam ao default do backend na próxima entrada.
ipcMain.handle('save-advanced', async (_, data) => {
  const prev = store.get('config') || {}
  const next = {
    ...prev,
    devMode: data?.devMode === true,
    devServerUrl: String(data?.devServerUrl ?? '').trim(),
    logoEnabled: data?.logoEnabled === true,
    tenantName: String(data?.tenantName ?? '').trim(),
    tenantAddress: String(data?.tenantAddress ?? '').trim(),
    tenantPhone: String(data?.tenantPhone ?? '').trim(),
    tenantCnpj: String(data?.tenantCnpj ?? '').trim(),
  }
  store.set('config', next)
  const url = serverUrl(next)
  console.log('[config] avançado salvo | devMode:', next.devMode, '| serverUrl efetiva:', url)
  await reapplyAndConnect()
  return { ok: true, message: `Salvo. Servidor: ${url}` }
})

// ── Onboarding: login -> provision -> apiKey -> socket (por apiKey, como sempre) ──

// Persiste o resultado do provision e sobe a conexão. O JWT NÃO é guardado: só a
// apiKey, que é o que o gateway usa p/ marcar isPrintAgent.
async function persistProvision(res) {
  const prev = store.get('config') || {}
  const t = res.tenant || {}
  const next = {
    ...prev,
    apiKey: res.apiKey,
    apiKeyId: res.apiKeyId ?? null,
    tenantId: t.id ?? prev.tenantId ?? null,
    userEmail: res.userEmail ?? prev.userEmail ?? null,
    // Nome do estabelecimento CONECTADO. Campo próprio, separado de tenantName
    // (que o modo avançado pode sobrescrever para o cabeçalho do cupom): é ele
    // que a janela e a bandeja exibem permanentemente, e ele sempre reflete a
    // conta pareada de verdade.
    estabelecimento: res.estabelecimento ?? t.nome ?? prev.estabelecimento ?? null,
    // Cabeçalho do cupom vem do backend. Só preenche o que o usuário não sobrescreveu
    // manualmente — override do modo avançado continua ganhando.
    tenantName:    prev.tenantName    || t.nome     || '',
    tenantAddress: prev.tenantAddress || t.endereco || '',
    tenantPhone:   prev.tenantPhone   || t.telefone || '',
    tenantCnpj:    prev.tenantCnpj    || t.cnpj     || '',
  }
  store.set('config', next)
  refreshTray()
  console.log('[auth] provisionado | tenant:', next.estabelecimento || next.tenantName || next.tenantId, '| credencial:', String(res.apiKey).slice(0, 12) + '...')
  await reapplyAndConnect()
  return next
}

// ── Pareamento por código (caminho principal) ────────────────────────────────
// O token opaco fica no MESMO campo `apiKey`: o backend decide pelo prefixo quem
// valida, então socket.js e as rotas do agente seguem intocados.
ipcMain.handle('agent-pair', async (_, { codigo }) => {
  const url = serverUrl()
  const res = await agentAuth.pairWithCode(url, codigo, deviceLabel())
  if (!res.ok) return res
  await persistProvision(res)
  return { ok: true, estabelecimento: (store.get('config') || {}).estabelecimento || null }
})

// Nome legível deste computador, exibido na lista de impressoras pareadas do painel.
function deviceLabel() {
  try { return require('os').hostname() || 'Computador' } catch { return 'Computador' }
}

ipcMain.handle('agent-login', async (_, { email, senha }) => {
  const url = serverUrl()
  console.log('[auth] login em', url)
  // Fingerprint no login = mesmo id usado no verify-otp. É o que faz o backend
  // avaliar o 2FA (auth.service.ts:198) e depois reconhecer este computador.
  const res = await agentAuth.login(url, email, senha, deviceFingerprint())
  if (res.requiresOtp) return res           // assistente abre a tela do código
  if (!res.ok) return res
  await persistProvision(res)
  return { ok: true }
})

ipcMain.handle('agent-verify-otp', async (_, { tempToken, code }) => {
  const res = await agentAuth.verifyOtp(serverUrl(), tempToken, code, deviceFingerprint())
  if (!res.ok) return res
  await persistProvision(res)
  return { ok: true }
})

ipcMain.handle('agent-resend-otp', async (_, { tempToken }) =>
  agentAuth.resendOtp(serverUrl(), tempToken))

// "Sair": revoga a chave no backend E limpa a chave local. Sem apiKey o socket
// não sobe, então a próxima abertura cai no login — sessão não vaza entre
// estabelecimentos. A limpeza local acontece mesmo se o backend estiver offline.
// "Trocar conta"/"Sair": revoga a credencial no backend E limpa a local. Sem
// credencial o socket não sobe, então a próxima abertura cai no pareamento —
// sessão não vaza entre estabelecimentos. A limpeza local acontece mesmo se o
// backend estiver offline. Revogação por tipo: AgenteToken (`pa_`) vai pelo
// endpoint do pareamento; apiKey legada segue pelo /print-agent/provision.
async function trocarConta(opts) {
  const revogarNoServidor = !opts || opts.revogarNoServidor !== false
  const prev = store.get('config') || {}
  let revoked = false
  if (prev.apiKey && revogarNoServidor) {
    const r = String(prev.apiKey).startsWith('pa_')
      ? await agentAuth.revokeAgentToken(serverUrl(prev), prev.apiKey)
      : await agentAuth.revokeRemote(serverUrl(prev), prev.apiKey)
    revoked = !!(r && r.ok)
  }
  cleanupSocket()
  handleStatusChange('disconnected')
  const {
    apiKey, apiKeyId, tenantId, userEmail, estabelecimento,
    tenantName, tenantAddress, tenantPhone, tenantCnpj, ...keep
  } = prev
  store.set('config', keep)
  refreshTray()
  // Se a janela já estiver aberta (ex.: "Trocar conta" pela bandeja), ela volta
  // sozinha para a tela de pareamento em vez de mostrar uma conta que não existe mais.
  const win = getConfigWindow()
  if (win && !win.isDestroyed()) win.webContents.send('account-changed')
  console.log('[auth] trocar conta | credencial revogada no servidor:', revoked)
  return {
    ok: true,
    revoked,
    message: revoked
      ? 'Sessão encerrada e credencial revogada.'
      : 'Sessão encerrada neste computador.',
  }
}

ipcMain.handle('agent-logout', () => trocarConta())

// UI consulta o que foi aplicado (perfil/porta/fonte) ao abrir a config.
ipcMain.handle('get-applied-printer', () => _appliedInfo())

ipcMain.handle('get-printers', async () => {
  try { return await require('./printer').getPrinters() } catch { return [] }
})

// Lista as portas seriais com metadados (path/manufacturer/VID/PID/perfil). Cai
// para os nomes COM do registro do Windows se o serialport não estiver disponível.
ipcMain.handle('get-ports', async () => {
  try {
    const rich = await require('./printer-profiles').listSerialPorts()
    if (rich.length) return rich.map((p) => ({
      path: p.path, manufacturer: p.manufacturer,
      vendorId: p.vendorId, productId: p.productId,
      profileName: p.profile ? p.profile.name : null,
    }))
  } catch { /* fallback abaixo */ }
  try { return (await require('./printer').getSerialPorts()).map((path) => ({ path })) }
  catch { return [] }
})

// Auto-detecta a impressora por VID/PID (botão "Detectar" da config).
//   1 match  -> { status:'auto', port, profileName }
//   0 matches-> { status:'none' }
//   2+ match -> { status:'ambiguous', candidates:[{port, profileName}] }
ipcMain.handle('detect-printer', async () => {
  try {
    const r = await require('./printer-profiles').detectPrinterPort()
    if (r && r.port)             return { status: 'auto', port: r.port, profileName: r.profile.name }
    if (r && Array.isArray(r.candidates))
      return { status: 'ambiguous', candidates: r.candidates.map((c) => ({ port: c.port, profileName: c.profile.name })) }
    return { status: 'none' }
  } catch (e) { return { status: 'error', message: e?.message || String(e) } }
})

// Catálogo de perfis (mesma fonte do backend) p/ o dropdown global "Modelo" E o
// select de perfil por impressora — sem listas divergentes.
ipcMain.handle('get-catalog', () => {
  try {
    return require('./printer-profiles').getCatalog().map((p) => ({
      id: p.id ?? null, name: p.name, brand: p.brand, isGeneric: !!p.isGeneric,
      encoding: p.encoding, codepageEscT: p.codepageEscT, columns: p.columns,
      cut: (p.commands && Array.isArray(p.commands.cut)) ? p.commands.cut.slice() : [],
    }))
  } catch { return [] }
})

// ── Roteamento multi-impressora (config por setor) ────────────────────────────

// Lista os alvos detectados + o mapeamento atual + o catálogo de perfis, para a UI
// montar a tela de setor/perfil por impressora. Re-detecta a cada chamada.
ipcMain.handle('get-print-targets', async () => {
  try {
    const targets = await routing.detectTargets()
    routing.setTargets(targets)
    const config = routing.ensureConfig(targets)
    const catalog = require('./printer-profiles').getCatalog()
      .map((p) => ({ id: p.id, name: p.name, brand: p.brand, isGeneric: p.isGeneric }))
    return { targets, config, catalog, setores: routing.SETORES }
  } catch (e) {
    console.warn('[routing] get-print-targets falhou:', e?.message || e)
    return { targets: [], config: routing.loadConfig() || {}, catalog: [], setores: routing.SETORES }
  }
})

// Salva o mapeamento (setor/profileId por deviceKey + default) vindo da UI e recarrega.
ipcMain.handle('save-printer-mapping', async (_, incoming) => {
  try {
    const targets = routing.getTargets().length ? routing.getTargets() : await routing.detectTargets()
    routing.setTargets(targets)
    const cfg = routing.ensureConfig(targets)
    if (incoming && incoming.printers && typeof incoming.printers === 'object') {
      for (const [k, v] of Object.entries(incoming.printers)) {
        if (!cfg.printers[k]) continue
        const setor = v && v.setor ? String(v.setor).toUpperCase() : null
        cfg.printers[k].setor = routing.SETORES.includes(setor) ? setor : null
        // "Em uso": só mexe quando a UI mandou o campo (a tela legada não manda).
        if (v && Object.prototype.hasOwnProperty.call(v, 'ativa')) cfg.printers[k].ativa = v.ativa === true
        cfg.printers[k].profileId = v && v.profileId != null ? Number(v.profileId) : null
        // Toggle de corte por impressora (default TRUE — não regride).
        cfg.printers[k].cortarPapel = !(v && v.cortarPapel === false)
        // Override manual por impressora (Ajuste avançado). Ausente/desativado => limpa.
        const ov = v && v.override
        if (ov && ov.enabled) {
          const cut = Array.isArray(ov.cut) ? ov.cut.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 255) : null
          cfg.printers[k].override = {
            enabled: true,
            columns: Number.isInteger(Number(ov.columns)) && Number(ov.columns) > 0 ? Number(ov.columns) : null,
            codepageEscT: Number.isInteger(Number(ov.codepageEscT)) ? Number(ov.codepageEscT) : null,
            encoding: typeof ov.encoding === 'string' && ov.encoding.trim() ? ov.encoding.trim() : null,
            cut: cut && cut.length ? cut : null,
          }
        } else {
          delete cfg.printers[k].override
        }
      }
    }
    if (incoming && incoming.defaultDeviceKey && cfg.printers[incoming.defaultDeviceKey]) {
      cfg.defaultDeviceKey = incoming.defaultDeviceKey
    }
    // Quem exige uma "principal" (resolveDefault/_printerTarget) usa a 1ª ATIVA
    // como fallback — sem obrigar o cliente a eleger uma.
    const ativas = routing.activeKeys(cfg, targets)
    if (ativas.length && !ativas.includes(cfg.defaultDeviceKey)) cfg.defaultDeviceKey = ativas[0]
    routing.saveConfig(cfg)
    routing.logMapping()
    return { ok: true, config: cfg }
  } catch (e) {
    return { ok: false, message: e?.message || String(e) }
  }
})

// Pareamento manual por chave (legado): mantido p/ suporte, sem UI no fluxo do
// cliente. A URL nunca vem do renderer — é sempre a resolvida por config-defaults.
ipcMain.handle('validate-key', async (_, { apiKey }) => {
  try { return await validateKey({ serverUrl: serverUrl(), apiKey }) }
  catch (e) { return { ok: false, message: e?.message || String(e) } }
})

// "Minimizar para a bandeja": esconde a janela; tray e auto-print seguem ativos.
ipcMain.handle('hide-to-tray', () => {
  hideConfigWindow()
  return true
})

ipcMain.handle('test-print', async (_, { printerName, cols, type, codepage, encoding, profileId, cortarPapel }) => {
  const { printTestCupom } = require('./printer')
  const config = effectiveConfig()
  // Teste por impressora: usa o PERFIL do card (corte/codepage corretos) quando enviado.
  const profile = profileId != null ? require('./printer-routing').profileById(Number(profileId)) : null
  await printTestCupom(
    printerName || _printerTarget(config),
    cols || (profile && profile.columns) || DEFAULT_COLS,
    type || 'balcao',
    {
      codepage: codepage ?? (profile && profile.codepageEscT) ?? config.codepage,
      encoding: encoding ?? (profile && profile.encoding) ?? config.encoding,
      profile: profile || undefined,
      noCut: cortarPapel === false, // honra o toggle do card também no teste
    },
  )
})

ipcMain.handle('get-status', () => currentStatus)

// Ação do popup próprio da cozinha: "Imprimir" roda a MESMA rotina (honra vias);
// "Ignorar" só fecha. Fecha a janela que disparou de qualquer forma.
ipcMain.on('kitchen-prompt:action', (e, { token, action }) => {
  const pending = _pendingKitchen.get(token)
  _pendingKitchen.delete(token)
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win && !win.isDestroyed()) win.close()
  if (action === 'print' && pending) {
    console.log('[cozinha] popup -> Imprimir | token:', token)
    runKitchenPrint(pending.data, pending.config)
  } else {
    console.log('[cozinha] popup -> Ignorar | token:', token)
  }
})

// ─── App boot ─────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  app.setAppUserModelId('com.pedemais.print')

  tray = new Tray(makeTrayIcon(false))
  tray.setToolTip('Pede+ Print')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => openConfigWindow())
  tray.on('double-click', () => openConfigWindow())

  // Descobre a porta/perfil da impressora ANTES de conectar (auto-detect VID/PID
  // ou override manual). Loga o alvo e o motivo no startup.
  await autoConfigurePrinter()

  // Descobre TODOS os alvos (serial + spooler Windows), garante o printers-config.json
  // e loga o mapeamento por setor. Falha aqui nunca bloqueia o boot.
  try { await routing.init() } catch (e) { console.warn('[routing] init falhou:', e?.message || e) }

  // Primeiro uso (sem chave ou sem impressora): abre o assistente automaticamente.
  // Já configurado: conecta direto, sem abrir janela — vai pra bandeja sozinho.
  if (_needsSetup(effectiveConfig())) openConfigWindow()
  else startSocket()

  // Pendências que sobreviveram ao restart: tenta drenar já e segue vigiando a
  // volta da impressora (TTL vencido não imprime sozinho — vira reimpressão manual).
  startPendingWatcher()
  void drainPending('boot')

  initUpdater() // auto-update (no-op em dev/unpackaged)
})

app.on('window-all-closed', (e) => e.preventDefault())

app.on('before-quit', () => cleanupSocket())
