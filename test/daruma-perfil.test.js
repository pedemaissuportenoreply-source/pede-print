'use strict'
// Perfil Daruma (DR700/DR800/DR800H): sem QR do motoboy (só o número), corte GS V 1 + ESC m com
// feed antes, ESC @ só no início (fim de estilo por ESC ! 0) e separadores na largura do perfil. Qualquer
// outra impressora fica no Genérico — bytes IGUAIS aos de antes (snapshot).
process.env.TZ = 'America/Fortaleza'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildReceiptBuffer, buildPaginaTeste } = require('../printer')
const { familiaDe, nomeEhDaruma } = require('../printer-familias')
const routing = require('../printer-routing')
const F = require('./fixtures/cupons-snapshot')
const SNAP = require('./fixtures/cupons-generico.snap.json')

const DM = { familia: 'daruma' }
const hex = (b) => b.toString('hex')

// Tokeniza ESC/POS (pula os dados do raster GS v 0) e devolve os comandos.
function comandos(buf) {
  const out = []
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 0x1b) {
      const c = String.fromCharCode(buf[i + 1])
      if (c === '@' || c === '2' || c === 'm') { out.push('ESC ' + c); i += 1 }
      else { out.push('ESC ' + c); i += 2 }
    } else if (b === 0x1d) {
      const c = String.fromCharCode(buf[i + 1])
      if (c === 'v') {
        const xL = buf[i + 4], xH = buf[i + 5], yL = buf[i + 6], yH = buf[i + 7]
        out.push('GS v' + String.fromCharCode(buf[i + 2]))
        i += 7 + (xL + xH * 256) * (yL + yH * 256)
      } else if (c === 'V') { out.push('GS V ' + buf[i + 2]); i += 2 }
      else { out.push('GS ' + c); i += 2 }
    }
  }
  return out
}
// O que a Daruma aceita no modo dela (o resto = não suportado).
// ESC ! e GS B: os mesmos da 1.7.6 nela (tamanho duplo/reverso).
const DARUMA_OK = new Set(['ESC @', 'ESC E', 'ESC !', 'ESC a', 'ESC t', 'ESC -', 'ESC 3', 'ESC 2', 'ESC m', 'GS B', 'GS V 1'])

const texto = (buf) => buf.toString('latin1')
  .replace(/\x1dv0[\s\S]{4}/g, '')
const linhasVisiveis = (buf) => {
  // Tira o raster (bytes binários) antes de olhar as linhas de texto.
  let b = buf
  if (buf.qrRaster) b = Buffer.concat([buf.subarray(0, buf.qrRaster.start), buf.subarray(buf.qrRaster.end)])
  return b.toString('latin1')
    .replace(/\x1b[@2m]/g, '')
    .replace(/\x1b[Eta\-3!]./g, '')
    .replace(/\x1dB./g, '')
    .replace(/\x1dV\x01/g, '')
    .split('\n')
}

test('Genérico: bytes IGUAIS aos de hoje (delivery, cozinha, bar, pagamento dividido, 48 e 32 col)', () => {
  const casos = {}
  for (const cols of [48, 32]) {
    const g = (d) => { const r = buildReceiptBuffer(d, cols); return Buffer.isBuffer(r) ? hex(r) : { kitchen: hex(r.kitchen), client: hex(r.client) } }
    casos[`delivery-${cols}`] = g(F.delivery)
    casos[`delivery-nocut-${cols}`] = g({ ...F.delivery, _receiptOpts: { noCut: true } })
    casos[`cozinha-${cols}`] = g(F.cozinha)
    casos[`bar-${cols}`] = g(F.bar)
    casos[`pagamento-dividido-${cols}`] = g(F.pagamentoDividido)
  }
  assert.deepStrictEqual(casos, SNAP)
})

