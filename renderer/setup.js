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
let _status = 'disconnected'
let _connectedSince = null // Date em que ESTA janela viu a conexão subir
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

  // Iniciar com o Windows: o toggle e o item da bandeja mudam o mesmo estado.
  byId('autostart').addEventListener('change', onAutoStartToggle)
  ipcRenderer.on('autostart-changed', (_, on) => { byId('autostart').checked = !!on })
  // Ao voltar pra janela, relê do sistema — pode ter mudado por fora.
  window.addEventListener('focus', () => { void refreshAutoStart() })
  void refreshAutoStart()
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
  initTema()

  // Sem internet: faixa no topo (o socket já tenta reconectar sozinho).
  const net = () => byId('net-banner').classList.toggle('on', !navigator.onLine)
  window.addEventListener('online', net)
  window.addEventListener('offline', net)
  net()

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
  byId('account-avatar').textContent = (nome.trim()[0] || '—').toUpperCase()
  box.classList.toggle('on', !!(cfg && cfg.apiKey && nome))
  renderSince()
}

function hhmm(d) {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function renderSince() {
  const elx = byId('account-since')
  if (!elx) return
  elx.textContent = _status === 'connected'
    ? (_connectedSince ? `Conectado desde ${hhmm(_connectedSince)}` : 'Conectado agora')
    : _status === 'reconnecting' ? 'Reconectando…' : 'Sem conexão com o servidor'
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
  // A busca de impressoras corre por baixo enquanto a transição toca.
  const carregando = loadPrinters(true)
  await playConnectAnimation(_cfg.estabelecimento || _cfg.tenantName || '')
  show('printer')
  await carregando
}

// Anel pulsando no logo → check verde → nome do estabelecimento (~1.2s).
// Movimento reduzido: só a troca de estado, sem espera.
function playConnectAnimation(nome) {
  const reduz = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduz) return Promise.resolve()
  const ov = byId('connect-ov')
  byId('cx-name').textContent = nome
  byId('cx-label').textContent = 'Conectando…'
  ov.classList.remove('ok', 'show')
  ov.classList.add('on')
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  return (async () => {
    await wait(16)
    ov.classList.add('show')
    await wait(520)
    byId('cx-label').textContent = 'Conectado em'
    ov.classList.add('ok')
    await wait(700)
    ov.classList.remove('show')
    await wait(250)
    ov.classList.remove('on', 'ok')
  })()
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
  list.innerHTML = '<div class="skel"></div>'
  msg('printer-msg', '', 'dim')
  const rescan = byId('btn-rescan')
  rescan.disabled = true
  rescan.innerHTML = '<span class="spin"></span>Procurando…'

  let data
  try {
    data = await ipcRenderer.invoke('get-print-targets')
  } catch (e) {
    byId('printer-sub').textContent = 'Não foi possível procurar impressoras.'
    list.innerHTML = ''
    list.appendChild(emptyState(ICON_ALERT, 'Falha ao procurar impressoras', 'Clique em <b>Reescanear</b> para tentar de novo.'))
    msg('printer-msg', String((e && e.message) || e), 'err')
    return
  } finally {
    rescan.disabled = false
    rescan.textContent = 'Reescanear'
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
    list.innerHTML = ''
    list.appendChild(emptyState(ICON_PRINTER, 'Nenhuma impressora encontrada', 'Ligue a impressora e conecte o cabo USB,<br />depois clique em <b>Reescanear</b>.'))
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
    list.appendChild(emptyState(ICON_PRINTER, 'Nenhuma impressora em uso', 'Clique em <b>Adicionar impressora</b> logo abaixo.'))
  } else {
    sub.textContent = _active.length === 1
      ? 'Imprima um teste para confirmar que é essa a impressora. Você pode adicionar outras.'
      : `${_active.length} impressoras em uso. Diga o setor de cada uma e imprima um teste em cada.`
    let i = 0
    for (const key of _active) {
      const t = _targets.find((x) => x.deviceKey === key)
      if (!t) continue
      const card = buildCard(t)
      card.style.animationDelay = `${Math.min(i++, 6) * 50}ms`
      list.appendChild(card)
    }
  }

  renderAddList()
  byId('btn-printer-next').disabled = !_active.length
}

