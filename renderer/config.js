'use strict'

const { ipcRenderer } = require('electron')

// ─── Init ─────────────────────────────────────────────────────────────────────

// Presets por modelo: colunas + code page + codificação com valores sãos.
const MODEL_PRESETS = {
  dr800:     { cols: 48, codepage: 7,  encoding: 'cp1252' },
  generic80: { cols: 48, codepage: 16, encoding: 'cp1252' },
  generic58: { cols: 32, codepage: 2,  encoding: 'cp850'  },
}

// Marca se a chave atual já foi validada com sucesso no backend.
let pairedOk = false

async function init() {
  const [config, printers, ports, status] = await Promise.all([
    ipcRenderer.invoke('get-config'),
    ipcRenderer.invoke('get-printers'),
    ipcRenderer.invoke('get-ports'),
    ipcRenderer.invoke('get-status'),
  ])

  populatePrinters(printers, config.printerName)
  populatePorts(ports)
  applyConfig(config)
  setStatus(status)
  // Chave já salva conta como pareada (não força revalidar tenant existente).
  pairedOk = !!(config && config.apiKey)

  ipcRenderer.on('status-changed', (_, s) => setStatus(s))

  document.getElementById('btn-save').addEventListener('click', save)
  document.getElementById('btn-test-balcao').addEventListener('click', testPrint)
  document.getElementById('btn-pair').addEventListener('click', pair)
  document.getElementById('printer-model').addEventListener('change', applyModelPreset)

  document.getElementById('token').addEventListener('input', function () {
    pairedOk = false // chave mudou -> precisa validar de novo
    pairFeedback('')
    const hint = document.getElementById('token-hint')
    const v = this.value.trim()
    hint.style.display = v.startsWith('eyJ') ? 'block' : 'none'
  })
}

// ─── Serial ports ───────────────────────────────────────────────────────────────

function populatePorts(ports) {
  const dl = document.getElementById('com-ports')
  if (!dl) return
  dl.innerHTML = ''
  for (const p of ports || []) {
    const opt = document.createElement('option')
    opt.value = p
    dl.appendChild(opt)
  }
}

// ─── Model presets ──────────────────────────────────────────────────────────────

function applyModelPreset() {
  const model = document.getElementById('printer-model').value
  const preset = MODEL_PRESETS[model]
  if (!preset) return // 'custom' -> não mexe nos campos
  document.getElementById('balcao-cols').value = String(preset.cols)
  document.getElementById('codepage').value    = String(preset.codepage)
  document.getElementById('encoding').value     = preset.encoding
}

// ─── Printers ─────────────────────────────────────────────────────────────────

function populatePrinters(printers, selected) {
  const sel = document.getElementById('printer-name')
  sel.innerHTML = ''
  if (!printers || printers.length === 0) {
    sel.innerHTML = '<option value="">-- Nenhuma impressora encontrada --</option>'
    return
  }
  printers.forEach(p => {
    const name = (typeof p === 'string') ? p : (p.name || p.deviceId || p.displayName || JSON.stringify(p))
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = name
    if (name === selected) opt.selected = true
    sel.appendChild(opt)
  })
}

// ─── Config ───────────────────────────────────────────────────────────────────

