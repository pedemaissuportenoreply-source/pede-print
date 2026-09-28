'use strict'

// Auto-update via electron-updater, 100% automático: verifica (boot+15s, a cada
// 1h e na volta da rede), baixa em segundo plano e APLICA sozinho assim que o
// agente estiver ocioso — sem depender de alguém reiniciar o agente.
//
// "Ocioso" é decidido pelo main (isSafe/isIdle): nada imprimindo, fila de
// pendências vazia e sem pedido recente. A fila persiste em disco, então o
// restart nunca perde job.
//
// O feed vem de package.json > build.publish (GitHub releases). Pode ser
// sobrescrito em runtime por PEDE_UPDATE_URL (provider genérico).

const { app, Notification } = require('electron')
const log = require('electron-log')
const path = require('path')

const FIRST_CHECK_MS     = 15 * 1000
const CHECK_INTERVAL_MS  = 60 * 60 * 1000       // 1h
const RECONNECT_THROTTLE = 10 * 60 * 1000       // checagem na reconexão: no máx 1x/10min
const APPLY_POLL_MS      = 30 * 1000
const APPLY_CEILING_MS   = 30 * 60 * 1000       // depois disso aplica com fila vazia + nada imprimindo

const RELAUNCH_KEY = 'pendingUpdateRelaunch'

let _started = false
let _autoUpdater = null
let _hooks = {}
let _state = 'idle' // idle | checking | downloading | downloaded
let _downloadedVersion = null
let _manual = false
let _lastCheckAt = 0
let _applyTimer = null
let _downloadedAt = 0

function _icon() { return path.join(__dirname, 'assets', 'app-icon.ico') }

function notify(title, body) {
  try { new Notification({ title, body, icon: _icon() }).show() } catch { /* tray-only env */ }
}

function _setState(s) {
  if (_state === s) return
  _state = s
  try { _hooks.onStateChange?.(s) } catch { /* nunca derruba o agente */ }
}

function isDownloading() { return _state === 'downloading' }

function _check(reason) {
  if (!_autoUpdater) return
  if (_state === 'downloading' || _state === 'downloaded') return
  _lastCheckAt = Date.now()
  log.info('[updater] verificando (' + reason + ')')
  _autoUpdater.checkForUpdates().catch((e) => {
    _manual = false
    log.warn('[updater] checkForUpdates falhou:', e?.message || e)
  })
}

// hooks: { store, isSafe(), isIdle(), beforeQuit(), onStateChange(state) }
function initUpdater(hooks) {
  if (_started) return
  _started = true
  _hooks = hooks || {}

  // Em dev (sem empacotar) não há feed — não tenta atualizar.
  if (!app.isPackaged) {
    log.info('[updater] dev/unpackaged — auto-update desativado')
    return
  }

  const { autoUpdater } = require('electron-updater')
  _autoUpdater = autoUpdater
  autoUpdater.logger = log
  log.transports.file.level = 'info'

  // Feed configurável em runtime (opcional): provider genérico via env.
  const url = (process.env.PEDE_UPDATE_URL || '').trim()
  if (url) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url })
      log.info('[updater] feed via PEDE_UPDATE_URL:', url)
    } catch (e) {
      log.warn('[updater] PEDE_UPDATE_URL inválida:', e.message)
    }
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    log.warn('[updater] erro:', err == null ? 'desconhecido' : (err.stack || err).toString())
    _manual = false
    if (_state !== 'downloaded') _setState('idle')
  })
  autoUpdater.on('checking-for-update', () => { if (_state === 'idle') _setState('checking') })
  autoUpdater.on('update-available', (info) => {
    log.info('[updater] update disponível:', info.version, '— baixando')
    if (_manual) notify('Pede+ Print', `Baixando v${info.version}…`)
    _manual = false
    _setState('downloading')
  })
  autoUpdater.on('update-not-available', () => {
    log.info('[updater] já está atualizado')
    if (_manual) notify('Pede+ Print', 'Você já está na versão mais recente.')
    _manual = false
    _setState('idle')
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info('[updater] update baixado:', info.version, '— aplicação pendente (aguardando janela segura)')
    _downloadedVersion = info.version
    _downloadedAt = Date.now()
    _setState('downloaded')
    notify('Pede+ Print', `Atualização v${info.version} baixada. Será aplicada automaticamente.`)
    _scheduleApply()
  })

  const t = setTimeout(() => _check('boot'), FIRST_CHECK_MS)
  if (t.unref) t.unref()
  const iv = setInterval(() => _check('intervalo'), CHECK_INTERVAL_MS)
  if (iv.unref) iv.unref()
}

// Socket voltou de reconnecting -> connected: checa, no máximo 1x a cada 10min.
function onReconnected() {
  if (!_autoUpdater) return
  if (Date.now() - _lastCheckAt < RECONNECT_THROTTLE) return
  _check('reconexão')
}

function _scheduleApply() {
  if (_applyTimer) return
  _applyTimer = setInterval(_tryApply, APPLY_POLL_MS)
  if (_applyTimer.unref) _applyTimer.unref()
}

function _tryApply() {
  if (_state !== 'downloaded') return
  let safe = false
  let idle = false
  try { safe = _hooks.isSafe?.() === true } catch (e) { log.warn('[updater] isSafe falhou:', e?.message || e) }
  const teto = Date.now() - _downloadedAt >= APPLY_CEILING_MS
  if (!safe && teto) {
    try { idle = _hooks.isIdle?.() === true } catch (e) { log.warn('[updater] isIdle falhou:', e?.message || e) }
  }
  if (!safe && !idle) return
  log.info('[updater] janela segura' + (safe ? '' : ' (teto de 30min)') + ' — aplicando v' + _downloadedVersion)
  _apply()
}

function _apply() {
  clearInterval(_applyTimer)
  _applyTimer = null
  try {
    _hooks.store?.set(RELAUNCH_KEY, { version: _downloadedVersion, hidden: true, at: Date.now() })
  } catch (e) { log.warn('[updater] falha ao gravar relaunch:', e?.message || e) }
  try { _hooks.beforeQuit?.() } catch (e) { log.warn('[updater] beforeQuit falhou:', e?.message || e) }
  try {
    app.isQuitting = true
    // silent (/S) + forceRunAfter: o instalador relança o app sozinho (sem --hidden;
    // o boot lê pendingUpdateRelaunch e sobe oculto).
    _autoUpdater.quitAndInstall(true, true)
  } catch (e) {
    log.warn('[updater] quitAndInstall falhou:', e?.message || e)
    app.isQuitting = false
    try { _hooks.store?.delete(RELAUNCH_KEY) } catch { /* ignora */ }
    _scheduleApply()
  }
}

// Boot pós-update: retorna a versão aplicada (e limpa a chave) ou null.
function consumeRelaunch(store) {
  let r = null
  try { r = store.get(RELAUNCH_KEY) || null } catch { r = null }
  if (r) { try { store.delete(RELAUNCH_KEY) } catch { /* ignora */ } }
  return r
}

// Chamado manualmente pelo tray ("Verificar atualizações").
function checkForUpdatesNow() {
  if (!app.isPackaged || !_autoUpdater) { notify('Pede+ Print', 'Atualizações só no app instalado.'); return }
  if (_state === 'downloaded') { notify('Pede+ Print', `Atualização v${_downloadedVersion} será aplicada automaticamente.`); return }
  if (_state === 'downloading') { notify('Pede+ Print', 'Baixando atualização…'); return }
  _manual = true
  _check('manual')
}

module.exports = { initUpdater, checkForUpdatesNow, onReconnected, consumeRelaunch, isDownloading, notify }