const ICON_PRINTER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/></svg>'
const ICON_ALERT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>'
const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
const ICON_X = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
const ICON_CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'

function emptyState(icon, title, html) {
  const box = el('div', 'empty')
  const ico = el('div', 'empty-ico'); ico.innerHTML = icon
  box.appendChild(ico)
  box.appendChild(el('div', 'empty-title', title))
  const p = el('div'); p.innerHTML = html
  box.appendChild(p)
  return box
}

// Select de setor (custom). Mesmos valores do <select> antigo: '' = todos.
function buildSectorSelect(value, onChange) {
  const opts = [{ v: '', l: 'Todos os pedidos' }].concat(_setores.map((s) => ({ v: s, l: sectorLabel(s) })))
  const wrap = el('div', 'xsel')
  const btn = document.createElement('button')
  btn.type = 'button'; btn.className = 'xsel-btn'
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false')
  const lbl = el('span')
  btn.appendChild(lbl)
  btn.insertAdjacentHTML('beforeend', ICON_CHEVRON)
  const menu = el('div', 'xsel-menu'); menu.setAttribute('role', 'listbox')
  let cur = value || ''
  let hl = -1

  const paint = () => {
    lbl.textContent = (opts.find((o) => o.v === cur) || opts[0]).l
    menu.querySelectorAll('.xsel-opt').forEach((n, i) => {
      n.classList.toggle('sel', opts[i].v === cur)
      n.classList.toggle('hl', i === hl)
      n.setAttribute('aria-selected', opts[i].v === cur ? 'true' : 'false')
    })
  }
  const onDoc = (e) => { if (!wrap.contains(e.target)) close() }
  function close() {
    menu.classList.remove('on'); btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onDoc, true)
  }
  const open = () => {
    // Abre pra cima quando não cabe abaixo (janela baixa / último card).
    const r = btn.getBoundingClientRect()
    menu.classList.toggle('up', window.innerHeight - r.bottom < opts.length * 36 + 80)
    menu.classList.add('on'); btn.setAttribute('aria-expanded', 'true')
    hl = Math.max(0, opts.findIndex((o) => o.v === cur)); paint()
    document.addEventListener('click', onDoc, true)
  }
  const pick = (v) => {
    close()
    if (v === cur) return
    cur = v; paint(); onChange(v)
  }
  opts.forEach((o) => {
    const it = document.createElement('button')
    it.type = 'button'; it.className = 'xsel-opt'; it.setAttribute('role', 'option')
    it.appendChild(el('span', '', o.l))
    it.insertAdjacentHTML('beforeend', '<span class="ck">' + ICON_CHECK + '</span>')
    it.addEventListener('click', (e) => { e.stopPropagation(); pick(o.v) })
    menu.appendChild(it)
  })
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu.classList.contains('on')) close(); else open()
  })
  btn.addEventListener('keydown', (e) => {
    const aberto = menu.classList.contains('on')
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!aberto) { open(); return }
      hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; paint()
    } else if ((e.key === 'Enter' || e.key === ' ') && aberto) {
      e.preventDefault(); pick(opts[hl].v)
    } else if (e.key === 'Escape' && aberto) {
      e.preventDefault(); close()
    }
  })
  wrap.appendChild(btn); wrap.appendChild(menu)
  paint()
  return wrap
}

