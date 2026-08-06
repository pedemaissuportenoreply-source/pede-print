'use strict'

// Auto-update via electro­n-updater. Verifica no boot e periodicamente, baixa em
// segundo plano e aplica ao sair/reiniciar. Silencioso: nunca interrompe a
// operação do caixa — só notifica quando há update pronto.
//
// O feed de atualização vem de package.json > build.publish (ver lá o TODO para
// preencher o destino real — GitHub releases ou provider genérico). Pode ser
// sobrescrito em runtime por PEDE_UPDATE_URL (provider genérico).

const { app, Notification } = require('electron')
const log = require('electron-log')

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

let _started = false

function notify(title, body) {
  try { new Notification({ title, body }).show() } catch { /* tray-only env */ }
}

function initUpdater() {
  if (_started) return
  _started = true

  // Em dev (sem empacotar) não há feed — não tenta atualizar.
  if (!app.isPackaged) {
    log.info('[updater] dev/unpackaged — auto-update desativado')
    return
  }

  const { autoUpdater } = require('electron-updater')
  autoUpdater.logger = log
  log.transports.file.level = 'info'

  // Feed configurável em runtime (opcional): provider genérico via env.
  // Caso ausente, usa o publish definido em package.json (electron-builder).
  const url = (process.env.PEDE_UPDATE_URL || '').trim()
  if (url) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url })
      log.info('[updater] feed via PEDE_UPDATE_URL:', url)
    } catch (e) {
      log.warn('[updater] PEDE_UPDATE_URL inválida:', e.message)
    }
  }

  autoUpdater.autoDownload = true            // baixa em segundo plano
  autoUpdater.autoInstallOnAppQuit = true    // aplica ao sair/reiniciar

  autoUpdater.on('error', (err) => log.warn('[updater] erro:', err == null ? 'desconhecido' : (err.stack || err).toString()))
  autoUpdater.on('update-available', (info) => log.info('[updater] update disponível:', info.version))
  autoUpdater.on('update-not-available', () => log.info('[updater] já está atualizado'))
  autoUpdater.on('update-downloaded', (info) => {
    log.info('[updater] update baixado:', info.version, '— será aplicado ao reiniciar')
    notify('Pede+ Print', `Atualização ${info.version} pronta. Será aplicada ao reiniciar o agente.`)
  })

  const check = () => autoUpdater.checkForUpdates().catch((e) => log.warn('[updater] checkForUpdates falhou:', e.message))
  check()
  setInterval(check, CHECK_INTERVAL_MS)
}

// Chamado manualmente pelo tray ("Verificar atualizações").
function checkForUpdatesNow() {
  if (!app.isPackaged) { notify('Pede+ Print', 'Atualizações só no app instalado.'); return }
  // require aqui: o módulo só existe/faz sentido no app empacotado (mesmo do init).
  const { autoUpdater } = require('electron-updater')
  autoUpdater.checkForUpdates().catch((e) => log.warn('[updater] check manual falhou:', e.message))
}

module.exports = { initUpdater, checkForUpdatesNow }
