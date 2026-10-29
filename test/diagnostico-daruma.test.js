'use strict'
// Diagnóstico Daruma (script + botão do app): monta E/F/G/H sem mexer nos bytes do cupom.
process.env.TZ = 'America/Fortaleza'
const test = require('node:test')
const assert = require('node:assert')
const printer = require('../printer')
const profiles = require('../printer-profiles')
const diag = require('../src/diagnostico-daruma')

const _log = console.log
console.log = () => {}
printer.setActiveProfile(profiles.getCatalog().find((p) => p.name === 'Daruma DR800'))
console.log = _log
printer.setPrintParams({ encoding: 'cp1252', codepage: 7 })

const tenant = diag.tenantDaConfig({ tenantName: 'Júnior Loja', tenantAddress: 'Sítio Ação, 17', tenantPhone: '88999990000' }, { tenantCity: 'Jaguaribe', tenantState: 'CE' })
const T = diag.montarTestes(printer, tenant)

test('E: cabeçalho real em cp1252 de 1 byte, com rótulo e corte Daruma', () => {
  const t = T.E.toString('latin1')
  assert.ok(T.E.includes(Buffer.from('J\xfanior Loja', 'latin1')) && T.E.includes(Buffer.from('S\xedtio A\xe7\xe3o', 'latin1')))
  assert.ok(t.indexOf('PEDIDO #D258') < t.indexOf('^^^ TESTE E') && t.includes('DELIVERY'))
  assert.ok(T.E.subarray(T.E.length - diag.CORTE.length).equals(diag.CORTE))
})

test('F: mesmo cabeçalho sem nenhum byte acima de 0x7F', () => {
  const corpo = T.F.subarray(0, T.F.indexOf('^^^'))
  assert.ok([...corpo].every((b) => b < 0x80))
  assert.ok(T.F.toString('latin1').includes('Junior Loja'))
})

test('G/H: vias reais completas, ESC @ só no início e um corte no fim', () => {
  for (const b of [...T.G, T.H]) {
    assert.deepStrictEqual([b.indexOf(Buffer.from([0x1b, 0x40])), b.lastIndexOf(Buffer.from([0x1b, 0x40]))], [0, 0])
    assert.strictEqual(b.indexOf(diag.CORTE), b.length - diag.CORTE.length)
  }
  assert.ok(T.G[1].toString('latin1').includes('^^^ TESTE G'))
})
