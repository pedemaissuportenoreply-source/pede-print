'use strict'

const { io } = require('socket.io-client')

const MAX_FAST_ATTEMPTS = 10
const FAST_DELAY_MS     = 3_000
const SLOW_DELAY_MS     = 30_000

let socket         = null
let slowTimer      = null
let _cfg           = null
let _onEvent       = null
let _onStatus      = null

// ─── Public ───────────────────────────────────────────────────────────────────

function createSocket(cfg, onEvent, onStatus) {
  _cfg      = cfg
  _onEvent  = onEvent
  _onStatus = onStatus
  _connect()
}

function reconnect() {
  _clearSlowTimer()
  _connect()
}

function cleanup() {
  _clearSlowTimer()
  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _connect() {
  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }

  if (!_cfg?.serverUrl || !_cfg?.apiKey) return

  const apiKey = String(_cfg.apiKey ?? '').trim()
  console.log('[socket] apiKey:', apiKey.slice(0, 16) + '... (len=' + apiKey.length + ')')
  console.log('[socket] enviando auth:', JSON.stringify({ apiKey: apiKey.slice(0, 12) + '...' }))

  socket = io(`${_cfg.serverUrl}/realtime`, {
    auth:                  { apiKey },
    transports:            ['websocket'],
    reconnection:          true,
    reconnectionDelay:     FAST_DELAY_MS,
    reconnectionDelayMax:  FAST_DELAY_MS,
    reconnectionAttempts:  MAX_FAST_ATTEMPTS,
    randomizationFactor:   0,
  })

  socket.on('connect', () => {
    _clearSlowTimer()
    console.log('[socket] conectado! socket.id:', socket.id, '| serverUrl:', _cfg?.serverUrl)
    console.log('[socket] emitindo join:cozinha')
    socket.emit('join:cozinha', {})
    socket.once('joined', (d) => console.log('[socket] join confirmado pelo servidor:', JSON.stringify(d)))
    _onStatus?.('connected')
  })

  socket.onAny((eventName, ...args) => {
    console.log('[socket] evento recebido:', eventName, JSON.stringify(args, null, 2))
  })

  socket.on('disconnect', (reason) => {
    console.log('[socket] desconectado. motivo:', reason)
    if (reason === 'io server disconnect') {
      console.log('[socket] servidor rejeitou a conexão — verifique o token/apiKey!')
    }
    _onStatus?.('disconnected')
  })

  socket.on('connect_error', (err) => {
    console.log('[socket] erro de conexão:', err.message)
    _onStatus?.('disconnected')
  })

  // After MAX_FAST_ATTEMPTS, socket.io stops trying — we switch to slow polling
  socket.on('reconnect_failed', () => {
    _onStatus?.('disconnected')
    _scheduleSlowReconnect()
  })

  // Balcão online: order:new → imprime comanda de balcão
  socket.on('order:new', (data) => {
    const raw = JSON.stringify(data, null, 2)
    console.log('[KITCHEN RAW] (order:new)', raw)
    console.log('[QR ORDER]', 'order:new', '| type:', data.type, '| channel:', data.channel ?? data.canalOrigem, '| _printType:', data._printType, '| has items:', !!(data.items ?? data.itens))
    console.log('[KITCHEN RAW] origem:', data.origin ?? data.canalOrigem ?? data.source ?? data.channel ?? '(?)', '| payloadBytes:', Buffer.byteLength(raw, 'utf8'))
    console.log('[socket] order:new | code:', data.code ?? data.orderCode ?? '?', '| items:', (data.items ?? data.itens ?? []).length)
    // TEMP DIAGNÓSTICO QR — remover depois.
    console.log(`[PEDE-PRINT] received job type=${data.type ?? data.serviceType ?? '?'} jobKey=${data.code ?? data.orderCode ?? '?'} hasReviewUrl=${!!data.reviewUrl} reviewUrl=${data.reviewUrl ?? '(none)'}`)
    const itens = data.items ?? data.itens ?? []
    if (itens.length === 0) { console.log('[SKIP] order:new sem itens'); return }
    _onEvent?.('novo_pedido', data)
  })

  // Cozinha: pedido:novo → imprime comanda de cozinha
  socket.on('pedido:novo', (data) => {
    const raw = JSON.stringify(data, null, 2)
    console.log('[KITCHEN RAW] (pedido:novo)', raw)
    console.log('[QR ORDER]', 'pedido:novo', '| type:', data.type, '| channel:', data.channel ?? data.canalOrigem, '| _printType:', data._printType, '| has items:', !!(data.items ?? data.itens))
    console.log('[KITCHEN RAW] origem:', data.origin ?? data.canalOrigem ?? data.source ?? data.channel ?? '(?)', '| payloadBytes:', Buffer.byteLength(raw, 'utf8'))
    console.log('[socket] pedido:novo | num:', data.numeroPedido ?? data.code ?? '?', '| itens:', (data.items ?? data.itens ?? []).length)
    // TEMP DIAGNÓSTICO QR — remover depois.
    console.log(`[PEDE-PRINT] received job type=${data.type ?? data.serviceType ?? '?'} jobKey=${data.code ?? data.numeroPedido ?? data.orderCode ?? '?'} hasReviewUrl=${!!data.reviewUrl} reviewUrl=${data.reviewUrl ?? '(none)'}`)
    const itens = data.items ?? data.itens ?? []
    if (itens.length === 0) { console.log('[SKIP] pedido:novo sem itens'); return }
    _onEvent?.('novo_pedido_cozinha', data)
  })

  // Caixa: pedido:status PAGO → imprime comprovante de pagamento
  socket.on('pedido:status', (data) => {
    const status = String(data?.status ?? '').toUpperCase()
    if (status !== 'PAGO' && status !== 'PAID') return
    console.log('[socket] pedido:status PAGO | num:', data?.numeroPedido ?? data?.code ?? '?')
    _onEvent?.('pedido_pago', data)
  })

  // Comprovante (fila nova, com jobId) — POST /print/receipt e auto-print do caixa
  socket.on('receipt:print', (data) => {
    console.log('[socket] receipt:print | jobId:', data.jobId ?? '(sem)', '| orderCode:', data.orderCode ?? data.code ?? '?')
    _onEvent?.('receipt:print', data)
  })

  // Caixa: pagamento concluído → imprime comprovante (via cliente)
  socket.on('caixa:pagamento', (data) => {
    const id = data.id ?? data.numeroPedido ?? data.code ?? data.orderCode ?? '?'
    const itens = data.items ?? data.itens ?? []
    if (itens.length === 0) { console.log('[SKIP] caixa:pagamento sem itens | id:', id); return }
    console.log('[caixa:pagamento] imprimindo comprovante | id:', id)
    _onEvent?.('caixa_pagamento', data)
  })
}

