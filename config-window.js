'use strict'

const { BrowserWindow } = require('electron')
const path = require('path')

let configWindow = null

function openConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    // Pode estar escondida pelo "Minimizar para a bandeja" — reexibe antes do focus.
    if (!configWindow.isVisible()) configWindow.show()
    configWindow.focus()
    return
  }

  configWindow = new BrowserWindow({
    width:      540,
    height:     720,
    title:      'Pede+ Print',
    resizable:  false,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false,
    },
  })

  configWindow.setMenu(null)
  configWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'))
  configWindow.on('closed', () => { configWindow = null })
}

// "Minimizar para a bandeja": esconde a janela sem encerrar o app (o tray segue
// vivo e o auto-print continua). window-all-closed já é prevenido em main.js.
function hideConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) configWindow.hide()
}

function getConfigWindow() {
  return configWindow
}

module.exports = { openConfigWindow, getConfigWindow, hideConfigWindow }
