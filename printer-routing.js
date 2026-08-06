'use strict'

// Roteamento multi-impressora por SETOR (COZINHA / CAIXA / BAR) — agnóstico de marca.
//
// Filosofia: VID/PID NUNCA filtra/exclui uma impressora. Toda porta serial e toda
// impressora do spooler do Windows vira um ALVO. VID/PID (ou o nome) só SUGERE qual
// PrinterProfile pré-selecionar. O ESC/POS efetivo (corte/init/code page) vem do
// perfil atribuído a cada alvo — é isso que adapta o agente a Daruma/Epson/Bematech/etc.
//
// deviceKey ESTÁVEL por impressora física: pnpId > locationId > serialNumber > path
// (serial) ou nome (Windows). Duas impressoras iguais (mesmo VID/PID) geram chaves
// distintas porque pnpId/locationId diferem por porta.
//
// Persistência: printers-config.json no userData do Electron (mapa deviceKey ->
// { setor, profileId, kind, target, ativa } + defaultDeviceKey). Criado/migrado no boot.
//
// ATIVAS: o cliente escolhe QUAIS impressoras usar (ativa: true) — várias ao mesmo
// tempo, cada uma com seu setor. Config antigo (sem nenhum `ativa`) segue o legado:
// a ativa é a defaultDeviceKey (ou o 1º alvo detectado).

const fs = require('fs')
const path = require('path')
const pp = require('./printer-profiles')

const SETORES = ['COZINHA', 'CAIXA', 'BAR']

function _userDataDir() {
  try { const { app } = require('electron'); return app.getPath('userData') }
  catch { return process.cwd() }
}
function configPath() { return path.join(_userDataDir(), 'printers-config.json') }

// ── deviceKeys estáveis ───────────────────────────────────────────────────────
function serialKey(p) {
  const id = p.pnpId || p.locationId || p.serialNumber || p.path || ''
  return 'serial:' + String(id).trim()
}
function windowsKey(name) { return 'win:' + String(name || '').trim() }

// ── Enumeração de alvos ─────────────────────────────────────────────────────────

// Impressoras instaladas no Windows (spooler). Muitas térmicas baratas NÃO criam
// porta COM e só aparecem aqui. Best-effort: ausência do módulo nativo não bloqueia.
function listWindowsPrinters() {
  try {
    const np = require('@thiagoelg/node-printer')
    const arr = typeof np.getPrinters === 'function' ? np.getPrinters() : []
    return (arr || [])
      .map((p) => (typeof p === 'string' ? { name: p } : p))
      .filter((p) => p && p.name)
  } catch (e) {
    console.warn('[routing] spooler Windows indisponível (node-printer) — seguindo só com serial:', e?.message || e)
    return []
  }
}

// Dica de perfil por nome (Windows não tem VID/PID): procura a marca no nome.
function suggestByName(name) {
  const n = String(name || '').toLowerCase()
  if (!n) return null
  const cat = pp.getCatalog()
  return cat.find((p) => p.brand && !p.isGeneric && n.includes(String(p.brand).toLowerCase())) || null
}

// Enumera TODOS os alvos (qualquer marca). NUNCA exclui por VID/PID.
async function detectTargets() {
  const targets = []

  // 1) Portas seriais — todas, de qualquer marca.
  let ports = []
  try { ports = await pp.listSerialPorts() }
  catch (e) { console.warn('[routing] listSerialPorts falhou:', e?.message || e) }
  for (const p of ports) {
    if (!p.path) continue
    const profile = p.profile || suggestByName(p.manufacturer) || null
    targets.push({
      deviceKey: serialKey(p), kind: 'serial', target: p.path,
      label: [p.path, p.manufacturer].filter(Boolean).join(' — ') || p.path,
      // Cru, p/ a UI montar um nome legível sem reparsear o label.
      manufacturer: p.manufacturer || null,
      vendorId: p.vendorId || null, productId: p.productId || null,
      suggestedProfileId: profile ? profile.id : null,
      suggestedProfileName: profile ? profile.name : null,
    })
  }

  // 2) Impressoras do Windows (spooler) — dedup contra chaves já existentes.
  for (const w of listWindowsPrinters()) {
    const dk = windowsKey(w.name)
    if (targets.some((t) => t.deviceKey === dk)) continue
    const profile = suggestByName(w.name) || null
    targets.push({
      deviceKey: dk, kind: 'windows', target: w.name,
      label: w.name + ' (Windows)',
      manufacturer: null,
      vendorId: null, productId: null,
      suggestedProfileId: profile ? profile.id : null,
      suggestedProfileName: profile ? profile.name : null,
    })
  }

  return targets
}