test('Daruma: sem QR do motoboy (nem GS v 0, nem GS ( k, nem rótulo); só a linha do número', () => {
  for (const cols of [48, 32]) {
    const { client } = buildReceiptBuffer(F.delivery, cols, DM)
    assert.ok(!client.includes(Buffer.from([0x1d, 0x76, 0x30])), 'sem raster GS v 0')
    assert.ok(!client.includes(Buffer.from([0x1d, 0x28, 0x6b])), 'sem QR nativo GS ( k')
    const linhas = linhasVisiveis(client)
    const txt = linhas.join('\n')
    assert.ok(!txt.includes('escaneie'), 'sem rótulo do QR')
    assert.ok(!txt.includes('/motoboy/q/'), 'sem URL/token no papel')
    const i = linhas.findIndex((l) => /^Motoboy: digite o n.mero$/.test(l.trim())) // acento na codepage do perfil
    assert.ok(i > 0, 'linha do motoboy')
    assert.strictEqual(linhas[i + 1].trim(), 'PEDIDO #D249')
    assert.ok(linhas[i].length <= cols && linhas[i + 1].length <= cols && linhas[i + 1].startsWith(' '), 'centralizado nas colunas')
    assert.ok(client.includes(Buffer.concat([Buffer.from([0x1b, 0x45, 0x01]), Buffer.from(linhas[i + 1] + '\n', 'latin1')])), 'número em negrito')
    assert.ok(!txt.includes('698181'), 'código do cliente fora do papel')
  }
})

test('Daruma: rodapé "Emitido por Pede+" antes do feed e do corte', () => {
  const { client } = buildReceiptBuffer(F.delivery, 48, DM)
  const t = client.toString('latin1')
  assert.ok(t.lastIndexOf('Emitido por Pede+') < t.lastIndexOf('\n\n\n\n\n\n\x1dV\x01\x1bm'))
})

test('Genérico: QR do motoboy continua (GS ( k + rótulo)', () => {
  const { client } = buildReceiptBuffer(F.delivery, 48)
  assert.ok(client.includes(Buffer.from([0x1d, 0x28, 0x6b])))
  assert.ok(client.toString('latin1').includes('Motoboy: escaneie pra iniciar'))
})

test('Daruma: corte GS V 1 + ESC m com 6 linhas de feed antes, nas duas vias', () => {
  const r = buildReceiptBuffer(F.delivery, 48, DM)
  const fim = Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01, 0x1b, 0x6d])
  for (const via of [r.kitchen, r.client]) {
    assert.ok(via.subarray(via.length - fim.length).equals(fim))
    assert.ok(!via.includes(Buffer.from([0x1d, 0x56, 0x41])) && !via.includes(Buffer.from([0x1d, 0x56, 0x42])), 'sem GS V função B')
    assert.deepStrictEqual([via.indexOf(Buffer.from([0x1b, 0x40])), via.lastIndexOf(Buffer.from([0x1b, 0x40]))], [0, 0], 'ESC @ só no início')
  }
})

test('Daruma noCut: sem corte, com separador visível + feed entre as vias', () => {
  const r = buildReceiptBuffer({ ...F.delivery, _receiptOpts: { noCut: true } }, 48, DM)
  for (const via of [r.kitchen, r.client]) {
    assert.ok(!via.includes(Buffer.from([0x1d, 0x56])) && !via.includes(Buffer.from([0x1b, 0x6d])))
    assert.ok(texto(via).includes('- - - - -'))
    assert.ok(via.subarray(via.length - 4).equals(Buffer.from('\n\n\n\n')))
  }
})

test('Daruma: separadores na largura do perfil e nenhuma linha passa das colunas', () => {
  for (const cols of [48, 32]) {
    const r = buildReceiptBuffer(F.delivery, cols, DM)
    for (const via of [r.kitchen, r.client]) {
      const linhas = linhasVisiveis(via)
      for (const l of linhas.filter((x) => /^[=-]{8,}$/.test(x) || /^\+-+\+$/.test(x))) assert.strictEqual(l.length, cols, `separador "${l}"`)
      for (const l of linhas) assert.ok(l.length <= cols, `linha longa (${l.length}): "${l}"`)
    }
  }
})

test('Daruma: Hora/Data empilhadas na mesma coluna; Previsão quebra em vez de cortar', () => {
  const r = buildReceiptBuffer(F.delivery, 48, DM)
  const coz = linhasVisiveis(r.kitchen)
  const iHora = coz.findIndex((l) => l.startsWith('Hora: '))
  assert.ok(iHora > 0 && coz[iHora + 1].startsWith('Data: ') && coz[iHora - 1].startsWith('Tipo: '))
  const cli = linhasVisiveis(r.client).join('\n')
  assert.ok(cli.includes('Previsao: 40 a 50 minutos'))
  assert.ok(cli.includes('hoje)'), 'resto da previsão em outra linha, não cortado')
})

