'use strict'

// Assistente de onboarding: Parear por código -> Impressora -> Pronto.
// O e-mail+senha continua disponível como caminho SECUNDÁRIO (com 2FA se preciso)
// para quem já usava — mas conta criada via Google não tem senha, então o código
// é o caminho principal.
//
// Esta tela NÃO mostra URL de servidor nem porta COM. A URL é fixa (config-defaults.js)
// e a impressora vem da detecção que já existia (deviceKey/printers-config.json) —
// aqui só apresentamos nome legível, setor e teste.

const { ipcRenderer } = require('electron')

// ─── Estado ───────────────────────────────────────────────────────────────────

let _cfg = {}          // config do electron-store
let _targets = []      // alvos detectados (get-print-targets)
let _mapping = {}      // printers-config.printers (deviceKey -> entry)
let _setores = ['COZINHA', 'CAIXA', 'BAR']
let _active = []       // deviceKeys EM USO (várias ao mesmo tempo), na ordem escolhida
let _sectorOf = {}     // deviceKey -> setor ('' = todos os pedidos)
let _otpState = null   // { tempToken, email } enquanto o 2FA está pendente
let _verClicks = 0
let _verTimer = null

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const [cfg, status, info] = await Promise.all([
    ipcRenderer.invoke('get-config'),
    ipcRenderer.invoke('get-status'),
    ipcRenderer.invoke('get-app-info'),
  ])
  _cfg = cfg || {}
  setStatus(status)
  applyAdvanced(_cfg, info)

  ipcRenderer.on('status-changed', (_, s) => setStatus(s))
  // "Trocar conta" pela bandeja: a janela já aberta volta pro pareamento.
  ipcRenderer.on('account-changed', () => { void afterAccountCleared() })

  // Passo 1: pareamento por código
  byId('btn-pair').addEventListener('click', doPair)
  byId('pair-code').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6)
    if (this.value.length === 6) doPair()
  })
  byId('pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPair() })
  byId('btn-use-password').addEventListener('click', () => { show('login'); byId('email').focus() })
  byId('btn-use-code').addEventListener('click', () => { show('pair'); byId('pair-code').focus() })
  byId('btn-switch-account').addEventListener('click', doLogout)

  // Passo 1 (alternativo): e-mail e senha
  byId('btn-login').addEventListener('click', doLogin)
  byId('senha').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin() })
  byId('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') byId('senha').focus() })

  // Passo 1b (2FA)
  byId('btn-otp').addEventListener('click', doVerifyOtp)
  byId('btn-otp-back').addEventListener('click', () => { _otpState = null; show('login') })
  byId('btn-otp-resend').addEventListener('click', doResendOtp)
  byId('otp-code').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6)
    if (this.value.length === 6) doVerifyOtp()
  })

  // Passo 2
  byId('btn-rescan').addEventListener('click', () => loadPrinters(true))
  byId('btn-printer-next').addEventListener('click', finishPrinterStep)
  byId('btn-add').addEventListener('click', (e) => { e.stopPropagation(); toggleAddDrop() })
  byId('add-search').addEventListener('input', renderAddList)
  byId('add-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleAddDrop(false) })
  byId('adddrop').addEventListener('click', (e) => e.stopPropagation())
  document.addEventListener('click', () => toggleAddDrop(false))

  // Passo 3
  byId('btn-tray').addEventListener('click', () => ipcRenderer.invoke('hide-to-tray'))
  byId('btn-back-printer').addEventListener('click', () => { show('printer'); loadPrinters(false) })
  byId('btn-logout').addEventListener('click', doLogout)

  // Avançado (dev): Ctrl+Shift+D ou 5 cliques na linha da versão.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); toggleAdvanced() }
  })
  byId('app-version').addEventListener('click', () => {
    _verClicks++
    if (_verTimer) clearTimeout(_verTimer)
    _verTimer = setTimeout(() => { _verClicks = 0 }, 1500)
    if (_verClicks >= 5) { _verClicks = 0; toggleAdvanced() }
  })
  byId('btn-adv-close').addEventListener('click', () => toggleAdvanced(false))
  byId('btn-adv-save').addEventListener('click', saveAdvanced)
  byId('dev-mode').addEventListener('change', refreshDevHint)
  byId('dev-url').addEventListener('input', refreshDevHint)

  applyAccount(_cfg)

  // Já pareado (credencial salva) → pula direto pro passo da impressora ou pro Pronto.
  if (_cfg.apiKey) {
    show('printer')
    await loadPrinters(false)
    if (_active.length) renderDone()
  } else {
    show('pair')
    byId('pair-code').focus()
  }
}