function _scheduleSlowReconnect() {
  _clearSlowTimer()
  slowTimer = setTimeout(() => {
    slowTimer = null
    _connect()
  }, SLOW_DELAY_MS)
}

function _clearSlowTimer() {
  if (slowTimer) {
    clearTimeout(slowTimer)
    slowTimer = null
  }
}

// Valida um par (serverUrl, apiKey) abrindo uma conexão temporária ao backend.
// O backend deriva o tenantId server-side a partir da chave e aceita/rejeita.
// Resolve { ok, message } sem tocar no socket principal nem na config.
function validateKey({ serverUrl, apiKey }) {
  return new Promise((resolve) => {
    const url = String(serverUrl ?? '').trim()
    const key = String(apiKey ?? '').trim()
    if (!url || !key) return resolve({ ok: false, message: 'Informe a URL do servidor e a chave.' })

    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try { probe.removeAllListeners(); probe.disconnect() } catch { /* noop */ }
      clearTimeout(timer)
      resolve(result)
    }

    const probe = io(`${url}/realtime`, {
      auth: { apiKey: key },
      transports: ['websocket'],
      reconnection: false,
      timeout: 8000,
    })

    const timer = setTimeout(() => finish({ ok: false, message: 'Tempo esgotado ao conectar no servidor.' }), 9000)

    probe.on('connect', () => finish({ ok: true, message: 'Chave válida! Impressora pareada com sucesso.' }))
    probe.on('connect_error', (err) => {
      const m = String(err?.message ?? '')
      const friendly = /inválida|invalida|revogada|API key/i.test(m)
        ? 'Chave inválida ou revogada. Verifique a chave do seu restaurante.'
        : `Não foi possível conectar: ${m || 'erro desconhecido'}`
      finish({ ok: false, message: friendly })
    })
  })
}

// Confirma impressão pro backend (marca PRINTED e cancela o reenvio).
function emitToServer(event, payload) {
  if (socket && socket.connected) {
    socket.emit(event, payload)
    return true
  }
  console.log('[socket] emitToServer falhou (desconectado):', event)
  return false
}

module.exports = { createSocket, reconnect, cleanup, emitToServer, validateKey }
