'use strict'

const { ipcRenderer } = require('electron')

// ─── Estado ─────────────────────────────────────────────────────────────────────

// Catálogo de perfis (GET /print-agent/printer-profiles via IPC). ÚNICA fonte de
// largura/code page/encoding/corte por modelo — a UI só LÊ daqui.
let _modelCatalog = []
let _loadedConfig = {}      // config do electron-store (preservada no save)
let pairedOk = false        // chave já validada no backend?

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const [config, status, catalog] = await Promise.all([
    ipcRenderer.invoke('get-config'),
    ipcRenderer.invoke('get-status'),
    ipcRenderer.invoke('get-catalog'),
  ])

  _loadedConfig = config || {}
  _modelCatalog = Array.isArray(catalog) ? catalog : []
  applyConfig(_loadedConfig)
  setStatus(status)
  pairedOk = !!(config && config.apiKey)

  ipcRenderer.on('status-changed', (_, s) => setStatus(s))

  document.getElementById('btn-save').addEventListener('click', save)
  document.getElementById('btn-pair').addEventListener('click', pair)
  document.getElementById('btn-save-mapping').addEventListener('click', saveRoutingMapping)

  // Impressoras (surface única).
  loadRoutingTargets()

  document.getElementById('token').addEventListener('input', function () {
    pairedOk = false
    pairFeedback('')
    const hint = document.getElementById('token-hint')
    hint.style.display = this.value.trim().startsWith('eyJ') ? 'block' : 'none'
  })
}

// ─── Perfis (catálogo) ────────────────────────────────────────────────────────

function catProfile(id) {
  if (id == null || id === '') return null
  return _modelCatalog.find((p) => String(p.id) === String(id)) || null
}
function genericProfile() {
  return _modelCatalog.find((p) => p.isGeneric) || null
}
// Perfil efetivo de um alvo: escolhido > dica do alvo > genérico.
function resolvedProfile(t, selectedId) {
  return catProfile(selectedId) || catProfile(t.suggestedProfileId) || genericProfile()
}
// Porta de sistema: serial SEM VID/PID e SEM dica de perfil (ex.: ACPI\PNP0501).
function isSystemPort(t) {
  return t.kind === 'serial' && !t.vendorId && !t.productId && t.suggestedProfileId == null
}

// ─── Impressoras: cards ──────────────────────────────────────────────────────────

async function loadRoutingTargets() {
  const box = document.getElementById('routing-targets')
  try {
    const data = await ipcRenderer.invoke('get-print-targets')
    const { targets, config, setores } = data
    if (!targets || targets.length === 0) {
      box.innerHTML = '<div class="no-printers">Nenhuma impressora detectada.</div>'
      return
    }
    const dflt = (config && config.defaultDeviceKey) || null
    const printersCfg = (config && config.printers) || {}

    box.innerHTML = ''
    const printersGroup = document.createElement('div')
    const others = []

    for (const t of targets) {
      const entry = printersCfg[t.deviceKey] || {}
      const card = buildCard(t, entry, setores || ['COZINHA', 'CAIXA', 'BAR'], dflt)
      if (isSystemPort(t)) others.push(card)
      else printersGroup.appendChild(card)
    }
    box.appendChild(printersGroup)

    // Grupo "Outras portas" — colapsado, não elegível como padrão.
    if (others.length) {
      const det = document.createElement('details')
      det.className = 'group-sub'
      const sum = document.createElement('summary')
      sum.textContent = `Outras portas do sistema (${others.length})`
      det.appendChild(sum)
      others.forEach((c) => det.appendChild(c))
      box.appendChild(det)
    }
  } catch (e) {
    box.innerHTML = '<div class="no-printers">Erro ao carregar impressoras: ' + (e.message || e) + '</div>'
  }
}

