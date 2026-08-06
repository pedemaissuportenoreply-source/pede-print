'use strict'

// Fila de PENDÊNCIAS por impressora — jobs que NÃO puderam sair porque a
// impressora estava offline (desligada / porta indisponível) ficam guardados em
// disco e são drenados quando aquele deviceKey volta.
//
// Indexada por deviceKey ESTÁVEL (pnpId > locationId > serialNumber > path), o
// mesmo do printer-routing — nunca por VID/PID nem por índice da lista.
//
// Dedup: marca `jobKey:viaN@deviceKey` = "esta via deste job JÁ saiu nesta
// impressora". Protege o dreno contra reenvio do backend (não sai 2x) e mantém o
// fan-out multi-setor (impressoras distintas têm marcas distintas).
//
// TTL (default 15 min): pendente mais velho que o TTL NÃO imprime sozinho ao
// religar — vai pra lista de EXPIRADOS e só sai por reimpressão manual.
//
// Persistência: pending-prints.json no userData do Electron.

const fs = require('fs')
const path = require('path')

const DEFAULT_TTL_MS = 15 * 60 * 1000
const MAX_PENDING = 200
const MAX_EXPIRED = 50
const MAX_PRINTED = 500

function _userDataDir() {
  try { const { app } = require('electron'); return app.getPath('userData') }
  catch { return process.cwd() }
}
function queuePath() { return path.join(_userDataDir(), 'pending-prints.json') }

function _blank() { return { version: 1, pending: [], expired: [], printed: [] } }

let _state = null

function _load() {
  if (_state) return _state
  try {
    const s = JSON.parse(fs.readFileSync(queuePath(), 'utf8'))
    _state = {
      version: 1,
      pending: Array.isArray(s.pending) ? s.pending : [],
      expired: Array.isArray(s.expired) ? s.expired : [],
      printed: Array.isArray(s.printed) ? s.printed : [],
    }
  } catch { _state = _blank() }
  return _state
}

function _save() {
  const s = _load()
  if (s.pending.length > MAX_PENDING) s.pending = s.pending.slice(-MAX_PENDING)
  if (s.expired.length > MAX_EXPIRED) s.expired = s.expired.slice(-MAX_EXPIRED)
  if (s.printed.length > MAX_PRINTED) s.printed = s.printed.slice(-MAX_PRINTED)
  try { fs.writeFileSync(queuePath(), JSON.stringify(s, null, 2)) }
  catch (e) { console.warn('[queue] falha ao salvar pending-prints.json:', e?.message || e) }
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

// jobKey:viaN — a via N deste job. Sem deviceKey ainda (o fan-out usa mark()).
function dedupKey(jobKey, via) {
  return `${String(jobKey || '?').trim()}:via${Number(via) || 1}`
}
// A marca efetiva por impressora: a mesma via pode (e deve) sair em cada ativa.
function mark(dedup, deviceKey) { return `${dedup}@${deviceKey}` }

function isPrinted(m) { return _load().printed.includes(m) }

function markPrinted(m) {
  const s = _load()
  if (!s.printed.includes(m)) s.printed.push(m)
  // Impresso => qualquer pendente da MESMA via/impressora perde a razão de existir.
  const antes = s.pending.length
  s.pending = s.pending.filter((j) => mark(j.dedup, j.deviceKey) !== m)
  if (s.pending.length !== antes) console.log('[queue] pendente resolvido por impressão ao vivo:', m)
  _save()
}

// ── Pendências ────────────────────────────────────────────────────────────────

// job: { deviceKey, dedup, label, setor, jobId, code, enriched, receiptOpts, ttlMs }
// Retorna 'queued' | 'dup' (já impresso ou já na fila).
function enqueue(job) {
  const s = _load()
  const m = mark(job.dedup, job.deviceKey)
  if (s.printed.includes(m)) return 'dup'
  if (s.pending.some((j) => mark(j.dedup, j.deviceKey) === m)) return 'dup'
  s.pending.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    ttlMs: Number(job.ttlMs) > 0 ? Number(job.ttlMs) : DEFAULT_TTL_MS,
    ...job,
  })
  _save()
  return 'queued'
}

function pendingFor(deviceKey) {
  return _load().pending.filter((j) => j.deviceKey === deviceKey)
}
function pendingAll() { return _load().pending.slice() }
function expiredAll() { return _load().expired.slice() }
function hasPending() { return _load().pending.length > 0 }
function pendingKeys() { return [...new Set(_load().pending.map((j) => j.deviceKey))] }

function removeById(id) {
  const s = _load()
  const antes = s.pending.length
  s.pending = s.pending.filter((j) => j.id !== id)
  if (s.pending.length !== antes) _save()
}

// Venceu o TTL: sai da fila automática e vira "não impresso" (reimpressão manual).
function expire(job) {
  const s = _load()
  s.pending = s.pending.filter((j) => j.id !== job.id)
  if (!s.expired.some((j) => j.id === job.id)) s.expired.push({ ...job, expiredAt: Date.now() })
  _save()
}

function takeExpired(id) {
  const s = _load()
  const job = s.expired.find((j) => j.id === id) || null
  if (job) { s.expired = s.expired.filter((j) => j.id !== id); _save() }
  return job
}

function isExpired(job, now) {
  const ttl = Number(job.ttlMs) > 0 ? Number(job.ttlMs) : DEFAULT_TTL_MS
  return (now || Date.now()) - Number(job.createdAt || 0) > ttl
}

module.exports = {
  DEFAULT_TTL_MS, queuePath,
  dedupKey, mark, isPrinted, markPrinted,
  enqueue, pendingFor, pendingAll, pendingKeys, expiredAll, hasPending,
  removeById, expire, takeExpired, isExpired,
}
