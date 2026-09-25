'use strict'

// Guardas da via da COZINHA (order:new / pedido:novo). Sem Electron: testável
// com `node --test`.
//
// Uma via de cozinha é oferecida (auto-print OU popup) no máximo UMA vez por
// pedido+rodada — "Imprimir" e "Ignorar" contam igual como tratado, e a marca
// sobrevive a restart/reconexão. Pedido já encerrado nunca é oferecido.

const MAX_HANDLED = 500
const STORE_KEY = 'kitchenHandled'

const STATUS_ENCERRADOS = new Set([
  'CLOSED', 'CANCELLED', 'DELIVERED',
  'PAGO', 'PAGA', 'PAID', 'FECHADO', 'FECHADA', 'CANCELADO', 'CANCELADA', 'ENTREGUE',
])

// Chave idempotente pedido+rodada. `_rodada` só vem na reentrada/rodada nova.
function viaKey(event, data) {
  const id = event === 'novo_pedido_cozinha'
    ? (data?.comandaId ?? data?.id ?? data?.numeroPedido)
    : (data?.id ?? data?.orderCode ?? data?.code)
  if (id == null || String(id).trim() === '') return null
  const prefix = event === 'novo_pedido_cozinha' ? 'c' : 'o'
  return `${prefix}:${id}:r${data?._rodada ?? 0}`
}

function pedidoEncerrado(data) {
  const status = String(data?.status ?? '').toUpperCase()
  return STATUS_ENCERRADOS.has(status) || !!data?.closed_at || !!data?.closedAt || !!data?.paidAt
}

// `store`: qualquer objeto com get/set (electron-store em produção).
function createHandledSet(store) {
  const load = () => {
    const v = store.get(STORE_KEY)
    return Array.isArray(v) ? v : []
  }
  return {
    has(key) { return key != null && load().includes(key) },
    add(key) {
      if (key == null) return
      const list = load().filter((k) => k !== key)
      list.push(key)
      store.set(STORE_KEY, list.slice(-MAX_HANDLED))
    },
  }
}

module.exports = { viaKey, pedidoEncerrado, createHandledSet, MAX_HANDLED }
