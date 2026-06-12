'use strict'

const { BrowserWindow } = require('electron')
const path = require('path')

let configWindow = null

function openConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus()
    return
  }

  configWindow = new BrowserWindow({
    width:      520,
    height:     700,
    title:      'Pede+ Print — Configurações',
    resizable:  false,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false,
    },
  })

  configWindow.setMenu(null)
  configWindow.loadFile(path.join(__dirname, 'renderer', 'config.html'))
  configWindow.on('closed', () => { configWindow = null })
}

function getConfigWindow() {
  return configWindow
}

module.exports = { openConfigWindow, getConfigWindow }