function buildCard(t, entry, setores, dflt) {
  const sys = isSystemPort(t)
  const card = document.createElement('div')
  card.className = 'printer-card' + (t.deviceKey === dflt ? ' is-default' : '')
  card.dataset.key = t.deviceKey

  // Cabeçalho: nome + badge de tipo (COM/Spooler/Sistema).
  const head = document.createElement('div')
  head.className = 'pcard-head'
  const title = document.createElement('span')
  title.textContent = t.suggestedProfileName ? `${t.target} — ${t.suggestedProfileName}` : t.target
  head.appendChild(title)
  const badge = document.createElement('span')
  if (sys) { badge.className = 'badge badge-sys'; badge.textContent = 'porta do sistema' }
  else if (t.kind === 'serial') { badge.className = 'badge badge-com'; badge.textContent = 'serial (COM)' }
  else { badge.className = 'badge badge-spool'; badge.textContent = 'spooler windows' }
  head.appendChild(badge)
  const ovrBadge = document.createElement('span')
  ovrBadge.className = 'badge badge-ovr'; ovrBadge.textContent = 'override'
  ovrBadge.style.display = entry.override && entry.override.enabled ? '' : 'none'
  head.appendChild(ovrBadge)
  card.appendChild(head)

  const meta = document.createElement('div')
  meta.className = 'pcard-meta'
  meta.textContent = t.deviceKey + (t.vendorId && t.productId ? ` · VID/PID ${t.vendorId}:${t.productId}` : '')
  card.appendChild(meta)

  if (sys) {
    const warn = document.createElement('div')
    warn.className = 'sys-warn'
    warn.textContent = '⚠️ Porta do sistema, provavelmente não é impressora. Mapeie só se tiver certeza.'
    card.appendChild(warn)
  }

  // Setor + Perfil
  const row = document.createElement('div')
  row.className = 'pc-row'

  const setSel = document.createElement('select')
  setSel.className = 'route-setor'
  setSel.innerHTML = '<option value="">Sem setor</option>'
    + setores.map((s) => `<option value="${s}">${s}</option>`).join('')
  setSel.value = entry.setor || ''
  row.appendChild(field('Setor', setSel))

  const profSel = document.createElement('select')
  profSel.className = 'route-profile'
  profSel.innerHTML = '<option value="">Automático (pela dica)</option>'
    + _modelCatalog.map((p) => `<option value="${p.id}">${p.name}${p.isGeneric ? ' (genérico)' : ''}</option>`).join('')
  profSel.value = entry.profileId != null ? String(entry.profileId) : ''
  row.appendChild(field('Perfil', profSel))
  card.appendChild(row)

  // Cortar papel (ligado por padrão). Desligar suprime o comando de corte no
  // rodapé — p/ impressoras com guilhotina defeituosa (ex.: Elgin i9).
  const cutToggle = document.createElement('label')
  cutToggle.className = 'override-toggle'
  const cutChk = document.createElement('input')
  cutChk.type = 'checkbox'; cutChk.className = 'route-cut'
  cutChk.checked = entry.cortarPapel !== false
  cutToggle.appendChild(cutChk)
  cutToggle.appendChild(document.createTextNode('Cortar papel (guilhotina)'))
  card.appendChild(cutToggle)

  // Ajuste avançado (accordion fechado) — campos crus read-only por padrão.
  const adv = document.createElement('details')
  adv.className = 'pc-adv'
  const advSum = document.createElement('summary')
  advSum.textContent = 'Ajuste avançado'
  adv.appendChild(advSum)
  const advBody = document.createElement('div')
  advBody.className = 'pc-adv-body'

  const ovToggle = document.createElement('label')
  ovToggle.className = 'override-toggle'
  const ovChk = document.createElement('input')
  ovChk.type = 'checkbox'; ovChk.className = 'ov-enabled'
  ovChk.checked = !!(entry.override && entry.override.enabled)
  ovToggle.appendChild(ovChk)
  ovToggle.appendChild(document.createTextNode('Ativar ajuste manual (override do perfil)'))
  advBody.appendChild(ovToggle)

  const colsIn = numInput('ov-cols')
  const cpIn = numInput('ov-codepage')
  const encIn = document.createElement('select')
  encIn.className = 'ov-encoding'
  encIn.innerHTML = ['cp1252', 'cp850', 'cp860', 'utf8'].map((e) => `<option value="${e}">${e}</option>`).join('')
  const cutIn = document.createElement('input')
  cutIn.type = 'text'; cutIn.className = 'ov-cut'; cutIn.placeholder = 'ex: 29,86,66,0'

  const r1 = document.createElement('div'); r1.className = 'pc-row'
  r1.appendChild(field('Largura (col)', colsIn))
  r1.appendChild(field('ESC t n', cpIn))
  advBody.appendChild(r1)
  const r2 = document.createElement('div'); r2.className = 'pc-row'
  r2.appendChild(field('Encoding', encIn))
  r2.appendChild(field('Corte (bytes)', cutIn))
  advBody.appendChild(r2)
  adv.appendChild(advBody)
  card.appendChild(adv)

  // Preenche os campos crus a partir do perfil resolvido (ou do override salvo).
  function fillFromProfile() {
    const prof = resolvedProfile(t, profSel.value)
    const ov = entry.override
    const useOv = ovChk.checked && ov
    colsIn.value = String((useOv && ov.columns) || (prof && prof.columns) || 48)
    cpIn.value = String((useOv && ov.codepageEscT != null ? ov.codepageEscT : (prof ? prof.codepageEscT : 0)))
    encIn.value = (useOv && ov.encoding) || (prof && prof.encoding) || 'cp1252'
    cutIn.value = ((useOv && ov.cut) || (prof && prof.cut) || []).join(',')
  }
  function applyReadonly() {
    const ed = ovChk.checked
    colsIn.readOnly = !ed; cpIn.readOnly = !ed; cutIn.readOnly = !ed; encIn.disabled = !ed
    ovrBadge.style.display = ed ? '' : 'none'
  }
  ovChk.addEventListener('change', () => { if (!ovChk.checked) fillFromProfile(); applyReadonly() })
  // Trocar o perfil reflete IMEDIATAMENTE nos campos crus (corrige ESC t n parado).
  profSel.addEventListener('change', () => { if (!ovChk.checked) fillFromProfile() })
  fillFromProfile()
  applyReadonly()

  // Padrão (radio único) — porta de sistema NÃO pode ser padrão.
  const defLabel = document.createElement('label')
  defLabel.className = 'pc-default'
  const defRadio = document.createElement('input')
  defRadio.type = 'radio'; defRadio.name = 'route-default'; defRadio.value = t.deviceKey
  defRadio.className = 'route-default'
  defRadio.checked = t.deviceKey === dflt && !sys
  defRadio.disabled = sys
  defRadio.addEventListener('change', () => {
    document.querySelectorAll('.printer-card').forEach((c) => c.classList.remove('is-default'))
    if (defRadio.checked) card.classList.add('is-default')
  })
  defLabel.appendChild(defRadio)
  defLabel.appendChild(document.createTextNode(sys ? 'Não pode ser padrão (porta do sistema)' : 'Impressora padrão'))
  card.appendChild(defLabel)

  // Ações: teste por impressora.
  const actions = document.createElement('div')
  actions.className = 'pc-actions'
  const testBtn = document.createElement('button')
  testBtn.type = 'button'; testBtn.className = 'btn-test'; testBtn.textContent = 'Imprimir teste'
  const testFb = document.createElement('span')
  testFb.className = 'pc-feedback'
  testBtn.addEventListener('click', () => testCard(t, profSel, colsIn, cpIn, encIn, testFb, cutChk))
  actions.appendChild(testBtn)
  actions.appendChild(testFb)
  card.appendChild(actions)

  return card
}

