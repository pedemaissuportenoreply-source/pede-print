'use strict'
// Cupom de pedido de MARKETPLACE (iFood/99Food): mesmas informações do modal do
// KDS. Pedido próprio sai igual a antes; payload antigo (sem `marketplace`) e
// agente antigo com payload novo não quebram.
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
const linhas = (txt) => txt.split('\n')

const CRIADO = '2026-10-11T21:30:00Z'

// Como o backend manda o recibo de delivery do iFood #7456 (Pede+ D244).
const itens = [
  { name: 'PRODUTO 1 - NAO ENTREGAR - Primeiro Nivel', qty: 1, unitPrice: 5, subtotal: 5, addons: [], addonsDetail: [] },
  {
    name: 'PRODUTO 2 (COMBO) - NAO ENTREGAR - Primeiro Nivel', qty: 1, unitPrice: 16, subtotal: 16,
    addons: ['1x Complemento 1 - Segundo Nivel', '1x Complemento 2 - Segundo Nivel'],
    addonsDetail: [{ name: 'Complemento 1 - Segundo Nivel', qty: 1, price: 2 }, { name: 'Complemento 2 - Segundo Nivel', qty: 1, price: 2 }],
  },
]
const reciboIfood = (extra = {}) => ({
  type: 'delivery', _customerOnly: true, tenantName: 'Pede Restaurante', orderCode: 'D244', serviceType: 'DELIVERY',
  deliveryCode: 'DLV-698181', paymentStatus: 'Pago', paymentMethod: 'Pago no iFood', formaPagamento: 'pago_ifood',
  customer: { name: 'Pedido de teste de integracao', phone: null }, customer_name: 'Pedido de teste de integracao',
  deliveryAddress: { street: 'Rua TESTE', number: '999', neighborhood: 'Centro', city: 'Cidade' },
  items: itens, subtotal: 21, deliveryFee: 5, taxaEntrega: 5, taxaServico: 1, total: 27, createdAt: CRIADO, printedAt: CRIADO,
  marketplace: {
    provider: 'IFOOD', rotulo: 'IFOOD', displayId: '7456', codigoInterno: 'D244', tipo: 'DELIVERY', entregaPor: 'LOJA',
    codigoColeta: '3862', localizador: '25933687', telefone: '0800 705 6070',
    pagamento: 'Crédito Visa + Crédito Master — online', pagoNoApp: true,
  },
  ...extra,
})