function buildCard(t) {
  const card = el('div', 'pcard active')
  card.dataset.key = t.deviceKey

  const top = el('div', 'pcard-top')
  const ico = el('div', 'p-ico'); ico.innerHTML = ICON_PRINTER + '<span class="p-dot"></span>'
  top.appendChild(ico)
  const body = el('div', 'pcard-body')
  body.appendChild(el('div', 'pcard-name', friendlyName(t)))
  const how = el('div', 'pcard-how')
  const st = el('span', 'st', 'Pronta')
  how.appendChild(st)
  how.appendChild(el('span', '', '·'))
  how.appendChild(el('span', '', howConnected(t)))
  body.appendChild(how)
  top.appendChild(body)

  const x = document.createElement('button')
  x.type = 'button'; x.className = 'pcard-x'; x.innerHTML = ICON_X
  x.title = 'Não usar esta impressora'
  x.setAttribute('aria-label', 'Não usar esta impressora')
  top.appendChild(x)
  card.appendChild(top)

  const tools = el('div', 'pcard-tools')

  // Setor por impressora — independente entre elas.
  tools.appendChild(buildSectorSelect(_sectorOf[t.deviceKey] || '', (v) => {
    _sectorOf[t.deviceKey] = v
    void persistPrinters()
  }))

  const testBtn = document.createElement('button')
  testBtn.type = 'button'; testBtn.className = 'btn-ghost btn-sm'; testBtn.textContent = 'Imprimir teste'
  const fb = el('span', 'pcard-fb')
  testBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    testBtn.disabled = true
    testBtn.innerHTML = '<span class="spin"></span>Enviando…'
    fb.className = 'pcard-fb'; fb.textContent = ''
    try {
      const prev = _mapping[t.deviceKey] || {}
      await ipcRenderer.invoke('test-print', {
        printerName: t.target,
        profileId: prev.profileId ?? t.suggestedProfileId ?? null,
        cortarPapel: prev.cortarPapel !== false,
      })
      card.classList.remove('err'); st.textContent = 'Pronta'
      fb.className = 'pcard-fb ok'; fb.innerHTML = ICON_CHECK + '<span>Enviado. Saiu na impressora?</span>'
    } catch (err) {
      card.classList.add('err'); st.textContent = 'Erro'
      fb.className = 'pcard-fb err'; fb.textContent = 'Erro: ' + ((err && err.message) || err)
    } finally {
      testBtn.disabled = false
      testBtn.textContent = 'Imprimir teste'
    }
  })
  tools.appendChild(testBtn)
  tools.appendChild(fb)
  card.appendChild(tools)

  // Remover com confirmação inline.
  x.addEventListener('click', () => {
    if (card.querySelector('.pcard-confirm')) return
    const conf = el('div', 'pcard-confirm')
    conf.appendChild(el('span', '', 'Parar de usar esta impressora?'))
    conf.appendChild(el('div', 'spacer'))
    const nao = document.createElement('button')
    nao.type = 'button'; nao.className = 'btn-ghost btn-sm'; nao.textContent = 'Cancelar'
    nao.addEventListener('click', () => { conf.remove(); tools.style.display = '' })
    const sim = document.createElement('button')
    sim.type = 'button'; sim.className = 'btn-danger btn-sm'; sim.textContent = 'Remover'
    sim.addEventListener('click', () => removeActive(t.deviceKey))
    conf.appendChild(nao); conf.appendChild(sim)
    tools.style.display = 'none'
    card.appendChild(conf)
    sim.focus()
  })

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
    const ico = el('div', 'p-ico'); ico.innerHTML = ICON_PRINTER
    const txt = el('div')
    txt.appendChild(el('div', 'aitem-name', friendlyName(t)))
    txt.appendChild(el('div', 'aitem-how', howConnected(t)))
    item.appendChild(ico); item.appendChild(txt)
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
  addFact(facts, 'Conexão', _status === 'connected' ? 'Conectado' : _status === 'reconnecting' ? 'Reconectando…' : 'Desconectado',
    _status === 'connected' ? 'ok' : _status === 'reconnecting' ? 'warn' : 'err')
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

function addFact(box, k, v, tom) {
  const row = el('div', 'fact')
  row.appendChild(el('span', 'fact-k', k))
  row.appendChild(el('span', 'fact-v' + (tom ? ' ' + tom : ''), v))
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

// ─── Tema (Claro padrão / Escuro / Sistema) ──────────────────────────────────
// Preferência só de aparência: fica no localStorage do app (userData do
// Electron), compartilhado com o popup de NOVO PEDIDO. Nada passa pelo main.

const TEMA_KEY = 'pp-tema'

function lerTema() {
  try {
    const t = localStorage.getItem(TEMA_KEY)
    return t === 'dark' || t === 'system' ? t : 'light'
  } catch { return 'light' }
}

function aplicarTema(t) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  document.querySelectorAll('#theme-seg button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.tema === t ? 'true' : 'false')
  })
}

