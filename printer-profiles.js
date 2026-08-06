'use strict'

// Catálogo DINÂMICO de perfis de impressora ESC/POS. Fonte de verdade: backend
// (GET /print-agent/printer-profiles, auth x-api-key). Prioridade de carga:
//   backend (online) > cache local em disco > seed embarcado (última instância).
// printer.js puxa os bytes do PERFIL ATIVO daqui (corte + code page + encoding).

const fs = require('fs')
const path = require('path')

// Seed embarcado (formato do backend) — usado só se backend E cache falharem.
// Espelha prisma/seed-printer-profiles.ts (sem `id`: a fonte de verdade dos ids é
// o backend; offline o profileId mapeado cai em matchProfile/genérico).
//
// PAR codepage↔ESC t (select character table) POR PERFIL — acentos PT-BR corretos:
//   • VERIFICADO só na EPSON TM-T20 (device físico onde a matriz de codepage rodou):
//     cp860 + ESC t 3 imprime ç/ã/õ certos; cp1252 + ESC t 16 também OK; reverso GS B
//     suportado (inclusive double-height). cp1252 + ESC t 7 / cp858 / cp437 MANGLAM.
//   • Default seguro = cp860 + ESC t 3 (aplicado aos demais perfis homologados), mas
//     NÃO CONFIRMADO device a device: rodar test-codepage no aparelho físico antes de
//     confiar (cada modelo mapeia a ROM diferente).
//   • encoding = iconv (bytes do texto); codepageEscT = n de "ESC t n" (charset ROM).
//     Os dois PRECISAM casar; divergência = acento quebrado.
const EMBEDDED_SEED = [
  { name: 'Epson TM-T20',          brand: 'Epson',        vendorId: '04b8', productId: '0e03', encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: true,  isGeneric: false }, // VERIFICADO: cp860+ESC t 3 (alt cp1252+16); reverso GS B OK
  { name: 'Epson TM-T20X',         brand: 'Epson',        vendorId: '04b8', productId: '0e28', encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: true,  isGeneric: false },
  { name: 'Elgin i9',              brand: 'Elgin',        vendorId: null,   productId: null,   encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: true,  isGeneric: false },
  { name: 'Elgin i8',              brand: 'Elgin',        vendorId: null,   productId: null,   encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: true,  isGeneric: false },
  { name: 'Bematech MP-4200 TH',   brand: 'Bematech',     vendorId: null,   productId: null,   encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: true,  isGeneric: false },
  { name: 'Bematech MP-100S TH',   brand: 'Bematech',     vendorId: null,   productId: null,   encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 32, printLogoRaster: false, isGeneric: false },
  { name: 'Daruma DR800',          brand: 'Daruma',       vendorId: null,   productId: null,   encoding: 'cp1252', codepageEscT: 7, cutCommand: [29, 86, 65, 0], columns: 48, printLogoRaster: true,  isGeneric: false }, // NÃO verificado: par codepage/ESC t não testado neste device — rodar test-codepage na DR800 antes de confiar
  { name: 'Daruma DR700',          brand: 'Daruma',       vendorId: null,   productId: null,   encoding: 'cp1252', codepageEscT: 7, cutCommand: [27, 109],       columns: 48, printLogoRaster: false, isGeneric: false },
  { name: 'Tanca TP-650',          brand: 'Tanca',        vendorId: null,   productId: null,   encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: true,  isGeneric: false },
  { name: 'Control iD Print iD',   brand: 'Control iD',   vendorId: null,   productId: null,   encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: true,  isGeneric: false },
  { name: 'Knup / Xprinter 80mm',  brand: 'Knup/Xprinter',vendorId: null,   productId: null,   encoding: 'cp860',  codepageEscT: 3, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: false, isGeneric: false },
  { name: 'Generico ESC/POS',      brand: 'Generico',     vendorId: null,   productId: null,   encoding: 'cp850',  codepageEscT: 2, cutCommand: [29, 86, 66, 0], columns: 48, printLogoRaster: false, isGeneric: true  },
  { name: 'Generico 58mm ESC/POS', brand: 'Generico',     vendorId: null,   productId: null,   encoding: 'cp850',  codepageEscT: 2, cutCommand: [29, 86, 66, 0], columns: 32, printLogoRaster: false, isGeneric: false },
]