// Faixa "Conectado em: <estabelecimento>" — permanente enquanto houver
// pareamento, para nunca haver dúvida de qual conta este computador imprime.
function applyAccount(cfg) {
  const nome = (cfg && (cfg.estabelecimento || cfg.tenantName)) || ''
  const box = byId('account')
  byId('account-name').textContent = nome || '—'
  box.classList.toggle('on', !!(cfg && cfg.apiKey && nome))
}

// ─── Passo 1: pareamento por código ───────────────────────────────────────────

async function doPair() {
  const codigo = byId('pair-code').value.replace(/\D/g, '')
  if (codigo.length < 6) { msg('pair-msg', 'O código tem 6 dígitos.', 'err'); return }
  const btn = byId('btn-pair')
  if (btn.disabled) return
  msg('pair-msg', 'Pareando...', 'dim')
  btn.disabled = true
  try {
    const res = await ipcRenderer.invoke('agent-pair', { codigo })
    if (!res || !res.ok) {
      msg('pair-msg', (res && res.message) || 'Não foi possível parear.', 'err')
      if (res && res.retry) { byId('pair-code').value = ''; byId('pair-code').focus() }
      return
    }
    byId('pair-code').value = ''
    msg('pair-msg', '', 'dim')
    await afterLogin(res)
  } finally {
    btn.disabled = false
  }
}

// ─── Passo 1: login ───────────────────────────────────────────────────────────

async function doLogin() {
  const email = byId('email').value.trim()
  const senha = byId('senha').value
  const btn = byId('btn-login')
  msg('login-msg', 'Entrando...', 'dim')
  btn.disabled = true
  try {
    const res = await ipcRenderer.invoke('agent-login', { email, senha })
    if (res && res.requiresOtp) {
      _otpState = { tempToken: res.tempToken, email: res.email }
      byId('otp-sub').textContent = `Enviamos um código de 6 dígitos para ${res.email}.`
      byId('otp-code').value = ''
      msg('otp-msg', '', 'dim')
      msg('login-msg', '', 'dim')
      show('otp')
      byId('otp-code').focus()
      return
    }
    if (!res || !res.ok) { msg('login-msg', (res && res.message) || 'Falha ao entrar.', 'err'); return }
    await afterLogin(res)
  } finally {
    btn.disabled = false
  }
}

// ─── Passo 1b: 2FA ────────────────────────────────────────────────────────────

async function doVerifyOtp() {
  if (!_otpState) { show('login'); return }
  const code = byId('otp-code').value.replace(/\D/g, '')
  if (code.length < 6) { msg('otp-msg', 'O código tem 6 dígitos.', 'err'); return }
  const btn = byId('btn-otp')
  msg('otp-msg', 'Verificando...', 'dim')
  btn.disabled = true
  try {
    const res = await ipcRenderer.invoke('agent-verify-otp', { tempToken: _otpState.tempToken, code })
    if (!res || !res.ok) {
      msg('otp-msg', (res && res.message) || 'Código inválido.', 'err')
      if (res && res.retryOtp) { byId('otp-code').value = ''; byId('otp-code').focus() }
      return
    }
    _otpState = null
    await afterLogin(res)
  } finally {
    btn.disabled = false
  }
}

async function doResendOtp() {
  if (!_otpState) return
  msg('otp-msg', 'Reenviando...', 'dim')
  const res = await ipcRenderer.invoke('agent-resend-otp', { tempToken: _otpState.tempToken })
  if (res && res.ok) {
    if (res.tempToken) _otpState.tempToken = res.tempToken
    msg('otp-msg', res.message || 'Novo código enviado.', 'ok')
  } else {
    msg('otp-msg', (res && res.message) || 'Não foi possível reenviar.', 'err')
  }
}