// ── Config persistente ───────────────────────────────────────────────────────

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    if (c && typeof c === 'object' && c.printers) return c
  } catch { /* sem arquivo ou inválido */ }
  return null
}
function saveConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); return true }
  catch (e) { console.warn('[routing] falha ao salvar printers-config.json:', e?.message || e); return false }
}
function _blankConfig() {
  return {
    version: 1,
    _comment: 'Mapa deviceKey -> { setor, profileId, kind, target, ativa }. ativa: true = impressora em uso (varias podem estar ativas ao mesmo tempo). setor: COZINHA|CAIXA|BAR (null = todos os pedidos). profileId: id do PrinterProfile (null = auto por VID/PID ou generico). defaultDeviceKey: 1a ativa, usada como fallback quando nada casa.',
    defaultDeviceKey: null,
    printers: {},
  }
}

// Cria/migra o config a partir dos alvos detectados, SEM apagar o mapeamento do
// usuário. Atualiza target/kind/label (a porta pode mudar) e preenche dica de perfil.
function ensureConfig(targets) {
  const cfg = loadConfig() || _blankConfig()
  if (!cfg.printers || typeof cfg.printers !== 'object') cfg.printers = {}
  for (const t of targets) {
    const ex = cfg.printers[t.deviceKey]
    if (!ex) {
      cfg.printers[t.deviceKey] = {
        setor: null, profileId: t.suggestedProfileId ?? null,
        kind: t.kind, target: t.target, label: t.label,
        cortarPapel: true, // default: corta (não regride impressoras COM existentes)
      }
    } else {
      ex.kind = t.kind; ex.target = t.target; ex.label = t.label
      if (ex.profileId == null && t.suggestedProfileId != null) ex.profileId = t.suggestedProfileId
    }
  }
  if (!cfg.defaultDeviceKey || !cfg.printers[cfg.defaultDeviceKey]) {
    cfg.defaultDeviceKey = targets[0] ? targets[0].deviceKey : null
  }
  saveConfig(cfg)
  return cfg
}

// deviceKeys ATIVAS (na ordem dos alvos detectados), restritas ao que está
// presente agora. Config antigo — nenhum `ativa` gravado — cai no legado:
// a "principal" (defaultDeviceKey) é a única ativa.
function activeKeys(cfg, targets) {
  const byKey = (cfg && cfg.printers) || {}
  const detected = (targets || []).map((t) => t.deviceKey)
  const marcadas = detected.filter((k) => byKey[k] && byKey[k].ativa === true)
  if (marcadas.length) return marcadas
  const temFlag = Object.values(byKey).some((e) => e && typeof e.ativa === 'boolean')
  if (temFlag) return [] // o cliente removeu todas: respeita (caller cai no legado)
  const dflt = cfg && cfg.defaultDeviceKey
  if (dflt && detected.includes(dflt)) return [dflt]
  return detected.length ? [detected[0]] : []
}

// deviceKeys ATIVAS pela CONFIG, independente de estarem presentes agora.
// É isso que define o que o job ESPERA imprimir — impressora desligada continua
// sendo um alvo (vira pendência), não some do roteamento.
function configuredActiveKeys(cfg) {
  const byKey = (cfg && cfg.printers) || {}
  const marcadas = Object.keys(byKey).filter((k) => byKey[k] && byKey[k].ativa === true)
  if (marcadas.length) return marcadas
  const temFlag = Object.values(byKey).some((e) => e && typeof e.ativa === 'boolean')
  if (temFlag) return []
  const dflt = cfg && cfg.defaultDeviceKey
  return (dflt && byKey[dflt]) ? [dflt] : []
}

// ── Resolução de perfil ─────────────────────────────────────────────────────────

function profileById(id) {
  if (id == null) return null
  return pp.getCatalog().find((p) => p.id === id) || null
}
// Aplica o override manual (Ajuste avançado) por impressora SOBRE o perfil base,
// sem mutar o catálogo (clona). Override ausente/desativado => perfil base intacto.
function _applyOverride(base, override) {
  if (!base || !override || !override.enabled) return base
  const p = {
    ...base,
    commands: {
      cut: (base.commands && Array.isArray(base.commands.cut)) ? base.commands.cut.slice() : [29, 86, 66, 0],
      codepage: (base.commands && Array.isArray(base.commands.codepage)) ? base.commands.codepage.slice() : [0x1b, 0x74, 0],
    },
  }
  if (Number.isInteger(override.columns) && override.columns > 0) p.columns = override.columns
  if (typeof override.encoding === 'string' && override.encoding.trim()) p.encoding = override.encoding.trim()
  if (Number.isInteger(override.codepageEscT)) { p.codepageEscT = override.codepageEscT; p.commands.codepage = [0x1b, 0x74, override.codepageEscT] }
  if (Array.isArray(override.cut) && override.cut.length) p.commands.cut = override.cut.slice()
  return p
}