function initTema() {
  aplicarTema(lerTema())
  document.querySelectorAll('#theme-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      try { localStorage.setItem(TEMA_KEY, b.dataset.tema) } catch { /* sem storage: só nesta sessão */ }
      aplicarTema(b.dataset.tema)
    })
  })
  // "Sistema" acompanha a troca do Windows ao vivo.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (lerTema() === 'system') aplicarTema('system')
  })
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
  // Rodapé fixo: só as ações do passo atual.
  document.querySelectorAll('.foot-group').forEach((g) => g.classList.toggle('on', g.dataset.for === name))
  const cur = STEP_OF[name] || 1
  for (let i = 1; i <= 3; i++) {
    const s = byId('st-' + i)
    // "Pronto" é o fim: o passo 3 já entra concluído (check), não "ativo".
    s.classList.toggle('active', i === cur && !(name === 'done' && i === 3))
    s.classList.toggle('done', i < cur || (name === 'done' && i === 3))
  }
  for (let i = 1; i <= 2; i++) byId('bar-' + i).classList.toggle('fill', i < cur)
  byId('content').scrollTop = 0
}

// Três estados: conectado / reconectando / desconectado. "Reconectando" existe
// porque o agente sobe junto com o Windows, muitas vezes antes da rede — e aí
// esperar é o certo, não mexer em nada.
function setStatus(status) {
  const elx = byId('status')
  const antes = _status
  _status = status === 'connected' ? 'connected' : status === 'reconnecting' ? 'reconnecting' : 'disconnected'
  const label = _status === 'connected'    ? 'Conectado'
              : _status === 'reconnecting' ? 'Reconectando...'
              :                              'Desconectado'
  elx.querySelector('.lbl').textContent = label
  elx.className = _status
  if (_status === 'connected' && antes !== 'connected') {
    // Só a transição observada aqui vira "desde HH:MM"; janela aberta já conectada = "agora".
    if (antes !== null && antes !== undefined && _statusVisto) _connectedSince = new Date()
    // Reconectou: pulso curto na pill.
    if (antes === 'reconnecting') {
      void elx.offsetWidth
      elx.classList.add('just-connected')
      setTimeout(() => elx.classList.remove('just-connected'), 600)
    }
  }
  if (_status !== 'connected') _connectedSince = null
  _statusVisto = true
  renderSince()
  if (byId('panel-done').classList.contains('on')) renderDone()
}
let _statusVisto = false

// Reflete o estado REAL do registro do Windows (não a preferência salva): se
// desligarem por fora, pelo Gerenciador de Tarefas, a tela mostra desligado.
async function refreshAutoStart() {
  const row = byId('autostart-row')
  if (!row) return
  const st = await ipcRenderer.invoke('get-autostart')
  row.style.display = st && st.supported ? '' : 'none'
  byId('autostart').checked = !!(st && st.enabled)
}

async function onAutoStartToggle() {
  const box = byId('autostart')
  box.disabled = true
  try {
    const st = await ipcRenderer.invoke('set-autostart', box.checked)
    box.checked = !!(st && st.enabled)
    msg('done-msg', box.checked
      ? 'O Pede+ Print vai abrir sozinho quando o Windows iniciar.'
      : 'O Pede+ Print não vai mais abrir sozinho com o Windows.', 'dim')
  } finally {
    box.disabled = false
  }
}

function msg(id, text, kind) {
  const n = byId(id)
  if (!n) return
  n.textContent = text || ''
  // Mensagens de formulário (.box) viram alerta com fundo; as demais, texto.
  n.className = 'msg ' + (n.classList.contains('box') ? 'box ' : '') + (kind || 'dim')
}

document.addEventListener('DOMContentLoaded', init)