function field(text, el) {
  const f = document.createElement('div')
  f.className = 'field'
  const lab = document.createElement('label')
  lab.textContent = text
  f.appendChild(lab); f.appendChild(el)
  return f
}
function numInput(cls) {
  const i = document.createElement('input')
  i.type = 'text'; i.inputMode = 'numeric'; i.className = cls
  return i
}

async function testCard(t, profSel, colsIn, cpIn, encIn, fb, cutChk) {
  const prof = resolvedProfile(t, profSel.value)
  fb.style.color = '#9ca3af'; fb.textContent = 'Enviando teste...'
  try {
    await ipcRenderer.invoke('test-print', {
      printerName: t.target,
      profileId: prof ? prof.id : null,
      cols: parseInt(colsIn.value, 10) || (prof && prof.columns) || 48,
      type: 'balcao',
      codepage: parseInt(cpIn.value, 10),
      encoding: encIn.value,
      cortarPapel: cutChk ? cutChk.checked : true,
    })
    fb.style.color = '#4ade80'; fb.textContent = 'Teste enviado!'
  } catch (e) {
    fb.style.color = '#f87171'; fb.textContent = 'Erro: ' + (e.message || e)
  }
}

async function saveRoutingMapping() {
  const fb = document.getElementById('routing-feedback')
  const printers = {}
  let defaultDeviceKey = null
  document.querySelectorAll('.printer-card').forEach((card) => {
    const key = card.dataset.key
    const setor = card.querySelector('.route-setor').value || null
    const profileId = card.querySelector('.route-profile').value
    const ovEnabled = card.querySelector('.ov-enabled').checked
    const cortarPapel = card.querySelector('.route-cut') ? card.querySelector('.route-cut').checked : true
    const entry = { setor, profileId: profileId ? Number(profileId) : null, cortarPapel }
    if (ovEnabled) {
      const cut = String(card.querySelector('.ov-cut').value || '')
        .split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isInteger(n))
      entry.override = {
        enabled: true,
        columns: parseInt(card.querySelector('.ov-cols').value, 10) || null,
        codepageEscT: parseInt(card.querySelector('.ov-codepage').value, 10),
        encoding: card.querySelector('.ov-encoding').value || null,
        cut: cut.length ? cut : null,
      }
    }
    printers[key] = entry
    const def = card.querySelector('.route-default')
    if (def && def.checked && !def.disabled) defaultDeviceKey = key
  })
  try {
    const res = await ipcRenderer.invoke('save-printer-mapping', { printers, defaultDeviceKey })
    fb.style.color = res.ok ? '#4ade80' : '#f87171'
    fb.textContent = res.ok ? 'Impressoras salvas!' : ('Erro: ' + (res.message || 'desconhecido'))
    if (res.ok) loadRoutingTargets() // recarrega refletindo override/padrão salvos
  } catch (e) {
    fb.style.color = '#f87171'; fb.textContent = 'Erro: ' + (e.message || e)
  }
}

