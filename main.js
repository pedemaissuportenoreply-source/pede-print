'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage } = require('electron')
const path = require('path')
const Store = require('electron-store')

const store = new Store()
const { createSocket, reconnect: reconnectSocket, cleanup: cleanupSocket, emitToServer, validateKey } = require('./socket')
const { openConfigWindow, getConfigWindow } = require('./config-window')
const { initUpdater, checkForUpdatesNow } = require('./updater')

let tray = null
let currentStatus = 'disconnected'

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
  return Menu.buildFromTemplate([
    { label: `Pede+ Print  —  ${statusLabel}`, enabled: false },
    { type: 'separator' },
    { label: 'Configurações', click: () => openConfigWindow() },
    { label: 'Reconectar',    click: () => startSocket() },
    { label: 'Verificar atualizações', click: () => checkForUpdatesNow() },
    { type: 'separator' },
    { label: 'Sair',          click: () => app.quit() },
  ])
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return
  tray.setImage(makeTrayIcon(currentStatus === 'connected'))
  tray.setToolTip(`Pede+ Print — ${currentStatus === 'connected' ? 'Conectado' : 'Desconectado'}`)
  tray.setContextMenu(buildTrayMenu())
}

// ─── Status / broadcast ───────────────────────────────────────────────────────

function handleStatusChange(status) {
  currentStatus = status
  refreshTray()
  const win = getConfigWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('status-changed', status)
  }
}

// ─── Print events ─────────────────────────────────────────────────────────────

const _printedIds     = new Set()
const _paidPrintedIds = new Set()
const _printedJobIds  = new Set() // idempotência por jobId da fila nova (cinturão de segurança)

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

// Retorna comPort se configurado, senão o printerName (spooler)
function _printerTarget(config) {
  const com = String(config.comPort || '').trim().toUpperCase()
  return com.match(/^COM\d{1,2}$/) ? com : (config.printerName || '')
}

// Parâmetros ESC/POS do tenant (default Daruma DR800: cp1252 / ESC t 7).
function _printOpts(config) {
  return { encoding: config.encoding, codepage: config.codepage }
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
    _logoEnabled:  config.logoEnabled === true, // default false; só liga via toggle
  }
}

function handlePrintEvent(event, data) {
  console.log('[handlePrintEvent] evento:', event, '| id:', data?.id ?? data?.numeroPedido ?? '?', '| code:', data?.code ?? data?.orderCode ?? '?')
  const config = store.get('config') || {}
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
      _printedJobIds.add(jobId)
    }
    const cols = config.balcaoCols ?? DEFAULT_COLS
    const { printCupom } = require('./printer')
    // Relatorio de caixa usa o template caixa (não marca _via:'cliente', que
    // forçaria o comprovante de pagamento). Pedidos/pagamentos seguem como antes.
    const isCaixa = data.type === 'caixa'
    const enriched = _tenantEnrich(isCaixa ? { ...data } : { ...data, _via: 'cliente' }, config)
    ;(async () => {
      try {
        console.log('[receipt:print] IMPRIMINDO jobId:', jobId ?? '(sem)', '| code:', code)
        await printCupom(enriched, _printerTarget(config), cols, _printOpts(config))
        // ACK imediato após sucesso -> backend marca PRINTED e cancela reenvio.
        if (jobId != null) emitToServer('print:ack', { jobId })
        new Notification({ title: 'Pede+ Print', body: `Comprovante #${code} impresso` }).show()
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

  const { printCupom } = require('./printer')

  const isDelivery = String(data.serviceType ?? data.type ?? data.tipo ?? data.modalidade ?? '').toUpperCase() === 'DELIVERY'
    || !!data.deliveryAddress || !!data.delivery_code

  ;(async () => {
    // Evento de NOVO pedido = comida a preparar => SEMPRE cozinha (QR/MESA/BALCAO
    // iguais; delivery é tratado por isDelivery no builder). Comprovante de
    // pagamento só vem dos eventos pago/pagamento/receipt:print, nunca aqui.
    const printType = 'kitchen'
    const cols = config.balcaoCols || DEFAULT_COLS
    const code = data.orderCode || data.code || data.numeroPedido || '?'
    const enriched = _tenantEnrich({ ...data, _printType: printType }, config)
    console.log('[3/5] printCupom | type:', printType, '| printerName:', config.printerName ?? '(não config)', '| cols:', cols)
    try {
      await printCupom(enriched, _printerTarget(config), cols, _printOpts(config))
      new Notification({ title: 'Pede+ Print', body: `Comanda #${code} impressa` }).show()
    } catch (err) {
      console.error('[pede-print] ERRO no auto-print:', err.message)
      new Notification({ title: 'Pede+ Print — Erro de impressão', body: err.message || String(err) }).show()
    }
  })()
}

// ─── Socket lifecycle ─────────────────────────────────────────────────────────

function startSocket() {
  const config = store.get('config')
  if (!config?.serverUrl || !config?.apiKey) return
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
  createSocket(config, handlePrintEvent, handleStatusChange)
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => store.get('config') || {})

ipcMain.handle('save-config', (_, data) => {
  console.log('[config] salvando: serverUrl=', data.serverUrl, '| apiKey=', data.apiKey ? data.apiKey.slice(0, 16) + '...' : '(vazio)')
  store.set('config', data)
  startSocket()
  return true
})

ipcMain.handle('get-printers', async () => {
  try { return await require('./printer').getPrinters() } catch { return [] }
})

ipcMain.handle('get-ports', async () => {
  try { return await require('./printer').getSerialPorts() } catch { return [] }
})

// Pareamento: valida a chave contra o backend ANTES de qualquer persistência.
ipcMain.handle('validate-key', async (_, { serverUrl, apiKey }) => {
  try { return await validateKey({ serverUrl, apiKey }) }
  catch (e) { return { ok: false, message: e?.message || String(e) } }
})

ipcMain.handle('test-print', async (_, { printerName, cols, type, codepage, encoding }) => {
  const { printTestCupom } = require('./printer')
  const config = store.get('config') || {}
  await printTestCupom(
    printerName || _printerTarget(config),
    cols || DEFAULT_COLS,
    type || 'balcao',
    { codepage: codepage ?? config.codepage, encoding: encoding ?? config.encoding },
  )
})

ipcMain.handle('get-status', () => currentStatus)

// ─── App boot ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setAppUserModelId('com.pedemais.print')

  tray = new Tray(makeTrayIcon(false))
  tray.setToolTip('Pede+ Print')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => openConfigWindow())
  tray.on('double-click', () => openConfigWindow())

  // Primeiro uso (sem chave ou sem impressora): abre o setup automaticamente.
  // Tenant já configurado (FeitiçosBar): conecta direto, sem abrir janela.
  if (_needsSetup(store.get('config'))) openConfigWindow()
  else startSocket()

  initUpdater() // auto-update (no-op em dev/unpackaged)
})

app.on('window-all-closed', (e) => e.preventDefault())

app.on('before-quit', () => cleanupSocket())
