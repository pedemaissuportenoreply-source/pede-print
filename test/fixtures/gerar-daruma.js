'use strict'
// Golden do perfil DARUMA (DR800 do catálogo + família daruma), um por documento.
// `node test/fixtures/gerar-daruma.js` regrava test/fixtures/cupons-daruma.snap.json
// — só quando a mudança no cupom da Daruma for intencional.
process.env.TZ = 'America/Fortaleza'
const fs = require('fs')
const path = require('path')
const F = require('./cupons-snapshot')

const tenant = {
  tenantName: 'Pede Restaurante', tenantAddress: 'Rua A, 10', tenantNumber: '10', tenantNeighborhood: 'Centro',
  tenantCity: 'Jaguaribe', tenantState: 'CE', tenantPhone: '88999990000', tenantCnpj: '12.345.678/0001-90',
}

const DOCUMENTOS = {
  delivery: { ...F.delivery, ...tenant },
  'balcao-cozinha': { ...F.cozinha, serviceType: 'BALCAO', cabecalhoVia: { numero: 'B201', canal: 'BALCAO', destino: 'BALCÃO', tipo: 'BALCÃO', cliente: 'João', mesa: null, criadoEm: F.cozinha.createdAt } },
  cozinha: F.cozinha,
  bar: F.bar,
  pagamento: { ...tenant, type: 'payment', _printType: 'receipt', orderCode: 'B201', serviceType: 'BALCAO', paymentMethod: 'Pix', items: F.delivery.items, subtotal: 44, total: 44, createdAt: F.delivery.createdAt, printedAt: F.delivery.printedAt },
  'pagamento-mesa': { ...tenant, ...F.pagamentoDividido, splitPayments: undefined, splitRows: undefined, paymentMethod: 'Cartão' },
  'pagamento-dividido': { ...tenant, ...F.pagamentoDividido },
  'fechamento-caixa': {
    type: 'caixa', sessaoId: 7, ...tenant, operator: 'Junior', openedAt: '2026-09-26T11:00:00Z', closedAt: '2026-09-26T21:00:00Z',
    valorAbertura: 50, payments: { dinheiro: 47, cartao: 10, pix: 18, fiado: 0, outros: 0 }, totalVendas: 75, numPedidos: 4,
    porTipo: [{ tipo: 'COUNTER', count: 2, total: 43 }], suprimentos: [], sangrias: [], totalSuprimentos: 0, totalSangrias: 0,
    saldoEsperado: 125, valorFechamento: 125, diferenca: 0, printedAt: F.delivery.printedAt,
  },
  'teste-balcao': {
    _printType: 'receipt', tenantName: 'Pede+ Print', tenantAddress: 'Rua Exemplo, 123 - Centro', tenantPhone: '(11) 99999-9999',
    orderCode: 'TESTE', createdAt: F.delivery.createdAt, printedAt: F.delivery.printedAt, serviceType: 'BALCAO', table: 'Mesa 1',
    customer: 'Cliente Teste', paymentMethod: 'Dinheiro', items: [{ qty: 1, name: 'Refrigerante Lata', subtotal: 7, addons: [], obs: null }],
    subtotal: 7, total: 7,
  },
}

/** Bytes de cada documento no perfil Daruma: { nome[:via]: Buffer }. */
function gerar(printer, profiles, cols = 48) {
  const prof = profiles.getCatalog().find((p) => p.name === 'Daruma DR800')
  printer.setActiveProfile(prof)
  printer.setPrintParams({ encoding: prof.encoding, codepage: prof.codepageEscT })
  const out = {}
  for (const [k, d] of Object.entries(DOCUMENTOS)) {
    const r = printer.buildReceiptBuffer(d, cols, { familia: 'daruma' })
    if (Buffer.isBuffer(r)) out[k] = r
    else { out[k + ':cozinha'] = r.kitchen; out[k + ':cliente'] = r.client }
  }
  out['pagina-teste'] = printer.buildPaginaTeste(cols, 'daruma', false)
  return out
}

module.exports = { DOCUMENTOS, gerar, tenant }

if (require.main === module) {
  const log = console.log; console.log = () => {}
  const docs = gerar(require('../../printer'), require('../../printer-profiles'))
  const hex = Object.fromEntries(Object.entries(docs).map(([k, b]) => [k, b.toString('hex')]))
  fs.writeFileSync(path.join(__dirname, 'cupons-daruma.snap.json'), JSON.stringify(hex, null, 1))
  log('golden daruma:', Object.keys(hex).length, 'documentos')
}