// Perfil de um alvo: mapeado pelo usuário > match VID/PID > genérico, com override
// manual aplicado por cima (quando o card ativou o Ajuste avançado).
function _profileForEntry(entry, target) {
  const base = profileById(entry && entry.profileId)
    || (target && pp.matchProfile(target.vendorId, target.productId))
    || pp.genericProfile()
  return _applyOverride(base, entry && entry.override)
}

// ── Estado + roteamento ─────────────────────────────────────────────────────────

let _targets = []
function getTargets() { return _targets.slice() }
function setTargets(t) { _targets = Array.isArray(t) ? t : [] }

// Monta o descritor de impressão de uma deviceKey (porta + perfil + corte).
function _routedFor(key, cfg, targets, setor) {
  const entry = ((cfg && cfg.printers) || {})[key] || {}
  const t = targets.find((x) => x.deviceKey === key)
  const target = entry.target || (t && t.target)
  if (!target) return null
  return {
    deviceKey: key,
    kind: entry.kind || (t && t.kind) || 'serial',
    target,
    label: entry.label || (t && t.label) || target,
    profile: _profileForEntry(entry, t),
    cortarPapel: entry.cortarPapel !== false,
    setor: setor || null,
  }
}

// TODAS as impressoras ATIVAS que devem receber um job deste SETOR.
// Precedência (preserva o comportamento antigo, só que sem limite de 1):
//   1) ativas com setor EXATAMENTE igual ao do job;
//   2) senão, ativas em "Todos os pedidos" (setor null);
//   3) senão, a principal/1ª ativa (fallback).
// [] => caller usa o caminho legado.
function resolveAllForSetor(setor) {
  const cfg = loadConfig()
  const targets = _targets
  if (!cfg || !targets.length) return []

  const s = String(setor || '').trim().toUpperCase()
  const byKey = cfg.printers || {}
  const ativas = activeKeys(cfg, targets)
  if (!ativas.length) return []

  let keys = []
  if (s) keys = ativas.filter((k) => String((byKey[k] || {}).setor || '').toUpperCase() === s)
  if (!keys.length) keys = ativas.filter((k) => !(byKey[k] || {}).setor)
  if (!keys.length) {
    const dflt = (cfg.defaultDeviceKey && ativas.includes(cfg.defaultDeviceKey)) ? cfg.defaultDeviceKey : ativas[0]
    keys = [dflt]
  }
  return keys.map((k) => _routedFor(k, cfg, targets, s)).filter(Boolean)
}

// Alvos ESPERADOS de um job deste SETOR — da CONFIG, não da presença. Cada item
// vem com `present` (a impressora está plugada/ligada agora?) para o caller
// imprimir nas presentes e ENFILEIRAR as ausentes em vez de descartar o job.
// Mesma precedência de setor do resolveAllForSetor (não enfileira recibo de
// caixa numa impressora de cozinha).
function expectedForSetor(setor) {
  const cfg = loadConfig()
  if (!cfg) return []
  const s = String(setor || '').trim().toUpperCase()
  const byKey = cfg.printers || {}
  const ativas = configuredActiveKeys(cfg)
  if (!ativas.length) return []

  let keys = []
  if (s) keys = ativas.filter((k) => String((byKey[k] || {}).setor || '').toUpperCase() === s)
  if (!keys.length) keys = ativas.filter((k) => !(byKey[k] || {}).setor)
  if (!keys.length) {
    keys = [(cfg.defaultDeviceKey && ativas.includes(cfg.defaultDeviceKey)) ? cfg.defaultDeviceKey : ativas[0]]
  }
  const presentes = new Set(_targets.map((t) => t.deviceKey))
  return keys.map((k) => {
    const r = _routedFor(k, cfg, _targets, s)
    // Sem porta salva nem detectada: ainda é um alvo esperado (só que ausente).
    const base = r || {
      deviceKey: k, kind: (byKey[k] || {}).kind || 'serial', target: (byKey[k] || {}).target || null,
      label: (byKey[k] || {}).label || k, profile: _profileForEntry(byKey[k], null),
      cortarPapel: (byKey[k] || {}).cortarPapel !== false, setor: s,
    }
    return { ...base, present: presentes.has(k) }
  })
}