// Login concluído (com ou sem 2FA): a apiKey já está salva pelo main. Segue pro passo 2.
async function afterLogin(res) {
  _cfg = await ipcRenderer.invoke('get-config')
  applyHeaderFields(_cfg)
  applyAccount(_cfg)
  msg('login-msg', '', 'dim')
  show('printer')
  await loadPrinters(true)
}

// ─── Passo 2: impressora ──────────────────────────────────────────────────────

// Nome amigável: prefere o modelo reconhecido; nunca devolve "COM7" cru.
function friendlyName(t) {
  const entry = _mapping[t.deviceKey] || {}
  const model = t.suggestedProfileName || null
  if (model) return model
  if (t.kind === 'windows') return String(t.target || '').replace(/\s*\(Windows\)\s*$/i, '') || 'Impressora do Windows'
  const maker = t.manufacturer || null
  if (maker && !/^\(standard/i.test(maker)) return `Impressora ${maker}`
  if (entry.label && !/^COM\d+$/i.test(entry.label)) return entry.label
  return 'Impressora térmica'
}

// Como ela está ligada — linguagem de cliente, sem deviceKey nem VID/PID.
function howConnected(t) {
  if (t.kind === 'windows') return 'Instalada no Windows'
  const port = String(t.target || '')
  return port ? `Conectada por USB · porta ${port}` : 'Conectada por USB'
}

// Porta de sistema (ACPI etc.): serial sem VID/PID e sem dica de perfil. Não é
// impressora — fica fora da lista do cliente para não confundir.
function isSystemPort(t) {
  return t.kind === 'serial' && !t.vendorId && !t.productId && t.suggestedProfileId == null
}

async function loadPrinters(autoSelect) {
  const list = byId('plist')
  byId('printer-sub').textContent = 'Procurando impressoras conectadas...'
  list.innerHTML = ''
  msg('printer-msg', '', 'dim')

  let data
  try {
    data = await ipcRenderer.invoke('get-print-targets')
  } catch (e) {
    byId('printer-sub').textContent = 'Não foi possível procurar impressoras.'
    msg('printer-msg', String((e && e.message) || e), 'err')
    return
  }

  _setores = (data && data.setores) || _setores
  _mapping = (data && data.config && data.config.printers) || {}
  const all = (data && data.targets) || []
  _targets = all.filter((t) => !isSystemPort(t))

  // Ativas salvas (ativa===true). Config antigo, sem a flag: a principal
  // (defaultDeviceKey) vira a única ativa — nada muda pra quem já usava.
  const detected = _targets.map((t) => t.deviceKey)
  _active = detected.filter((k) => _mapping[k] && _mapping[k].ativa === true)
  if (!_active.length && !Object.values(_mapping).some((e) => e && typeof e.ativa === 'boolean')) {
    const dflt = data && data.config && data.config.defaultDeviceKey
    if (dflt && detected.includes(dflt)) _active = [dflt]
  }
  _sectorOf = {}
  for (const k of detected) _sectorOf[k] = (_mapping[k] && _mapping[k].setor) || ''

  if (_targets.length === 0) {
    byId('printer-sub').textContent = 'Nenhuma impressora encontrada.'
    list.innerHTML = '<div class="empty">Ligue a impressora e conecte o cabo USB,<br />depois clique em <b>Reescanear</b>.</div>'
    byId('btn-add').disabled = true
    byId('btn-printer-next').disabled = true
    return
  }
  byId('btn-add').disabled = false

  // Só UMA detectada e nenhuma escolhida ainda: já entra como ativa (o cliente
  // só confirma com o teste). Com várias, ele escolhe quais quer usar.
  if (autoSelect && !_active.length && _targets.length === 1) _active = [_targets[0].deviceKey]

  renderActive()
}

// ── Cards das impressoras EM USO ──────────────────────────────────────────────

function renderActive() {
  const list = byId('plist')
  list.innerHTML = ''

  const n = _targets.length
  const sub = byId('printer-sub')
  if (!_active.length) {
    sub.textContent = n === 1
      ? 'Encontramos 1 impressora. Adicione ela para começar a imprimir.'
      : `Encontramos ${n} impressoras. Adicione as que você vai usar — pode ser mais de uma.`
    list.innerHTML = '<div class="empty">Nenhuma impressora em uso.<br />Clique em <b>+ Adicionar impressora</b>.</div>'
  } else {
    sub.textContent = _active.length === 1
      ? 'Imprima um teste para confirmar que é essa a impressora. Você pode adicionar outras.'
      : `${_active.length} impressoras em uso. Diga o setor de cada uma e imprima um teste em cada.`
    for (const key of _active) {
      const t = _targets.find((x) => x.deviceKey === key)
      if (t) list.appendChild(buildCard(t))
    }
  }

  renderAddList()
  byId('btn-printer-next').disabled = !_active.length
}

function buildCard(t) {
  const card = el('div', 'pcard active')
  card.dataset.key = t.deviceKey

  const top = el('div', 'pcard-top')
  const body = el('div', 'pcard-body')
  body.appendChild(el('div', 'pcard-name', friendlyName(t)))
  body.appendChild(el('div', 'pcard-how', howConnected(t)))
  top.appendChild(body)

  const x = document.createElement('button')
  x.type = 'button'; x.className = 'pcard-x'; x.textContent = '✕'
  x.title = 'Não usar esta impressora'
  x.addEventListener('click', () => removeActive(t.deviceKey))
  top.appendChild(x)
  card.appendChild(top)

  const tools = el('div', 'pcard-tools')

  // Setor por impressora — independente entre elas.
  const sel = document.createElement('select')
  sel.className = 'sector'
  sel.innerHTML = '<option value="">Todos os pedidos</option>'
    + _setores.map((s) => `<option value="${s}">${sectorLabel(s)}</option>`).join('')
  sel.value = _sectorOf[t.deviceKey] || ''
  sel.addEventListener('change', () => {
    _sectorOf[t.deviceKey] = sel.value
    void persistPrinters()
  })
  tools.appendChild(sel)

  const testBtn = document.createElement('button')
  testBtn.type = 'button'; testBtn.className = 'btn-ghost'; testBtn.textContent = 'Imprimir teste'
  const fb = el('span', 'pcard-fb')
  testBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    testBtn.disabled = true
    fb.style.color = '#9ca3af'; fb.textContent = 'Enviando...'
    try {
      const prev = _mapping[t.deviceKey] || {}
      await ipcRenderer.invoke('test-print', {
        printerName: t.target,
        profileId: prev.profileId ?? t.suggestedProfileId ?? null,
        cortarPapel: prev.cortarPapel !== false,
      })
      fb.style.color = '#4ade80'; fb.textContent = 'Saiu na impressora?'
    } catch (err) {
      fb.style.color = '#f87171'; fb.textContent = 'Erro: ' + ((err && err.message) || err)
    } finally {
      testBtn.disabled = false
    }
  })
  tools.appendChild(testBtn)
  tools.appendChild(fb)
  card.appendChild(tools)

  return card
}