// Converte um perfil no formato do backend para o formato de RUNTIME consumido
// por printer.js (com os bytes ESC/POS já montados).
function toRuntime(p) {
  const n = Number(p.codepageEscT) || 0
  return {
    id: p.id ?? null,
    name: p.name, brand: p.brand,
    vendorId: p.vendorId ?? null, productId: p.productId ?? null,
    encoding: p.encoding || 'cp1252',
    codepageEscT: n,
    columns: Number.isInteger(p.columns) && p.columns > 0 ? p.columns : 48,
    printLogoRaster: p.printLogoRaster !== false,
    // GS B (reverso/branco-no-preto) — suportado por toda a térmica homologada.
    // Flag existe só como escape hatch: catálogo pode marcar supportsInvert:false
    // p/ um modelo problemático e o cupom cai no fallback ASCII (moldura + bold).
    supportsInvert: p.supportsInvert !== false,
    isGeneric: !!p.isGeneric,
    commands: {
      cut: Array.isArray(p.cutCommand) && p.cutCommand.length ? p.cutCommand.slice() : [29, 86, 66, 0],
      codepage: [0x1b, 0x74, n], // ESC t n
    },
  }
}

// Catálogo corrente (runtime). Começa no seed; loadCatalog() troca por backend/cache.
let _catalog = EMBEDDED_SEED.map(toRuntime)
// Default p/ printer.js no require (Epson). setActiveProfile() troca em runtime.
const DEFAULT_PROFILE = _catalog[0]

function setCatalog(list) {
  if (Array.isArray(list) && list.length) _catalog = list.map(toRuntime)
}
function getCatalog() { return _catalog }
function genericProfile() {
  return _catalog.find((p) => p.isGeneric) || _catalog[_catalog.length - 1] || null
}

// Normaliza VID/PID p/ comparação: minúsculo, sem '0x', sem zeros à esquerda.
function normalizeId(id) {
  if (id == null) return ''
  let s = String(id).trim().toLowerCase()
  if (s.startsWith('0x')) s = s.slice(2)
  return s.replace(/^0+(?=.)/, '')
}
function idsEqual(a, b) {
  return normalizeId(a) !== '' && normalizeId(a) === normalizeId(b)
}

// Casa VID/PID contra o catálogo corrente (ignora perfis sem VID/PID).
function matchProfile(vendorId, productId) {
  return _catalog.find((p) => idsEqual(p.vendorId, vendorId) && idsEqual(p.productId, productId)) || null
}

// ── Catálogo via backend + cache em disco ─────────────────────────────────────