test('Daruma: cupom #D249 gerado em arquivo só com comandos suportados', () => {
  const r = buildReceiptBuffer(F.delivery, 48, DM)
  const arq = path.join(os.tmpdir(), 'pede-print-D249-daruma.bin')
  fs.writeFileSync(arq, Buffer.concat([r.kitchen, r.client]))
  const usados = new Set([...comandos(r.kitchen), ...comandos(r.client)])
  const fora = [...usados].filter((c) => !DARUMA_OK.has(c))
  assert.deepStrictEqual(fora, [], 'comandos não suportados: ' + fora.join(', '))
})

test('Família: só o nome Daruma promove; perfil escolhido manda; resto = Genérico', () => {
  assert.strictEqual(familiaDe(null, 'EPSON TM-T20 Receipt'), 'generica')
  assert.strictEqual(familiaDe(null, 'ELGIN i9'), 'generica')
  assert.strictEqual(familiaDe(null, 'POS-80'), 'generica')
  assert.strictEqual(familiaDe(null, 'COM7'), 'generica')
  assert.strictEqual(familiaDe(null, 'DARUMA DR800'), 'daruma')
  assert.strictEqual(familiaDe(null, 'DR800 Termica'), 'daruma')
  assert.strictEqual(familiaDe(null, 'dr-700'), 'daruma')
  assert.strictEqual(familiaDe({ brand: 'Daruma', name: 'Daruma DR800' }, 'COM7', { explicito: true }), 'daruma')
  assert.strictEqual(familiaDe({ brand: 'Generico', name: 'Generico ESC/POS' }, 'DARUMA DR800', { explicito: true }), 'generica')
  assert.strictEqual(familiaDe({ brand: 'Epson', name: 'Epson TM-T20' }, 'X', { explicito: true }), 'epson')
  assert.ok(nomeEhDaruma('Daruma') && !nomeEhDaruma('Bematech MP-4200'))
})

test('Auto-detecção por nome: Daruma sim; Epson/Elgin/Bematech não (ficam no Genérico)', () => {
  assert.strictEqual(routing.suggestByName('EPSON TM-T20'), null)
  assert.strictEqual(routing.suggestByName('ELGIN i9'), null)
  assert.strictEqual(routing.suggestByName('Bematech MP-4200 TH'), null)
  assert.match(routing.suggestByName('DARUMA DR800').name, /DR800/)
  assert.match(routing.suggestByName('DR700').name, /DR700/)
})

test('Página de teste: régua e corte do perfil; Daruma sem QR', () => {
  const dm = buildPaginaTeste(48, 'daruma', false)
  assert.ok(!dm.includes(Buffer.from([0x1d, 0x76, 0x30])) && !dm.includes(Buffer.from([0x1d, 0x28, 0x6b])), 'Daruma sem QR')
  assert.ok(texto(dm).includes('QR desligado neste perfil'))
  assert.ok(dm.subarray(dm.length - 5).equals(Buffer.from([0x1d, 0x56, 0x01, 0x1b, 0x6d])))
  assert.ok(texto(dm).includes('123456789012345678901234567890123456789012345678'))
  assert.deepStrictEqual([dm.indexOf(Buffer.from([0x1b, 0x40])), dm.lastIndexOf(Buffer.from([0x1b, 0x40]))], [0, 0], 'ESC @ só no início')
  assert.ok(texto(dm).includes('DUPLO') && dm.includes(Buffer.from([0x1b, 0x21, 0x00])))
  const gen = buildPaginaTeste(32, 'generica', true)
  assert.ok(texto(gen).includes('DUPLO'))
  assert.ok(gen.includes(Buffer.from([0x1d, 0x28, 0x6b])), 'Genérico com QR nativo')
  assert.ok(!gen.includes(Buffer.from([0x1d, 0x56])), 'noCut sem corte')
})