// ── "+ Adicionar impressora": dropdown com busca ──────────────────────────────

function toggleAddDrop(force) {
  const drop = byId('adddrop')
  const on = force === undefined ? !drop.classList.contains('on') : !!force
  drop.classList.toggle('on', on)
  if (on) { renderAddList(); byId('add-search').focus() }
  else { byId('add-search').value = '' }
}

// Lista só as DETECTADAS que ainda não estão em uso, filtradas pela busca.
function renderAddList() {
  const box = byId('add-list')
  if (!box) return
  const q = (byId('add-search').value || '').trim().toLowerCase()
  const livres = _targets
    .filter((t) => !_active.includes(t.deviceKey))
    .filter((t) => !q || friendlyName(t).toLowerCase().includes(q) || String(t.target || '').toLowerCase().includes(q))

  box.innerHTML = ''
  if (!livres.length) {
    box.appendChild(el('div', 'aitem-empty', q ? 'Nenhuma impressora com esse nome.' : 'Todas as impressoras já estão em uso.'))
    return
  }
  for (const t of livres) {
    const item = el('div', 'aitem')
    item.appendChild(el('div', 'aitem-name', friendlyName(t)))
    item.appendChild(el('div', 'aitem-how', howConnected(t)))
    item.addEventListener('click', () => addActive(t.deviceKey))
    box.appendChild(item)
  }
}