// ─── Config (tenant + conexão + logo) ────────────────────────────────────────────

function applyConfig(config) {
  if (!config) return
  document.getElementById('tenant-name').value    = config.tenantName    || ''
  document.getElementById('tenant-address').value = config.tenantAddress || ''
  document.getElementById('tenant-phone').value   = config.tenantPhone   || ''
  document.getElementById('tenant-cnpj').value    = config.tenantCnpj    || ''
  document.getElementById('server-url').value     = config.serverUrl     || ''
  document.getElementById('token').value          = config.apiKey        || ''
  document.getElementById('logo-enabled').checked = config.logoEnabled === true
}

// Preserva os campos legados (comPort/printerName/encoding/...) — a impressora
// agora é gerida pelos cards/printers-config; aqui só editamos tenant/conexão/logo.
function readForm() {
  return {
    ..._loadedConfig,
    tenantName:    document.getElementById('tenant-name').value.trim(),
    tenantAddress: document.getElementById('tenant-address').value.trim(),
    tenantPhone:   document.getElementById('tenant-phone').value.trim(),
    tenantCnpj:    document.getElementById('tenant-cnpj').value.trim(),
    serverUrl:     document.getElementById('server-url').value.trim(),
    apiKey:        document.getElementById('token').value.trim(),
    logoEnabled:   document.getElementById('logo-enabled').checked,
  }
}

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
  if (!config.serverUrl) { feedback('URL do servidor é obrigatória.', true); return }
  if (!config.apiKey)    { feedback('Chave do restaurante é obrigatória.', true); return }

  if (!pairedOk) {
    feedback('Validando chave antes de salvar...')
    const ok = await pair()
    if (!ok) { feedback('Chave não validada — corrija antes de salvar.', true); return }
  }
  try {
    await ipcRenderer.invoke('save-config', config)
    _loadedConfig = config
    feedback('Configurações salvas! Reconectando...')
  } catch (e) {
    feedback('Erro ao salvar: ' + e.message, true)
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

document.addEventListener('DOMContentLoaded', init)
