// Preload do pede-print: ponte ÚNICA entre renderer (contextIsolation:true,
// nodeIntegration:false, sandbox) e o main. Expõe só os canais IPC que as telas
// usam hoje, com nomes fixos e allowlist — nada de `require`/Node no renderer.
const { contextBridge, ipcRenderer } = require('electron')

// Canais request/response (ipcRenderer.invoke) que o renderer pode chamar.
const INVOKE = new Set([
  'get-config', 'get-status', 'get-app-info', 'get-print-targets',
  'get-autostart', 'set-autostart', 'hide-to-tray', 'preview-server-url',
  'save-advanced', 'save-printer-mapping', 'test-print', 'diagnostico-daruma',
  'agent-pair', 'agent-login', 'agent-verify-otp', 'agent-resend-otp', 'agent-logout',
])
// Eventos push (main → renderer) que o renderer pode assinar.
const ON = new Set(['status-changed', 'account-changed', 'autostart-changed'])
// Eventos fire-and-forget (renderer → main).
const SEND = new Set(['kitchen-prompt:action'])

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, payload) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`canal não permitido: ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  on: (channel, cb) => {
    if (!ON.has(channel) || typeof cb !== 'function') return () => {}
    // Repassa só os args (não o IpcRendererEvent, que não cruza o bridge). O
    // renderer legado espera (event, ...args) → mantém (null, ...args).
    const handler = (_event, ...args) => cb(null, ...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  send: (channel, payload) => {
    if (!SEND.has(channel)) return
    ipcRenderer.send(channel, payload)
  },
})
