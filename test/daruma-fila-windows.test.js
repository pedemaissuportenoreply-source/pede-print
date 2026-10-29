'use strict'
// Daruma na FILA DO WINDOWS (ex.: "Daruma DR800 Spooler"): antes recebia os bytes
// da Genérica (QR GS ( k + logo GS v 0 + corte GS V B), que a Daruma não entende —
// o QR engolia o fim de uma via e o cabeçalho da seguinte, e sem corte o bloco
// "Previsao/Motoboy" aparecia no topo e no fim. Agora a família vale em qualquer
// transporte. (Arquivo separado: troca o perfil ativo do processo.)
process.env.TZ = 'America/Fortaleza'
const test = require('node:test')
const assert = require('node:assert')
const printer = require('../printer')
const profiles = require('../printer-profiles')
const routing = require('../printer-routing')
const F = require('./fixtures/cupons-snapshot')

const _log = console.log
const _warn = console.warn
console.log = () => {}
console.warn = () => {}
test.after(() => { console.log = _log; console.warn = _warn })

const DARUMA = profiles.getCatalog().find((p) => p.name === 'Daruma DR800')
const GENERICO = profiles.genericProfile()
const EPSON = profiles.getCatalog().find((p) => p.name === 'Epson TM-T20')
const GS_QR = Buffer.from([0x1d, 0x28, 0x6b])
const GS_V0 = Buffer.from([0x1d, 0x76, 0x30])
const LOGO_FAKE = Buffer.concat([Buffer.from([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00]), Buffer.from([0xff])])
const ocorr = (txt, s) => txt.split(s).length - 1

function build(data, familia, profile) {
  printer.setActiveProfile(profile)
  printer.setPrintParams({ encoding: profile.encoding, codepage: profile.codepageEscT })
  return printer.buildReceiptBuffer(data, 48, { familia })
}

test('família Daruma vale na fila do Windows (perfil escolhido ou nome)', () => {
  assert.strictEqual(printer.familiaDoAlvo('Daruma DR800 Spooler (Copiar 1)', { profile: DARUMA }), 'daruma')
  assert.strictEqual(printer.familiaDoAlvo('Minha Fila', { profile: DARUMA }), 'daruma')
  printer.setActiveProfile(EPSON)
  assert.strictEqual(printer.familiaDoAlvo('DARUMA DR800'), 'daruma')
  // Override manual pro padrão vence o nome.
  assert.strictEqual(printer.familiaDoAlvo('DARUMA DR800', { profile: GENERICO }), 'generica')
  assert.strictEqual(printer.familiaDoAlvo('EPSON TM-T20', { profile: EPSON }), 'epson')
  assert.strictEqual(printer.familiaDoAlvo('EPSON TM-T20'), 'generica')
})

test('roteamento: fila do Windows com "DARUMA" e sem modelo escolhido usa o perfil Daruma', () => {
  const dr = routing.suggestByName('Daruma DR800 Spooler (Copiar 1)', { soMarca: true })
  assert.ok(dr && /daruma/i.test(dr.brand))
  assert.strictEqual(routing.suggestByName('EPSON TM-T20', { soMarca: true }), null)
})

test('Daruma: delivery sem GS ( k nem GS v 0, cabeçalho de texto no topo, rodapé uma vez', () => {
  const r = build(F.delivery, 'daruma', DARUMA)
  for (const [via, b] of [['cozinha', r.kitchen], ['cliente', r.client]]) {
    assert.ok(!b.includes(GS_QR), `${via}: GS ( k`)
    assert.ok(!b.includes(GS_V0), `${via}: GS v 0`)
    assert.deepStrictEqual([b[0], b[1]], [0x1b, 0x40], `${via}: ESC @ no início`)
  }
  const t = r.client.toString('latin1')
  assert.ok(t.indexOf('Pede Restaurante') > -1 && t.indexOf('Pede Restaurante') < t.indexOf('CLIENTE'), 'nome antes do cliente')
  assert.ok(t.includes('D249') && t.indexOf('D249') < t.indexOf('CLIENTE'), 'número antes do cliente')
  assert.ok(/DELIVERY/.test(t.slice(0, t.indexOf('CLIENTE'))), 'tipo no cabeçalho')
  assert.strictEqual(ocorr(t, 'Previsao'), 1)
  assert.strictEqual(ocorr(t, 'MOTOBOY: informe o PEDIDO'), 1)
  // Sem QR na Daruma, nada de "escaneie": o motoboy informa o número.
  assert.ok(!t.includes('escaneie'))
  assert.ok(!t.includes('/motoboy/q/'))
})

