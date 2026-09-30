'use strict'
// Via de pedido ALTERADO (edição de delivery pela KDS): cabeçalho "PEDIDO
// ALTERADO (rev N)", marcas +NOVO / ALTERADO / -REMOVIDO nos itens, total
// anterior e diferença — na via da cozinha e na do cliente.
process.env.TZ = 'America/Fortaleza'
const test = require('node:test')
const assert = require('node:assert')
const { buildReceiptBuffer } = require('../printer')

const visivel = (buf) => buf.toString('latin1')
  .replace(/\x1b[@2]/g, '')
  .replace(/\x1b[Et!a\-3]./g, '')
  .replace(/\x1d[B!]./g, '')
  .replace(/\x1dV[\s\S]{1,2}/g, '')
  .replace(/[\x00-\x09\x0b-\x1f]/g, '')

const alteracao = {
  revisao: 2,
  titulo: '*** PEDIDO ALTERADO (rev 2) ***',
  alteradoEm: '2026-09-29T19:30:00Z',
  totalAnterior: 50,
  totalNovo: 62.5,
  diferencaAReceber: 12.5,
  diferencaFormaPagamento: 'Dinheiro',
  valorADevolver: null,
  observacaoPedido: 'Tocar o interfone',
}

test('via da cozinha: título da alteração e marca por item', () => {
  const buf = buildReceiptBuffer({
    type: 'kitchen',
    serviceType: 'DELIVERY',
    _kitchenOnly: true,
    viaTitulo: 'ALTERADO REV 2',
    cabecalhoVia: { numero: 'D014', canal: 'DELIVERY', destino: 'DELIVERY - CARLOS', tipo: 'DELIVERY', cliente: null, mesa: null, criadoEm: '2026-09-29T19:17:00Z' },
    alteracao,
    items: [
      { nome: 'X-Burger', quantity: 1, marca: 'NOVO' },
      { nome: 'Batata', quantity: 2, marca: 'ALTERADO', observacao: 'QTD 3 -> 2' },
      { nome: 'Refri', quantity: 1, marca: 'REMOVIDO' },
    ],
  }, 48)
  const txt = visivel(buf)
  assert.match(txt, /PEDIDO ALTERADO \(rev 2\)/)
  assert.match(txt, /Alterado em 29\/09\/2026 16:30/)
  assert.match(txt, />>> \+NOVO <<</)
  assert.match(txt, />>> ALTERADO <<</)
  assert.match(txt, />>> -REMOVIDO <<</)
  assert.match(txt, /OBS PEDIDO: Tocar o interfone/)
})

test('via do cliente: pedido completo marcado, total anterior e diferença', () => {
  const buf = buildReceiptBuffer({
    type: 'delivery',
    serviceType: 'DELIVERY',
    _customerOnly: true,
    orderCode: 'D014',
    alteracao,
    total: 62.5,
    items: [
      { name: 'X-Burger', qty: 1, unitPrice: 30, subtotal: 30 },
      { name: 'Batata', qty: 2, unitPrice: 12.5, subtotal: 25, marca: 'NOVO' },
      { name: 'Refri', qty: 1, unitPrice: null, subtotal: 0, marca: 'REMOVIDO' },
    ],
    taxaEntrega: 7.5,
  }, 48)
  const txt = visivel(buf)
  assert.match(txt, /PEDIDO ALTERADO \(rev 2\)/)
  assert.match(txt, /\+NOVO BATATA/)
  assert.match(txt, /-REMOVIDO REFRI/)
  assert.match(txt, /Total anterior:\s+R\$ ?50,00/)
  assert.match(txt, /COBRAR NA ENTREGA:\s+R\$ ?12,50/)
})

test('payload sem alteração: nada de marca nem título', () => {
  const buf = buildReceiptBuffer({
    type: 'kitchen', serviceType: 'DELIVERY', _kitchenOnly: true,
    items: [{ nome: 'X-Burger', quantity: 1 }],
  }, 48)
  const txt = visivel(buf)
  assert.doesNotMatch(txt, /ALTERADO|<<</)
})