function applyConfig(config) {
  if (!config) return
  document.getElementById('tenant-name').value    = config.tenantName    || ''
  document.getElementById('tenant-address').value = config.tenantAddress || ''
  document.getElementById('tenant-phone').value   = config.tenantPhone   || ''
  document.getElementById('tenant-cnpj').value    = config.tenantCnpj    || ''
  document.getElementById('server-url').value     = config.serverUrl     || ''
  document.getElementById('token').value          = config.apiKey        || ''
  document.getElementById('com-port').value       = config.comPort       || ''
  document.getElementById('balcao-cols').value    = String(config.balcaoCols || 48)
  document.getElementById('encoding').value       = config.encoding      || 'cp1252'
  document.getElementById('codepage').value       = String(config.codepage ?? 7)
  document.getElementById('printer-model').value  = config.printerModel  || 'dr800'
  document.getElementById('logo-enabled').checked = config.logoEnabled === true
  if (config.printerName) {
    const sel = document.getElementById('printer-name')
    if (sel) sel.value = config.printerName
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function readForm() {
  const cp = parseInt(document.getElementById('codepage').value, 10)
  return {
    tenantName:    document.getElementById('tenant-name').value.trim(),
    tenantAddress: document.getElementById('tenant-address').value.trim(),
    tenantPhone:   document.getElementById('tenant-phone').value.trim(),
    tenantCnpj:    document.getElementById('tenant-cnpj').value.trim(),
    serverUrl:     document.getElementById('server-url').value.trim(),
    apiKey:        document.getElementById('token').value.trim(),
    comPort:       document.getElementById('com-port').value.trim().toUpperCase(),
    printerName:   document.getElementById('printer-name').value,
    printerModel:  document.getElementById('printer-model').value,
    balcaoCols:    parseInt(document.getElementById('balcao-cols').value, 10),
    encoding:      document.getElementById('encoding').value,
    codepage:      Number.isInteger(cp) ? cp : 7,
    logoEnabled:   document.getElementById('logo-enabled').checked,
  }
}

// Validar/parear: confirma a chave contra o backend antes de qualquer save.
async function pair() {
  const serverUrl = document.getElementById('server-url').value.trim()
  const apiKey    = document.getElementById('token').value.trim()
  if (!serverUrl) { pairFeedback('Informe a URL do servidor.', true); return }
  if (!apiKey)    { pairFeedback('Cole a chave do restaurante.', true); return }
  pairFeedback('Validando chave...', false)
  const res = await ipcRenderer.invoke('validate-key', { serverUrl, apiKey })
  pairedOk = !!res.ok
  pairFeedback(res.message, !res.ok)
  return pairedOk
}

async function save() {
  const config = readForm()

  if (!config.serverUrl)   { feedback('URL do servidor é obrigatória.', true); return }
  if (!config.apiKey)      { feedback('Chave do restaurante é obrigatória.', true); return }
  const target = config.comPort && /^COM\d{1,2}$/.test(config.comPort) ? config.comPort : config.printerName
  if (!target)             { feedback('Selecione uma impressora ou porta serial.', true); return }

  // Persiste a chave SÓ após validação bem-sucedida contra o backend.
  if (!pairedOk) {
    feedback('Validando chave antes de salvar...')
    const ok = await pair()
    if (!ok) { feedback('Chave não validada — corrija antes de salvar.', true); return }
  }

  try {
    await ipcRenderer.invoke('save-config', config)
    feedback('Configurações salvas! Reconectando...')
  } catch (e) {
    feedback('Erro ao salvar: ' + e.message, true)
  }
}

// ─── Test print ───────────────────────────────────────────────────────────────

async function testPrint() {
  const comPort = document.getElementById('com-port').value.trim().toUpperCase()
  const printerName = (/^COM\d{1,2}$/.test(comPort)) ? comPort : document.getElementById('printer-name').value
  const cols = parseInt(document.getElementById('balcao-cols').value, 10)
  const cp = parseInt(document.getElementById('codepage').value, 10)
  const encoding = document.getElementById('encoding').value
  if (!printerName) { feedback('Selecione uma impressora ou porta serial primeiro.', true); return }
  feedback('Enviando teste...')
  try {
    await ipcRenderer.invoke('test-print', {
      printerName, cols, type: 'balcao',
      codepage: Number.isInteger(cp) ? cp : 7,
      encoding,
    })
    feedback('Teste enviado!')
  } catch (e) {
    feedback('Erro: ' + (e.message || String(e)), true)
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(status) {
  const el = document.getElementById('status')
  const connected = status === 'connected'
  el.textContent = connected ? '● Conectado' : '● Desconectado'
  el.className   = connected ? 'connected'   : 'disconnected'
}

function pairFeedback(msg, isError = false) {
  const el = document.getElementById('pair-feedback')
  if (!el) return
  el.textContent = msg || ''
  el.style.color = isError ? '#f87171' : '#4ade80'
}

let feedbackTimer = null
function feedback(msg, isError = false) {
  const el = document.getElementById('feedback')
  el.textContent   = msg
  el.style.color   = isError ? '#f87171' : '#4ade80'
  el.style.opacity = '1'
  if (feedbackTimer) clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => { el.style.opacity = '0' }, 3500)
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init)