function addActive(key) {
  if (_active.includes(key)) return
  _active.push(key)
  toggleAddDrop(false)
  renderActive()
  void persistPrinters()
}

function removeActive(key) {
  _active = _active.filter((k) => k !== key)
  renderActive()
  void persistPrinters()
}

function sectorLabel(s) {
  if (s === 'COZINHA') return 'Só cozinha'
  if (s === 'CAIXA') return 'Só caixa'
  if (s === 'BAR') return 'Só bar'
  return s
}

// Salva ativas + setor de cada uma reusando o MESMO IPC de sempre. Chamado a cada
// mudança (adicionar/remover/trocar setor) — não depende do botão Concluir.
async function persistPrinters() {
  const printers = {}
  for (const t of _targets) {
    const key = t.deviceKey
    const prev = _mapping[key] || {}
    printers[key] = {
      ativa: _active.includes(key),
      setor: _sectorOf[key] || null,
      // Preserva o que já estava salvo (perfil, corte, override do modo avançado).
      profileId: prev.profileId ?? null,
      cortarPapel: prev.cortarPapel !== false,
      ...(prev.override ? { override: prev.override } : {}),
    }
  }
  try {
    const res = await ipcRenderer.invoke('save-printer-mapping', {
      printers,
      defaultDeviceKey: _active[0] || null, // "principal" p/ quem exige uma: a 1ª ativa
    })
    if (!res || !res.ok) { msg('printer-msg', (res && res.message) || 'Erro ao salvar.', 'err'); return false }
    _mapping = (res.config && res.config.printers) || _mapping
    msg('printer-msg', '', 'dim')
    return true
  } catch (e) {
    msg('printer-msg', String((e && e.message) || e), 'err')
    return false
  }
}

async function finishPrinterStep() {
  if (!_active.length) return
  const btn = byId('btn-printer-next')
  btn.disabled = true
  msg('printer-msg', 'Salvando...', 'dim')
  try {
    if (!(await persistPrinters())) return
    renderDone()
    show('done')
  } finally {
    btn.disabled = false
  }
}

// ─── Passo 3: pronto ──────────────────────────────────────────────────────────

function renderDone() {
  const facts = byId('done-facts')
  facts.innerHTML = ''
  addFact(facts, 'Restaurante', _cfg.tenantName || '—')
  if (!_active.length) {
    addFact(facts, 'Impressora', '—')
  } else {
    for (const key of _active) {
      const t = _targets.find((x) => x.deviceKey === key)
      const setor = _sectorOf[key]
      addFact(facts, t ? friendlyName(t) : 'Impressora', setor ? sectorLabel(setor) : 'Todos os pedidos')
    }
  }
  const estab = _cfg.estabelecimento || _cfg.tenantName
  if (estab) addFact(facts, 'Estabelecimento', estab)
  if (_cfg.userEmail) addFact(facts, 'Conta', _cfg.userEmail)
}

function addFact(box, k, v) {
  const row = el('div', 'fact')
  row.appendChild(el('span', 'fact-k', k))
  row.appendChild(el('span', 'fact-v', v))
  box.appendChild(row)
}

// "Trocar conta"/"Sair desta conta": o main revoga a credencial e limpa o local.
async function doLogout() {
  msg('done-msg', 'Saindo...', 'dim')
  const res = await ipcRenderer.invoke('agent-logout')
  await afterAccountCleared((res && res.message) || 'Sessão encerrada neste computador.')
}