test('Daruma: rodapé completo ANTES do corte e nenhum texto depois dele', () => {
  const CUT = Buffer.from([0x1d, 0x56, 0x01, 0x1b, 0x6d])
  for (const cols of [48, 32]) {
    printer.setActiveProfile(DARUMA)
    const r = printer.buildReceiptBuffer(F.delivery, cols, { familia: 'daruma' })
    for (const [via, b] of [['cozinha', r.kitchen], ['cliente', r.client]]) {
      const iCut = b.indexOf(CUT)
      assert.strictEqual(iCut, b.length - CUT.length, `${via}: corte só no último byte`)
      assert.strictEqual(b.subarray(iCut + CUT.length).length, 0, `${via}: nada depois do corte`)
      assert.strictEqual(b.indexOf(Buffer.from([0x1b, 0x40]), 1), -1, `${via}: ESC @ só no início`)
    }
    const t = r.client.toString('latin1')
    const iCut = r.client.indexOf(CUT)
    const ordem = ['NAO E DOCUMENTO FISCAL', 'Obrigado pela preferencia', 'pedeplus.com.br'].map((s) => t.indexOf(s))
    assert.ok(ordem.every((i) => i > -1 && i < iCut), `${cols}: rodapé antes do corte`)
    assert.deepStrictEqual([...ordem].sort((a, b) => a - b), ordem, `${cols}: ordem do rodapé`)
    assert.ok(/-{10,}\n\s*NAO E DOCUMENTO FISCAL/.test(t), `${cols}: divisor antes do aviso`)
  }
})

test('Daruma: logo raster nunca sai (nem derruba o cabeçalho)', () => {
  const pagamento = {
    type: 'payment', _printType: 'receipt', tenantName: 'Pede Restaurante', orderCode: 'B201', serviceType: 'BALCAO',
    paymentMethod: 'Pix', items: F.delivery.items, subtotal: 44, total: 44, createdAt: F.delivery.createdAt,
    printedAt: F.delivery.printedAt, _logoBuffer: LOGO_FAKE,
  }
  const b = build(pagamento, 'daruma', DARUMA)
  assert.ok(!b.includes(GS_V0))
  assert.ok(b.toString('latin1').includes('Pede Restaurante'))
  // Padrão: logo continua saindo como hoje.
  assert.ok(build(pagamento, 'generica', EPSON).includes(LOGO_FAKE))
})

test('Daruma: NFC-e sem GS ( k (consulta em texto)', () => {
  const nfce = { type: 'nfce', nfce: { numero: 1, serie: 1, emitidaEm: F.delivery.createdAt, qrcode: 'https://sefaz.exemplo/qr?p=123', emitente: {}, itens: [] } }
  const b = build(nfce, 'daruma', DARUMA)
  assert.ok(!b.includes(GS_QR))
  assert.ok(b.toString('latin1').includes('https://sefaz.exemplo/qr?p=123'))
  assert.ok(build(nfce, 'generica', EPSON).includes(GS_QR))
})

test('padrão: delivery com cabeçalho de texto antes do QR e rodapé uma vez', () => {
  const r = build(F.delivery, 'generica', EPSON)
  const t = r.client.toString('latin1')
  assert.ok(t.indexOf('Pede Restaurante') < r.client.indexOf(GS_QR))
  assert.strictEqual(ocorr(t, 'Previsao'), 1)
  assert.strictEqual(ocorr(t, 'escaneie pra iniciar'), 1)
  // Padrão não ganha o aviso fiscal nem o texto do motoboy da Daruma.
  assert.ok(!t.includes('NAO E DOCUMENTO FISCAL') && !t.includes('MOTOBOY: informe'))
})
