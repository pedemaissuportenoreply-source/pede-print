'use strict'
// Golden byte a byte do perfil Daruma por documento + garantias que a 1.7.7/1.7.8
// quebraram: cabeçalho do tenant presente, ESC @ SÓ no byte inicial de cada via
// e corte SÓ no fim. (Arquivo separado: troca o perfil ativo do processo.)
process.env.TZ = 'America/Fortaleza'
const test = require('node:test')
const assert = require('node:assert')
const printer = require('../printer')
const profiles = require('../printer-profiles')
const { gerar, tenant } = require('./fixtures/gerar-daruma')
const GOLDEN = require('./fixtures/cupons-daruma.snap.json')

const _log = console.log
console.log = () => {}
const DOCS = gerar(printer, profiles)
console.log = _log

const CUT = Buffer.from([0x1d, 0x56, 0x01, 0x1b, 0x6d])
const ESC_AT = Buffer.from([0x1b, 0x40])
const ocorrencias = (buf, sub) => { const r = []; let i = -1; while ((i = buf.indexOf(sub, i + 1)) !== -1) r.push(i); return r }

test('Daruma: golden byte a byte de cada documento', () => {
  assert.deepStrictEqual(Object.keys(DOCS).sort(), Object.keys(GOLDEN).sort())
  for (const [k, b] of Object.entries(DOCS)) assert.strictEqual(b.toString('hex'), GOLDEN[k], k)
})

test('Daruma: ESC @ só no byte inicial de cada via', () => {
  for (const [k, b] of Object.entries(DOCS)) assert.deepStrictEqual(ocorrencias(b, ESC_AT), [0], k)
})

test('Daruma: corte só no fim de cada via, com feed antes', () => {
  for (const [k, b] of Object.entries(DOCS)) {
    assert.deepStrictEqual(ocorrencias(b, CUT), [b.length - CUT.length], k)
    assert.ok(b.subarray(b.length - CUT.length - 6, b.length - CUT.length).equals(Buffer.from('\n'.repeat(6))), k)
  }
})

test('Daruma: cabeçalho do tenant em todos os documentos com cabeçalho', () => {
  const comCabecalho = ['delivery:cliente', 'pagamento', 'pagamento-mesa', 'pagamento-dividido', 'fechamento-caixa']
  for (const k of comCabecalho) {
    const t = DOCS[k].toString('latin1')
    assert.ok(t.includes(tenant.tenantName), `${k}: nome`)
    // o cabeçalho vem ANTES de qualquer separador/linha de conteúdo
    assert.ok(t.indexOf(tenant.tenantName) < t.indexOf('====='), `${k}: nome no topo`)
  }
  for (const k of ['delivery:cliente', 'pagamento', 'pagamento-dividido']) {
    const t = DOCS[k].toString('latin1')
    assert.ok(t.includes('Rua A, 10') && t.includes('Jaguaribe') && t.includes('12.345.678/0001-90'), `${k}: endereço/cidade/CNPJ`)
    assert.ok(/99999-?0000/.test(t), `${k}: telefone`)
  }
  assert.ok(DOCS['teste-balcao'].toString('latin1').includes('Pede+ Print'))
})

test('Daruma: sem QR do motoboy; tamanho duplo desligado com ESC ! 0 (sem reset)', () => {
  const cli = DOCS['delivery:cliente']
  assert.ok(!cli.includes(Buffer.from([0x1d, 0x28, 0x6b])) && !cli.includes(Buffer.from([0x1d, 0x76, 0x30])))
  assert.ok(/Motoboy: digite o n.mero/.test(cli.toString('latin1')))
  for (const [k, b] of Object.entries(DOCS)) {
    if (b.includes(Buffer.from([0x1b, 0x21, 0x30])) || b.includes(Buffer.from([0x1b, 0x21, 0x10]))) {
      assert.ok(b.includes(Buffer.from([0x1b, 0x21, 0x00])), `${k}: ESC ! 0 depois do tamanho duplo`)
    }
  }
})