// Volta pro pareamento com a tela limpa. Serve tanto pro botão daqui quanto pro
// "Trocar conta" da bandeja (evento account-changed).
async function afterAccountCleared(mensagem) {
  _cfg = await ipcRenderer.invoke('get-config')
  _active = []
  _otpState = null
  byId('email').value = ''
  byId('senha').value = ''
  byId('pair-code').value = ''
  applyAccount(_cfg)
  msg('done-msg', '', 'dim')
  msg('login-msg', '', 'dim')
  msg('pair-msg', mensagem || 'Sessão encerrada neste computador.', 'ok')
  show('pair')
  byId('pair-code').focus()
}

// ─── Avançado (dev) ───────────────────────────────────────────────────────────

function applyAdvanced(cfg, info) {
  byId('app-version').textContent = info && info.version
    ? `Impressão automática de pedidos · v${info.version}`
    : 'Impressão automática de pedidos'
  byId('dev-mode').checked = cfg.devMode === true
  byId('dev-url').value = cfg.devServerUrl || (info && info.devUrlDefault) || ''
  byId('logo-enabled').checked = cfg.logoEnabled === true
  applyHeaderFields(cfg)
  refreshDevHint()
}

function applyHeaderFields(cfg) {
  byId('tenant-name').value = cfg.tenantName || ''
  byId('tenant-address').value = cfg.tenantAddress || ''
  byId('tenant-phone').value = cfg.tenantPhone || ''
  byId('tenant-cnpj').value = cfg.tenantCnpj || ''
}

function refreshDevHint() {
  const on = byId('dev-mode').checked
  const urlIn = byId('dev-url')
  urlIn.disabled = !on
  ipcRenderer.invoke('preview-server-url', { devMode: on, devServerUrl: urlIn.value })
    .then((u) => { byId('dev-url-hint').textContent = `O agente vai usar: ${u}` })
    .catch(() => { byId('dev-url-hint').textContent = '' })
}

function toggleAdvanced(force) {
  const box = byId('advanced')
  const on = force === undefined ? !box.classList.contains('on') : !!force
  box.classList.toggle('on', on)
  if (on) box.scrollIntoView({ behavior: 'smooth', block: 'end' })
}

async function saveAdvanced() {
  msg('adv-msg', 'Salvando...', 'dim')
  try {
    const res = await ipcRenderer.invoke('save-advanced', {
      devMode: byId('dev-mode').checked,
      devServerUrl: byId('dev-url').value.trim(),
      logoEnabled: byId('logo-enabled').checked,
      tenantName: byId('tenant-name').value.trim(),
      tenantAddress: byId('tenant-address').value.trim(),
      tenantPhone: byId('tenant-phone').value.trim(),
      tenantCnpj: byId('tenant-cnpj').value.trim(),
    })
    _cfg = await ipcRenderer.invoke('get-config')
    msg('adv-msg', (res && res.message) || 'Salvo.', 'ok')
    refreshDevHint()
  } catch (e) {
    msg('adv-msg', 'Erro: ' + ((e && e.message) || e), 'err')
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function byId(id) { return document.getElementById(id) }

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const PANELS = ['pair', 'login', 'otp', 'printer', 'done']
const STEP_OF = { pair: 1, login: 1, otp: 1, printer: 2, done: 3 }

function show(name) {
  PANELS.forEach((p) => byId('panel-' + p).classList.toggle('on', p === name))
  const cur = STEP_OF[name] || 1
  for (let i = 1; i <= 3; i++) {
    const s = byId('st-' + i)
    s.classList.toggle('active', i === cur)
    s.classList.toggle('done', i < cur)
  }
}

function setStatus(status) {
  const elx = byId('status')
  const on = status === 'connected'
  elx.textContent = on ? '● Conectado' : '● Desconectado'
  elx.className = on ? 'connected' : 'disconnected'
}

function msg(id, text, kind) {
  const n = byId(id)
  if (!n) return
  n.textContent = text || ''
  n.className = 'msg ' + (kind || 'dim')
}

document.addEventListener('DOMContentLoaded', init)
