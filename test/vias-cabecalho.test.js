'use strict'
// Vias de PREPARO (cozinha e bar): cabeçalho único a partir do pedido — nunca do
// `type` do template ('kitchen') e sem cair em MESA — e texto em ASCII sem cortar
// palavra por causa de acento ("+ Macarrão" saía "+ Macarr").
process.env.TZ = 'America/Fortaleza'
const test = require('node:test')
const assert = require('node:assert')
const { buildReceiptBuffer, semAcento, cabecalhoDaVia } = require('../printer')

const visivel = (buf) => buf.toString('latin1')
  .replace(/\x1b[@2]/g, '')
  .replace(/\x1b[Et!a\-3]./g, '')
  .replace(/\x1d[B!]./g, '')
  .replace(/\x1dV[\s\S]{1,2}/g, '')
  .replace(/[\x00-\x09\x0b-\x1f]/g, '')

const CRIADO = '2026-09-29T19:17:00Z' // 16:17 em Fortaleza

const itensCozinha = [{ nome: 'Arroz à grega', quantity: 1, adicionais: [{ nome: 'Macarrão' }], observacao: 'sem cebola' }]
const itensBar = [{ nome: 'Caipirinha de limão', quantity: 2, adicionais: ['Açúcar'] }]

// Cabeçalho como o backend manda (src/print/cabecalho-via.ts).
const CABECALHOS = {
  MESA: { numero: 'G101', canal: 'MESA', destino: 'MESA 5', tipo: 'MESA', cliente: 'Ana', mesa: 5, criadoEm: CRIADO },
  COMANDA: { numero: 'B200', canal: 'COMANDA', destino: 'COMANDA 12', tipo: 'COMANDA', cliente: null, mesa: null, criadoEm: CRIADO },
  BALCAO: { numero: 'B201', canal: 'BALCAO', destino: 'BALCÃO', tipo: 'BALCÃO', cliente: 'João', mesa: null, criadoEm: CRIADO },
  DELIVERY: { numero: 'D014', canal: 'DELIVERY', destino: 'DELIVERY - CARLOS', tipo: 'DELIVERY', cliente: null, mesa: null, criadoEm: CRIADO },
  RETIRADA: { numero: 'B202', canal: 'RETIRADA', destino: 'RETIRADA - CARLOS', tipo: 'RETIRADA', cliente: null, mesa: null, criadoEm: CRIADO },
}
const TIPO_ORDER = { MESA: 'TABLE', COMANDA: 'COUNTER', BALCAO: 'COUNTER', DELIVERY: 'DELIVERY', RETIRADA: 'COUNTER' }

function vias(canal) {
  const cab = CABECALHOS[canal]
  const base = {
    tenantName: 'Restaurante Teste', code: cab.numero, created_at: CRIADO, customer_name: 'carlos',
    type: TIPO_ORDER[canal], cabecalhoVia: cab, _receiptOpts: {},
  }
  const cozinha = visivel(buildReceiptBuffer({ ...base, setor: 'COZINHA', items: itensCozinha, _kitchenOnly: true }, 48))
  // Via do bar: o `type` do payload é o do template.
  const bar = visivel(buildReceiptBuffer({ ...base, type: 'kitchen', setor: 'BAR', _bar: true, _kitchenOnly: true, viaTitulo: 'VIA BAR', items: itensBar }, 48))
  return { cozinha, bar }
}