for (const cols of [48, 32]) {
  test(`cupom iFood ${cols} colunas: cabeçalho, cliente, código e pagamento do app`, () => {
    const t = visivel(buildReceiptBuffer(reciboIfood(), cols))
    assert.match(t, /IFOOD #7456/)
    assert.match(t, /Pede\+ D244/)
    assert.match(t, /ENTREGA PELA LOJA/)
    assert.match(t, /Tel: 0800 705 6070/)
    assert.match(t, /Localizador: 25933687/)
    // Nenhum código no cupom (nem o de coleta que o backend antigo mandava).
    assert.doesNotMatch(t, /CODIGO IFOOD|3 8 6 2|3862|Peca ao cliente/)
    assert.match(t, /PAGO NO IFOOD/)
    assert.match(t.replace(/\s+/g, ' '), /Credito Visa \+ Credito Master - online/)
    assert.doesNotMatch(t, /Informe ao entregador/, 'código do Pede+ não é o destaque no marketplace')
    assert.doesNotMatch(t, /FORMA: PAGO_IFOOD/)
    assert.doesNotMatch(t, /PEDIDO #D244/)
    assert.match(t, /TOTAL C\/ SERVICO:\s+R\$ 27,00/)
    // Complementos inteiros (quebra com recuo, nunca truncados) e sem "+R$" (o
    // unitário do app já inclui os complementos).
    assert.match(t.replace(/\s+/g, ' '), /Complemento 1 - Segundo Nivel/)
    assert.doesNotMatch(t, /\+R\$ 2,00/)
    for (const l of linhas(t)) assert.ok(l.length <= cols, `linha > ${cols}: "${l}"`)
  })
}

test('entrega pelo entregador do iFood: tipo certo e nenhum código', () => {
  const base = reciboIfood()
  const t = visivel(buildReceiptBuffer({ ...base, marketplace: { ...base.marketplace, entregaPor: 'APP' } }, 48))
  assert.match(t, /ENTREGA IFOOD/)
  assert.doesNotMatch(t, /CODIGO IFOOD|3862|3 8 6 2|vai pedir/)
  assert.doesNotMatch(t, /Cod\. entrega Pede\+/)
})

test('payload sem código: nenhum bloco de código', () => {
  const base = reciboIfood()
  const t = visivel(buildReceiptBuffer({ ...base, marketplace: { ...base.marketplace, codigoColeta: null } }, 48))
  assert.doesNotMatch(t, /CODIGO IFOOD/)
  assert.doesNotMatch(t, /CODIGO DA ENTREGA/)
})

test('pagamento na entrega: forma + troco, sem "PAGO"', () => {
  const base = reciboIfood()
  const t = visivel(buildReceiptBuffer({
    ...base, paymentStatus: 'A pagar', formaPagamento: 'dinheiro', paymentMethod: 'Dinheiro', needsChange: true, trocoPara: 50,
    marketplace: { ...base.marketplace, pagoNoApp: false, pagamento: 'Dinheiro — na entrega' },
  }, 48))
  assert.doesNotMatch(t, /PAGO NO IFOOD/)
  assert.match(t, /A PAGAR NA ENTREGA/)
  assert.match(t, /FORMA: DINHEIRO/)
  assert.match(t, /TROCO PARA/)
})

test('via da cozinha do iFood: número grande no topo, sem telefone/localizador', () => {
  const t = visivel(buildReceiptBuffer({
    type: 'kitchen', _kitchenOnly: true, orderCode: 'D244', tenantName: 'Pede Restaurante', serviceType: 'DELIVERY',
    customer_name: 'Pedido de teste', items: itens, createdAt: CRIADO,
    cabecalhoVia: { numero: 'D244', canal: 'DELIVERY', destino: 'IFOOD #7456 - DELIVERY - PEDIDO DE TESTE', tipo: 'DELIVERY', cliente: null, mesa: null, criadoEm: CRIADO },
    marketplace: { provider: 'IFOOD', rotulo: 'IFOOD', displayId: '7456', codigoInterno: 'D244' },
  }, 48))
  assert.match(t, /IFOOD #7456/)
  assert.match(t, /Pede\+ D244/)
  assert.match(t, /DELIVERY - PEDIDO DE TESTE/)
  assert.doesNotMatch(t, /0800|Localizador/)
  assert.match(t.replace(/\s+/g, ' '), /\+ 1x Complemento 1 - Segundo Nivel/)
})

test('payload antigo de pedido do iFood (sem `marketplace`) imprime o layout de sempre', () => {
  const { marketplace, ...antigo } = reciboIfood()
  void marketplace
  const t = visivel(buildReceiptBuffer(antigo, 48))
  assert.match(t, /PEDIDO #D244/)
  // Código de entrega é do cliente: nunca no papel, mesmo com o campo no payload.
  assert.doesNotMatch(t, /CODIGO DA ENTREGA|698181|DLV-/)
  assert.ok(t.length > 200, 'não sai em branco')
})

test('`marketplace` inválido é ignorado (sem quebrar)', () => {
  for (const lixo of [null, 'IFOOD', 42, {}, { rotulo: '' }]) {
    const t = visivel(buildReceiptBuffer(reciboIfood({ marketplace: lixo }), 48))
    assert.match(t, /PEDIDO #D244/)
  }
})

test('delivery próprio: código de entrega do cliente nunca é impresso (payload antigo com o campo)', () => {
  for (const cols of [48, 32]) {
    const t = visivel(buildReceiptBuffer({
      type: 'delivery', _customerOnly: true, tenantName: 'Loja', orderCode: 'D100', serviceType: 'DELIVERY',
      deliveryCode: 'DLV-123456', delivery_code: 'DLV-123456', paymentStatus: 'A pagar', formaPagamento: 'dinheiro',
      customer_name: 'Ana', items: [{ nome: 'X-Bacon', quantity: 1, preco: 20 }], subtotal: 20, total: 25, taxaEntrega: 5,
      createdAt: CRIADO, printedAt: CRIADO,
    }, cols))
    assert.match(t, /PEDIDO #D100/, 'número do pedido continua')
    assert.doesNotMatch(t, /CODIGO DA ENTREGA|Informe ao entregador|123456|DLV-/)
  }
})
