'use strict'

// Popup PRÓPRIO (não-nativo) que pergunta se imprime a comanda da cozinha quando
// o auto-print da cozinha está DESLIGADO. Centralizado, alwaysOnTop.

const { BrowserWindow } = require('electron')
const path = require('path')

function showKitchenPrompt({ token, code, info }) {
  const win = new BrowserWindow({
    width: 440,
    height: 300,
    title: 'Pede+ Print',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: false,
    backgroundColor: '#0a0a0a',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  win.setMenu(null)
  win.setAlwaysOnTop(true, 'screen-saver')
  const query = {
    token: String(token),
    code: String(code ?? '?'),
    info: String(info ?? ''),
  }
  win.loadFile(path.join(__dirname, 'renderer', 'kitchen-prompt.html'), { query })
  win.once('ready-to-show', () => { win.show(); win.focus() })
  return win
}

module.exports = { showKitchenPrompt }