for (const canal of Object.keys(CABECALHOS)) {
  test(`${canal}: via cozinha e via bar com o mesmo cabeçalho`, () => {
    const cab = CABECALHOS[canal]
    const destino = semAcento(cab.destino)
    const { cozinha, bar } = vias(canal)
    for (const [nome, t] of [['cozinha', cozinha], ['bar', bar]]) {
      const linhaPedido = t.split('\n').find((l) => l.includes('PEDIDO #'))
      assert.ok(linhaPedido.includes('PEDIDO #' + cab.numero), `${nome}: número`)
      assert.ok(linhaPedido.trimEnd().endsWith(destino), `${nome}: destino "${destino}" em "${linhaPedido}"`)
      assert.match(t, new RegExp('Tipo: ' + semAcento(cab.tipo) + '\\s+Hora: 16:17'), `${nome}: tipo/hora`)
      assert.ok(t.includes('Data: 29/09/2026'), `${nome}: data`)
      if (canal !== 'MESA') assert.ok(!/MESA/.test(linhaPedido) && !/Tipo: MESA/.test(t), `${nome}: nunca MESA`)
      if (cab.cliente) assert.ok(t.includes('Cliente: ' + semAcento(cab.cliente)), `${nome}: cliente`)
      else assert.ok(!t.includes('Cliente:'), `${nome}: sem linha Cliente`)
      assert.ok(/^[\x00-\x7e]*$/.test(t), `${nome}: ASCII puro`)
    }
    assert.ok(bar.includes('VIA BAR') && cozinha.includes('VIA COZINHA'))
  })
}

test('acento transliterado sem cortar a palavra; layout dos itens igual', () => {
  const { cozinha, bar } = vias('DELIVERY')
  assert.ok(cozinha.includes('   + Macarrao\n'), 'adicional inteiro')
  assert.ok(cozinha.includes('[ ] 01X ARROZ A GREGA'), 'item inteiro, com a caixinha de conferência')
  assert.ok(cozinha.includes('   >> sem cebola'), 'observação')
  assert.ok(cozinha.includes('*** CONFIRA OS ITENS ***') && cozinha.includes('Emitido por Pede+'), 'rodapé')
  // Quebra de linha segue a largura (dupla-largura: 16 colunas úteis depois da caixinha).
  assert.ok(bar.includes('[ ] 02X CAIPIRINHA DE\n') && bar.includes('        LIMAO\n') && bar.includes('   + Acucar'))
})

test('transliteração troca letra por letra', () => {
  assert.strictEqual(semAcento('Macarrão à grega, açaí, pão, Ñandú, nº 5'), 'Macarrao a grega, acai, pao, Nandu, no 5')
  assert.strictEqual(semAcento('ÁÉÍÓÚÂÊÔÃÕÇ'), 'AEIOUAEOAOC')
})

test('comprovante continua com acento (só as vias de preparo viram ASCII)', () => {
  const t = buildReceiptBuffer({ type: 'payment', tenantName: 'Restaurante Teste', code: 'G1', items: [{ nome: 'Pão', quantity: 1, preco: 5 }], total: 5 }, 48)
  assert.ok(t.includes(Buffer.from('P')) && !/^[\x00-\x7e]*$/.test(t.toString('latin1')))
})

test('payload antigo (sem cabecalhoVia): canal real, sem fallback pra MESA', () => {
  const d = (over) => ({ orderCode: 'X1', customer: 'carlos', table: null, createdAt: CRIADO, ...over })
  assert.strictEqual(cabecalhoDaVia({ type: 'kitchen', tipo: 'delivery' }, d()).destino, 'DELIVERY - CARLOS')
  assert.strictEqual(cabecalhoDaVia({ type: 'kitchen', tipoAtendimento: 'RETIRADA' }, d()).destino, 'RETIRADA - CARLOS')
  assert.strictEqual(cabecalhoDaVia({ type: 'kitchen', tipo: 'balcao' }, d()).destino, 'BALCAO')
  assert.strictEqual(cabecalhoDaVia({ type: 'kitchen' }, d()).tipo, 'BALCAO')
  assert.strictEqual(cabecalhoDaVia({ type: 'kitchen', modalidade: 'MESA' }, d({ table: '7' })).destino, 'MESA 7')
  assert.strictEqual(cabecalhoDaVia({ type: 'TABLE' }, d({ table: '3', customer: 'Mesa 3' })).cliente, null)
})
