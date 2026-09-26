'use strict'
// Cupom de FECHAMENTO DE CAIXA (type 'caixa' / alias 'fechamento-caixa'): buffer
// ESC/POS com e sem descontos, lista limitada a 30 + "e mais N", texto do usuário
// sem byte de controle, largura 58/80mm e corte respeitando noCut.
// Snapshot: UPDATE_SNAPSHOT=1 npm test regrava test/fixtures/fechamento-caixa.snap.txt.
process.env.TZ = 'America/Fortaleza'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { buildReceiptBuffer, getActiveProfile } = require('../printer')

const SNAP = path.join(__dirname, 'fixtures', 'fechamento-caixa.snap.txt')
const CUT = Buffer.from(getActiveProfile().commands.cut)

const pedidos = (n) => Array.from({ length: n }, (_, i) => ({
  orderId: i, pedido: String(100 + i), canal: 'Mesa 1', hora: `12:${String(i % 60).padStart(2, '0')}`,
  operador: 'Ana', cupomCodigo: i % 2 ? 'QATESTE10' : null, desconto: 1, cupom: i % 2 ? 2 : 0,
}))

const base = (over = {}) => ({
  type: 'caixa', sessaoId: 7, tenantName: 'Pizzaria Teste', operator: 'Junior',
  openedAt: '2026-09-26T11:00:00Z', closedAt: '2026-09-26T21:00:00Z', valorAbertura: 50,
  payments: { dinheiro: 47, cartao: 10, pix: 18, fiado: 0, outros: 0 }, totalVendas: 75, numPedidos: 4,
  porTipo: [{ tipo: 'COUNTER', count: 2, total: 43 }, { tipo: 'WAITER', count: 1, total: 22 }],
  suprimentos: [{ motivo: 'Troco', valor: 10 }], sangrias: [{ motivo: 'Banco', valor: 5 }],
  totalSuprimentos: 10, totalSangrias: 5, saldoEsperado: 102, valorFechamento: 100, diferenca: -2,
  ...over,
})

const comDescontos = (lista, omitidos = 0) => ({
  total: 7,
  manual: { total: 5, pedidos: 1 },
  cupom: { total: 2, pedidos: 1, codigos: [{ codigo: 'QATESTE10', usos: 1, total: 2 }] },
  conferencia: { bruto: 70, descontos: 7, taxaServico: 2, cobrado: 65 },
  pedidos: lista, pedidosOmitidos: omitidos,
})

// Texto visível: tira as sequências ESC/POS do template e o que sobrar de controle.
const visivel = (buf) => buf.toString('latin1')
  .replace(/\x1b[@2]/g, '')
  .replace(/\x1b[Et!a\-3]./g, '')
  .replace(/\x1d[B!]./g, '')
  .replace(/\x1dV[\s\S]{1,2}/g, '')
  .replace(/[\x00-\x09\x0b-\x1f]/g, '')
const conta = (buf, seq) => { let n = 0; for (let i = buf.indexOf(seq); i >= 0; i = buf.indexOf(seq, i + 1)) n++; return n }

test('snapshot 80mm com descontos (manual, cupom com código, conferência)', () => {
  const texto = visivel(buildReceiptBuffer(base({ descontos: comDescontos(pedidos(3)) }), 48))
  if (process.env.UPDATE_SNAPSHOT === '1' || !fs.existsSync(SNAP)) {
    fs.mkdirSync(path.dirname(SNAP), { recursive: true })
    fs.writeFileSync(SNAP, texto)
  }
  // O checkout pode trazer o fixture com CRLF (core.autocrlf).
  assert.strictEqual(texto, fs.readFileSync(SNAP, 'latin1').replace(/\r\n/g, '\n'))
  for (const trecho of ['FECHAMENTO DE CAIXA', 'VENDAS POR ATENDIMENTO', 'Balcao (2):', 'DESCONTOS DA SESSAO',
    'QATESTE10 x1', '(=) Cobrado:', 'SALDO ESPERADO:', 'Valor contado:', 'DIFERENCA:', 'Troco', 'Banco']) {
    assert.ok(texto.includes(trecho), trecho)
  }
})

test('sem desconto: o bloco some e o resto sai igual', () => {
  const sem = visivel(buildReceiptBuffer(base(), 48))
  const zerado = visivel(buildReceiptBuffer(base({ descontos: { total: 0, pedidos: [] } }), 48))
  assert.ok(!sem.includes('DESCONTOS DA SESSAO'))
  assert.strictEqual(sem, zerado)
  assert.ok(sem.includes('SALDO ESPERADO:'))
})