// Deriva a base REST a partir do serverUrl do agente (socket base, sem prefixo).
// Não hardcoda /api/v1 cegamente: só acrescenta se ainda não houver /api/vN.
function restBase(serverUrl) {
  let u = String(serverUrl || '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (/\/api\/v\d+$/i.test(u)) return u
  return u + '/api/v1'
}

function _cachePath() {
  const { app } = require('electron')
  return path.join(app.getPath('userData'), 'printer-profiles-cache.json')
}
function _saveCache(list) {
  try { fs.writeFileSync(_cachePath(), JSON.stringify(list, null, 2)) }
  catch (e) { console.warn('[printer-profiles] falha ao salvar cache:', e?.message || e) }
}
function _loadCache() {
  try {
    const arr = JSON.parse(fs.readFileSync(_cachePath(), 'utf8'))
    return Array.isArray(arr) && arr.length ? arr : null
  } catch { return null }
}

async function fetchProfiles(serverUrl, apiKey) {
  const base = restBase(serverUrl)
  if (!base || !apiKey) throw new Error('serverUrl/apiKey ausente')
  const res = await fetch(`${base}/print-agent/printer-profiles`, {
    headers: { 'x-api-key': String(apiKey) },
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('resposta inesperada (esperava array)')
  return data
}

// Carrega o catálogo: backend > cache > seed. Aplica em _catalog e retorna a fonte.
async function loadCatalog(serverUrl, apiKey) {
  try {
    const list = await fetchProfiles(serverUrl, apiKey)
    if (!list.length) throw new Error('catálogo vazio')
    setCatalog(list)
    _saveCache(list)
    console.log(`[printer-profiles] catálogo: ${list.length} perfis | fonte: backend`)
    return { source: 'backend', count: list.length }
  } catch (e) {
    console.warn('[printer-profiles] fetch do catálogo falhou:', e?.message || e)
    const cached = _loadCache()
    if (cached && cached.length) {
      setCatalog(cached)
      console.log(`[printer-profiles] catálogo: ${cached.length} perfis | fonte: cache local`)
      return { source: 'cache', count: cached.length }
    }
    setCatalog(EMBEDDED_SEED)
    console.log(`[printer-profiles] catálogo: ${EMBEDDED_SEED.length} perfis | fonte: seed embarcado`)
    return { source: 'seed', count: EMBEDDED_SEED.length }
  }
}

// Reporta VID/PID desconhecido pro backend (best-effort; nunca trava impressão).
async function reportUnknown(serverUrl, apiKey, info) {
  try {
    const base = restBase(serverUrl)
    if (!base || !apiKey) return false
    await fetch(`${base}/print-agent/unknown-printer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': String(apiKey) },
      body: JSON.stringify(info || {}),
    })
    console.log('[printer-profiles] VID/PID desconhecido reportado:', info?.vendorId, info?.productId)
    return true
  } catch (e) {
    console.warn('[printer-profiles] reportUnknown falhou (ignorado):', e?.message || e)
    return false
  }
}

// Lista as portas seriais com metadados + perfil casado (quando reconhecido).
function loadSerialPort() {
  try { return require('serialport').SerialPort }
  catch (e) { console.warn('[printer-profiles] módulo serialport indisponível:', e?.message || e); return null }
}
async function listSerialPorts() {
  const SerialPort = loadSerialPort()
  if (!SerialPort) return []
  try {
    const ports = await SerialPort.list()
    return ports.map((p) => ({
      path:         p.path || p.comName || '',
      manufacturer: p.manufacturer || null,
      vendorId:     p.vendorId || null,
      productId:    p.productId || null,
      // Identificadores ESTÁVEIS por porta física (p/ deviceKey do roteamento).
      pnpId:        p.pnpId || null,
      locationId:   p.locationId || null,
      serialNumber: p.serialNumber || null,
      profile:      matchProfile(p.vendorId, p.productId),
    })).filter((p) => p.path)
  } catch (e) {
    console.warn('[printer-profiles] SerialPort.list falhou:', e?.message || e)
    return []
  }
}

// Auto-detecta a porta da impressora por VID/PID (casa contra o catálogo corrente).
//   - exatamente 1 match -> { port, profile }
//   - 0 matches          -> null  (caller aplica genérico + reporta desconhecido)
//   - 2+ matches         -> { candidates: [...] }  (seleção manual)
async function detectPrinterPort() {
  const ports = await listSerialPorts()
  const matches = ports.filter((p) => p.profile)

  if (matches.length === 1) {
    const m = matches[0]
    console.log(`[printer-profiles] Impressora detectada automaticamente: ${m.profile.name} em ${m.path}`)
    return { port: m.path, profile: m.profile }
  }
  if (matches.length === 0) {
    console.warn('[printer-profiles] Nenhuma impressora conhecida detectada (VID/PID) — fallback genérico/manual.')
    return null
  }
  console.warn(`[printer-profiles] ${matches.length} impressoras conhecidas detectadas — seleção manual necessária.`)
  return { candidates: matches.map((m) => ({ port: m.path, profile: m.profile, manufacturer: m.manufacturer })) }
}

module.exports = {
  EMBEDDED_SEED,
  DEFAULT_PROFILE,
  toRuntime,
  setCatalog,
  getCatalog,
  genericProfile,
  normalizeId,
  matchProfile,
  restBase,
  fetchProfiles,
  loadCatalog,
  reportUnknown,
  listSerialPorts,
  detectPrinterPort,
}
