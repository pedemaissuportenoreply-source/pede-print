'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { viaKey, pedidoEncerrado, createHandledSet, MAX_HANDLED } = require('../kitchen-guard')

const memStore = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) } }

test('ignorado conta como tratado e sobrevive a nova instância (restart)', () => {
  const store = memStore()
  const a = createHandledSet(store)
  const k = viaKey('novo_pedido', { id: 38, code: 'G038' })
  assert.strictEqual(a.has(k), false)
  a.add(k) // oferecido -> usuário clicou Ignorar
  assert.strictEqual(createHandledSet(store).has(k), true)
})

test('rodada nova tem chave própria; mesma rodada não repete', () => {
  const r0 = viaKey('novo_pedido', { id: 38 })
  const r1 = viaKey('novo_pedido', { id: 38, _rodada: 120 })
  assert.notStrictEqual(r0, r1)
  assert.strictEqual(r1, viaKey('novo_pedido', { id: 38, _rodada: 120 }))
  assert.strictEqual(viaKey('novo_pedido_cozinha', { id: -5, comandaId: 5, _rodada: 9 }), 'c:5:r9')
})

test('pedido encerrado nunca é oferecido', () => {
  for (const status of ['CLOSED', 'CANCELLED', 'DELIVERED', 'PAGO', 'PAGA', 'ENTREGUE']) {
    assert.strictEqual(pedidoEncerrado({ status }), true, status)
  }
  assert.strictEqual(pedidoEncerrado({ status: 'SENT', closed_at: '2026-09-25T11:14:00Z' }), true)
  assert.strictEqual(pedidoEncerrado({ status: 'SENT' }), false)
  assert.strictEqual(pedidoEncerrado({ status: 'PENDENTE' }), false)
})

test('cap FIFO', () => {
  const s = createHandledSet(memStore())
  for (let i = 0; i <= MAX_HANDLED; i++) s.add(`o:${i}:r0`)
  assert.strictEqual(s.has('o:0:r0'), false)
  assert.strictEqual(s.has(`o:${MAX_HANDLED}:r0`), true)
})