test('35 pedidos com desconto: imprime 30 e "e mais 5" (também quando o backend já cortou)', () => {
  const t1 = visivel(buildReceiptBuffer(base({ descontos: comDescontos(pedidos(35)) }), 48))
  assert.strictEqual((t1.match(/^#\d+ /gm) || []).length, 30)
  assert.ok(t1.includes('... e mais 5 pedidos'))
  const t2 = visivel(buildReceiptBuffer(base({ descontos: comDescontos(pedidos(30), 5) }), 48))
  assert.strictEqual((t2.match(/^#\d+ /gm) || []).length, 30)
  assert.ok(t2.includes('... e mais 5 pedidos'))
})

test('caractere de controle em nome/cupom/canal/motivo sai limpo (nenhum comando extra)', () => {
  const limpo = buildReceiptBuffer(base({ descontos: comDescontos(pedidos(2)) }), 48)
  const sujaLista = pedidos(2).map((p) => ({ ...p, canal: 'Mesa\x1b@1', operador: 'A\x1dV\x00na', cupomCodigo: p.cupomCodigo && 'QATESTE\x1b\x6410' }))
  const sujo = buildReceiptBuffer(base({
    tenantName: 'Pizzaria\x1b@ Teste', operator: 'Jun\x1dV\x01ior',
    suprimentos: [{ motivo: 'Tro\x1bEco', valor: 10 }], sangrias: [{ motivo: 'Ban\x07co', valor: 5 }],
    porTipo: [{ tipo: 'X\x1b!\x30Y', count: 1, total: 1 }],
    descontos: { ...comDescontos(sujaLista), cupom: { total: 2, pedidos: 1, codigos: [{ codigo: 'QA\x1b@10', usos: 1, total: 2 }] } },
  }), 48)
  // Mesmo número de ESC/GS que o cupom limpo com as MESMAS seções → nada do usuário virou comando.
  const semTipoExtra = buildReceiptBuffer(base({ porTipo: [{ tipo: 'X Y', count: 1, total: 1 }], descontos: comDescontos(pedidos(2)) }), 48)
  assert.strictEqual(conta(sujo, Buffer.from([0x1b])), conta(semTipoExtra, Buffer.from([0x1b])))
  assert.strictEqual(conta(sujo, Buffer.from([0x1d])), conta(semTipoExtra, Buffer.from([0x1d])))
  assert.strictEqual(conta(sujo, CUT), 1)
  assert.ok(conta(limpo, Buffer.from([0x1b])) > 0)
  const t = visivel(sujo)
  for (const trecho of ['Pizzaria @ Teste', 'Jun V ior', 'Tro Eco', 'Ban co', 'A V na', 'Mesa @1', 'QA @10']) assert.ok(t.includes(trecho), trecho)
})

test('corte: 1 corte no fim por padrão; noCut não corta', () => {
  assert.strictEqual(conta(buildReceiptBuffer(base(), 48), CUT), 1)
  assert.strictEqual(conta(buildReceiptBuffer(base({ _receiptOpts: { noCut: true } }), 48), CUT), 0)
})

test('58mm (32 colunas): nenhuma linha passa da largura, nem com texto longo', () => {
  const longo = 'Nome muito comprido de operador para caber'
  const lista = pedidos(3).map((p) => ({ ...p, canal: 'Mesa da varanda do fundo 12', operador: longo, cupomCodigo: 'CUPOMLONGO2026XYZABC' }))
  const t = visivel(buildReceiptBuffer(base({
    tenantName: 'Restaurante e Pizzaria do Centro Histórico', operator: longo,
    payments: { dinheiro: 123456.78, cartao: 0, pix: 0 }, totalVendas: 123456.78,
    suprimentos: [{ motivo: longo, valor: 1000 }], sangrias: [{ motivo: longo, valor: 1000 }],
    porTipo: [{ tipo: 'DELIVERY', count: 1234, total: 99999.99 }],
    descontos: { ...comDescontos(lista), cupom: { total: 2, pedidos: 1, codigos: [{ codigo: 'CUPOMLONGO2026XYZABC', usos: 99, total: 2 }] } },
  }), 32))
  const longas = t.split('\n').filter((l) => l.length > 32)
  assert.deepStrictEqual(longas, [])
})

test('alias fechamento-caixa usa o mesmo template', () => {
  const a = visivel(buildReceiptBuffer(base(), 48))
  const b = visivel(buildReceiptBuffer(base({ type: 'fechamento-caixa' }), 48))
  assert.strictEqual(a, b)
})
