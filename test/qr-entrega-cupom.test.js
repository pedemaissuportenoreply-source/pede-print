'use strict'
// QR do motoboy no cupom de entrega: sai só com `qrEntrega` (payload novo);
// payload antigo sai sem QR; o código do cliente (DLV) nunca é impresso.
process.env.TZ = 'America/Fortaleza'
const test = require('node:test')
const assert = require('node:assert')
const { buildReceiptBuffer } = require('../printer')

const CRIADO = '2026-10-12T21:30:00Z'
const URL_QR = 'https://app.pedeplus.com.br/motoboy/q/AbCdEfGhIjKlMnOpQrStUv'
const recibo = (extra = {}) => ({
  type: 'delivery', _customerOnly: true, tenantName: 'Pede Restaurante', orderCode: 'D244', serviceType: 'DELIVERY',
  deliveryCode: 'DLV-698181', paymentStatus: 'Pendente', paymentMethod: 'Dinheiro', formaPagamento: 'dinheiro',
  customer: { name: 'Cliente', phone: '88981308321' }, customer_name: 'Cliente',
  deliveryAddress: { street: 'Rua A', number: '10', neighborhood: 'Centro', city: 'Cidade' },
  items: [{ name: 'X-Burguer', qty: 1, unitPrice: 20, subtotal: 20, addons: [], addonsDetail: [] }],
  subtotal: 20, deliveryFee: 5, taxaEntrega: 5, total: 25, createdAt: CRIADO, printedAt: CRIADO,
  ...extra,
})
// GS ( k ... 0x31 0x50 0x30 = armazena dados do QR.
const temQr = (buf) => buf.includes(Buffer.from([0x1d, 0x28, 0x6b])) && buf.includes(Buffer.from([0x31, 0x50, 0x30]))

test('payload novo com qrEntrega: QR com a URL + rótulo do motoboy', () => {
  const buf = buildReceiptBuffer(recibo({ qrEntrega: { url: URL_QR, rotulo: 'Motoboy: escaneie pra iniciar' } }), 48)
  const txt = buf.toString('latin1')
  assert.ok(temQr(buf))
  assert.ok(txt.includes(URL_QR))
  assert.ok(txt.includes('Motoboy: escaneie pra iniciar'))
  assert.ok(txt.includes('PEDIDO #D244'))
  assert.ok(!txt.includes('698181'), 'código do cliente nunca no papel')
})

test('payload antigo (sem token): sem QR, cupom normal', () => {
  const buf = buildReceiptBuffer(recibo(), 48)
  assert.ok(!temQr(buf))
  assert.ok(buf.toString('latin1').includes('PEDIDO #D244'))
})

test('qrEntrega inválido (não-URL / objeto vazio): sem QR', () => {
  assert.ok(!temQr(buildReceiptBuffer(recibo({ qrEntrega: { url: 'DLV-698181' } }), 48)))
  assert.ok(!temQr(buildReceiptBuffer(recibo({ qrEntrega: {} }), 48)))
  assert.ok(!temQr(buildReceiptBuffer(recibo({ qrEntrega: 'x' }), 48)))
})