// Descritor de UMA impressora pela deviceKey estável — só se ela estiver
// presente agora. Usado pela fila de pendências ao drenar.
function resolveByKey(deviceKey) {
  if (!deviceKey) return null
  if (!_targets.some((t) => t.deviceKey === deviceKey)) return null
  return _routedFor(deviceKey, loadConfig(), _targets, null)
}

// Compat: 1 alvo só (a 1ª ativa do setor). Mantido p/ chamadores antigos.
function resolveForSetor(setor) {
  const targets = _targets
  if (targets.length <= 1) return null // 1 impressora => comportamento legado
  return resolveAllForSetor(setor)[0] || null
}

// Resolve o device PADRÃO (+perfil/override) — vale p/ QUALQUER quantidade de
// impressoras (inclusive 1). Usado quando não há roteamento por setor: o card
// PADRÃO passa a ditar porta/perfil mesmo no caso de impressora única.
function resolveDefault() {
  const cfg = loadConfig()
  const targets = _targets
  if (!targets.length) return null
  const byKey = (cfg && cfg.printers) || {}
  const ativas = activeKeys(cfg, targets)
  // "Principal" = defaultDeviceKey se ela estiver ativa; senão a 1ª ativa; senão legado.
  let key = (cfg && cfg.defaultDeviceKey && ativas.includes(cfg.defaultDeviceKey))
    ? cfg.defaultDeviceKey
    : (ativas[0]
      || ((cfg && cfg.defaultDeviceKey && byKey[cfg.defaultDeviceKey]) ? cfg.defaultDeviceKey : targets[0].deviceKey))
  return _routedFor(key, cfg, targets, null) || _routedFor(targets[0].deviceKey, cfg, targets, null) || null
}

// Re-resolve a porta ATUAL de uma impressora a partir da sua deviceKey ESTÁVEL
// (pnpId/locationId sobrevivem à renumeração da COM pelo Windows). Re-enumera os
// alvos, acha o de mesma deviceKey e devolve a porta atual — persistindo no config
// se a porta mudou. Usado quando a porta salva (ex.: COM7) não abre mais.
// Retorna o alvo atualizado ({ deviceKey, kind, target, label, ... }) ou null se a
// impressora não está mais presente (desconectada).
async function reResolveTarget(deviceKey) {
  if (!deviceKey) return null
  let targets = []
  try { targets = await detectTargets() }
  catch (e) { console.warn('[routing] re-detect falhou:', e?.message || e); return null }
  setTargets(targets)
  const t = targets.find((x) => x.deviceKey === deviceKey)
  if (!t || !t.target) return null
  try {
    const cfg = loadConfig()
    const entry = cfg && cfg.printers && cfg.printers[deviceKey]
    if (entry && entry.target !== t.target) {
      console.log(`[routing] re-resolve deviceKey=${deviceKey}: porta ${entry.target} -> ${t.target} (persistindo)`)
      entry.target = t.target
      entry.kind = t.kind
      entry.label = t.label
      saveConfig(cfg)
    }
  } catch (e) { console.warn('[routing] falha ao persistir porta re-resolvida:', e?.message || e) }
  return t
}

function logMapping() {
  console.log(`[routing] alvos detectados: ${_targets.length}`)
  for (const t of _targets) {
    console.log(`  - ${t.deviceKey} | ${t.kind} | ${t.target} | dica perfil: ${t.suggestedProfileName || '(genérico)'}`)
  }
  const cfg = loadConfig()
  if (cfg) {
    const ativas = activeKeys(cfg, _targets)
    console.log(`[routing] ativas: ${ativas.length ? ativas.join(', ') : '(nenhuma -> legado)'} | default: ${cfg.defaultDeviceKey || '(nenhum)'}`)
    for (const [k, e] of Object.entries(cfg.printers || {})) {
      console.log(`  -> ${k} | ${ativas.includes(k) ? 'ATIVA' : 'inativa'} | setor: ${e.setor || '(todos os pedidos)'} | profileId: ${e.profileId ?? '(auto)'} | ${e.kind}:${e.target}`)
    }
  }
}

// Boot/refresh: detecta alvos, garante o config e loga o mapeamento ativo.
async function init() {
  setTargets(await detectTargets())
  ensureConfig(_targets)
  logMapping()
  return _targets
}

module.exports = {
  SETORES, configPath, serialKey, windowsKey,
  detectTargets, listWindowsPrinters,
  loadConfig, saveConfig, ensureConfig,
  profileById, getTargets, setTargets, activeKeys, configuredActiveKeys,
  resolveForSetor, resolveAllForSetor, expectedForSetor, resolveDefault, resolveByKey, reResolveTarget, logMapping, init,
}
