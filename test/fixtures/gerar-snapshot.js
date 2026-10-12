'use strict'
// Gera test/fixtures/cupons-generico.snap.json com os bytes de HOJE (perfil
// Genérico). Rodar só quando a mudança no cupom genérico for intencional.
process.env.TZ = 'America/Fortaleza'
const fs = require('fs')
const path = require('path')
const { buildReceiptBuffer } = require('../../printer')
const F = require('./cupons-snapshot')

function bytes(data, cols) {
  const r = buildReceiptBuffer(data, cols)
  if (Buffer.isBuffer(r)) return r.toString('hex')
  return { kitchen: r.kitchen.toString('hex'), client: r.client.toString('hex') }
}
const casos = {}
for (const cols of [48, 32]) {
  casos[`delivery-${cols}`] = bytes(F.delivery, cols)
  casos[`delivery-nocut-${cols}`] = bytes({ ...F.delivery, _receiptOpts: { noCut: true } }, cols)
  casos[`cozinha-${cols}`] = bytes(F.cozinha, cols)
  casos[`bar-${cols}`] = bytes(F.bar, cols)
  casos[`pagamento-dividido-${cols}`] = bytes(F.pagamentoDividido, cols)
}
fs.writeFileSync(path.join(__dirname, 'cupons-generico.snap.json'), JSON.stringify(casos, null, 1))
console.log('snapshot:', Object.keys(casos).length, 'casos')
