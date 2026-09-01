'use strict'

// Início automático com o Windows.
//
// O caixa liga o PC de manhã e a impressão precisa funcionar sem ninguém clicar
// no atalho. Registramos o app em HKCU\...\Run via setLoginItemSettings (o NSIS
// é perMachine:false, então instalação por usuário — nada de UAC aqui).
//
// A flag `--hidden` diz ao main que o boot veio do login do Windows: sobe direto
// pra bandeja, sem janela na cara do operador.

const { app } = require('electron')

const HIDDEN_FLAG = '--hidden'

// Só faz sentido no app empacotado: em dev o execPath é o electron.exe do
// node_modules e registrar isso no boot do Windows seria lixo.
function _supported() {
  return process.platform === 'win32' && app.isPackaged
}

function _target() {
  return { path: process.execPath, args: [HIDDEN_FLAG] }
}

// Estado REAL lido do sistema, não a preferência salva: se o usuário desligar na
// mão pelo Gerenciador de Tarefas, é isso que a UI tem que mostrar.
function isEnabled() {
  if (!_supported()) return false
  try {
    return app.getLoginItemSettings(_target()).openAtLogin === true
  } catch (e) {
    console.warn('[autostart] getLoginItemSettings falhou:', e?.message || e)
    return false
  }
}

function _apply(enabled) {
  if (!_supported()) return false
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, ...(enabled ? _target() : { path: process.execPath }) })
    return true
  } catch (e) {
    console.warn('[autostart] setLoginItemSettings falhou:', e?.message || e)
    return false
  }
}

// Escolha explícita do usuário (toggle da tela ou da bandeja): persiste e aplica.
function setEnabled(store, enabled) {
  const want = enabled === true
  store.set('autoStart', want)
  if (isEnabled() !== want) _apply(want)
  console.log('[autostart] preferência:', want ? 'ligado' : 'desligado', '| efetivo:', isEnabled())
  return isEnabled()
}

// Chamado a cada boot. Ligado por PADRÃO na primeira execução (preferência
// ainda não existe); depois disso só respeita e reconcilia o que o usuário
// escolheu — idempotente, não reescreve o registro se já estiver certo.
function sync(store) {
  if (!_supported()) return false
  let want = store.get('autoStart')
  if (typeof want !== 'boolean') {
    want = true
    store.set('autoStart', true)
    console.log('[autostart] primeira execução — ligando por padrão')
  }
  if (isEnabled() !== want) _apply(want)
  return isEnabled()
}

// Este processo subiu pelo login do Windows?
function startedHidden(argv) {
  const args = argv || process.argv
  if (args.includes(HIDDEN_FLAG)) return true
  try { return app.getLoginItemSettings().wasOpenedAtLogin === true } catch { return false }
}

module.exports = { sync, isEnabled, setEnabled, startedHidden, supported: _supported, HIDDEN_FLAG }
