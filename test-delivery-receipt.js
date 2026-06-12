'use strict'

// Teste offline do cupom de DELIVERY (Daruma DR800): gera os bytes completos e
// valida o layout SOMENTE-TEXTO da via cliente:
//   1. via cozinha e via cliente sao buffers SEPARADOS (cada cupom fisico e um
//      stream contiguo proprio — o corte de um nunca cai no meio do outro)
//   2. cada via inicia com ESC @ + ESC t 7 (1b 40 1b 74 07)
//   3. "ESTABELECIMENTO" intacto + endereco/telefone/CNPJ no cabecalho
//   4. exatamente UM corte por via, no FIM, depois do rodape + 4 LFs de feed
//   5. nenhum raster (GS v 0 / GS ( k) nem linha "Escaneie..."
//   6. ordem: estabelecimento -> PEDIDO # -> ENTREGA -> CLIENTE -> ENDERECO ->
//      ITENS -> totais -> pagamento
//   7. nao-regressao: comprovante de pagamento (valorRecebido/troco/PAGAMENTO
//      DIVIDIDO) com um unico corte no fim
// Roda com: node test-delivery-receipt.js

const assert = require('assert')
const { buildReceiptBuffer, setPrintParams } = require('./printer')

setPrintParams({}) // defaults Daruma: cp1252 / ESC t 7

// Localiza todos os comandos de corte: GS V (1d 56 ..), ESC i (1b 69), ESC m (1b 6d).
function findCuts(buf) {
  const cuts = []
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x56) cuts.push(i)
    if (buf[i] === 0x1b && (buf[i + 1] === 0x69 || buf[i + 1] === 0x6d)) cuts.push(i)
  }
  return cuts
}

// Valida: UM corte, ultimo comando do buffer (1d 56 41 00), precedido de 4 LFs.
function assertSingleCutAtEnd(buf, label) {
  const cuts = findCuts(buf)
  assert.strictEqual(cuts.length, 1, `${label}: deve ter exatamente UM corte (achou ${cuts.length} em ${cuts.join(',')})`)
  assert.strictEqual(cuts[0], buf.length - 4, `${label}: corte deve ser os 4 ultimos bytes`)
  assert.deepStrictEqual([...buf.subarray(buf.length - 4)], [0x1d, 0x56, 0x41, 0x00], `${label}: corte deve ser GS V A 0`)
  assert.deepStrictEqual([...buf.subarray(buf.length - 8, buf.length - 4)], [0x0a, 0x0a, 0x0a, 0x0a], `${label}: corte deve ser precedido de 4 LFs de feed`)
}

// ── Cupom de delivery (via cozinha + via cliente, texto puro) ─────────────────
const delivery = {
  type: 'DELIVERY',
  status: 'SENT',
  _printType: 'kitchen',
  tenantName: 'ESTABELECIMENTO TESTE',
  tenantAddress: 'Rua das Flores',
  tenantNumber: '123',
  tenantNeighborhood: 'Centro',
  tenantCity: 'Sao Paulo',
  tenantState: 'SP',
  tenantPhone: '(11) 99999-9999',
  tenantCnpj: '12.345.678/0001-90',
  orderCode: 'DLV-42',
  delivery_code: 'AB12',
  customer_name: 'Cliente Teste',
  customer_phone: '11988887777',
  deliveryAddress: { street: 'Av. Brasil', number: '1000', neighborhood: 'Jardim', city: 'Sao Paulo' },
  reviewUrl: 'https://demo.pedeplus.com.br/p/pedido/tok123', // segue no payload, mas NAO imprime
  formaPagamento: 'dinheiro',
  needsChange: true,
  trocoPara: 100,
  taxaEntrega: 8,
  total: 58,
  created_at: new Date().toISOString(),
  items: [
    { qty: 2, name: 'X-Burguer Especial', preco: 25, subtotal: 50, adicionais: [], observacao: null },
  ],
}

// 1) Vias separadas: cozinha e cliente sao buffers independentes.
const job = buildReceiptBuffer(delivery, 48)
assert(job && job.jobs === true && Buffer.isBuffer(job.kitchen) && Buffer.isBuffer(job.client),
  'delivery deve gerar vias cozinha e cliente como buffers SEPARADOS')

const client = job.client
const text = client.toString('latin1')

// 2) Init: ESC @ + ESC t 7 sao os PRIMEIROS bytes de cada via.
assert.deepStrictEqual([...client.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 0x07], 'via cliente deve iniciar com 1b 40 1b 74 07')
assert.deepStrictEqual([...job.kitchen.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 0x07], 'via cozinha deve iniciar com 1b 40 1b 74 07')

// 3) Cabecalho do estabelecimento intacto — toda ocorrencia de "STABELECIMENTO"
// precisa do "E" inicial (regressao: primeiro byte consumido como parametro).
let idx = -1
while ((idx = text.indexOf('STABELECIMENTO', idx + 1)) !== -1) {
  assert.strictEqual(text[idx - 1], 'E', `"STABELECIMENTO" sem o E inicial no offset ${idx}`)
}
assert(text.includes('ESTABELECIMENTO TESTE'), 'nome do estabelecimento deve estar na via cliente')
assert(text.includes('Rua das Flores, 123 - Centro'), 'endereco do estabelecimento deve estar na via cliente')
assert(text.includes('Sao Paulo/SP'), 'cidade/UF do estabelecimento deve estar na via cliente')
assert(text.includes('Tel: (11) 99999-9999'), 'telefone do estabelecimento deve estar na via cliente')
assert(text.includes('CNPJ: 12.345.678/0001-90'), 'CNPJ do estabelecimento deve estar na via cliente')

// 4) Exatamente UM corte por via, no fim, apos o rodape + feed.
assertSingleCutAtEnd(client, 'via cliente')
assertSingleCutAtEnd(job.kitchen, 'via cozinha')
const footerAt = text.indexOf('Obrigado pela preferencia')
assert(footerAt !== -1, 'rodape da via cliente deve existir')
assert(findCuts(client)[0] > footerAt, 'corte da via cliente deve vir DEPOIS do rodape')
assert(job.kitchen.toString('latin1').includes('CONFIRA OS ITENS'), 'rodape da via cozinha deve existir')
assert(findCuts(job.kitchen)[0] > job.kitchen.toString('latin1').indexOf('CONFIRA OS ITENS'), 'corte da cozinha deve vir DEPOIS do rodape')

// Nenhum corte no meio do cabecalho: nao ha corte antes do "Tel:" na via cliente.
assert(findCuts(client)[0] > text.indexOf('Tel: (11)'), 'nenhum corte antes do Tel: do estabelecimento')

// 5) NENHUM raster/QR em nenhuma via.
for (const [name, b] of [['cliente', client], ['cozinha', job.kitchen]]) {
  assert.strictEqual(b.indexOf(Buffer.from([0x1d, 0x76, 0x30])), -1, `via ${name} NAO pode conter raster GS v 0`)
  assert.strictEqual(b.indexOf(Buffer.from([0x1d, 0x28, 0x6b])), -1, `via ${name} NAO pode conter QR nativo GS ( k`)
}
assert(!text.includes('Escaneie'), 'linha "Escaneie para acompanhar..." nao pode voltar')

// 6) Ordem da via cliente: estabelecimento -> PEDIDO # -> ENTREGA -> CLIENTE ->
// ENDERECO -> ITENS -> TOTAL -> pagamento.
const at = (s) => text.indexOf(s)
const order = [
  ['ESTABELECIMENTO TESTE', at('ESTABELECIMENTO TESTE')],
  ['PEDIDO #DLV-42',        at('PEDIDO #DLV-42')],
  ['ENTREGA AB12',          at('ENTREGA AB12')],
  ['CLIENTE',               at('CLIENTE\n')],
  ['ENDERECO DE ENTREGA',   at('ENDERECO DE ENTREGA')],
  ['ITENS',                 at('ITENS\n')],
  ['TOTAL:',                at('TOTAL:')],
  ['A PAGAR NA ENTREGA',    at('A PAGAR NA ENTREGA')],
]
for (let i = 0; i < order.length; i++) {
  assert(order[i][1] !== -1, `secao "${order[i][0]}" deve existir na via cliente`)
  if (i > 0) assert(order[i - 1][1] < order[i][1], `"${order[i - 1][0]}" deve vir antes de "${order[i][0]}"`)
}
assert(text.includes('Troco para'), 'cupom delivery dinheiro deve mostrar troco')

// Reimpressao (so via cliente): buffer unico, um corte no fim.
const reprint = buildReceiptBuffer({ ...delivery, _customerOnly: true }, 48)
assert(Buffer.isBuffer(reprint), 'reimpressao deve ser Buffer unico')
assertSingleCutAtEnd(reprint, 'reimpressao via cliente')

// ── 7) Nao-regressao: comprovante de pagamento (dinheiro + dividido) ──────────
const payment = buildReceiptBuffer({
  type: 'payment',
  tenantName: 'ESTABELECIMENTO TESTE',
  orderCode: '77',
  serviceType: 'MESA',
  formaPagamento: 'dinheiro',
  total: 90,
  valorRecebido: 100,
  troco: 10,
  splitPayments: [
    { label: 'Pessoa 1', amount: 45, paymentMethod: 'Pix' },
    { label: 'Pessoa 2', amount: 45, paymentMethod: 'Dinheiro' },
  ],
  items: [{ qty: 1, name: 'Pizza Grande', preco: 90, subtotal: 90 }],
}, 48)
assert(Buffer.isBuffer(payment), 'comprovante de pagamento deve continuar sendo Buffer unico')
assert.deepStrictEqual([...payment.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 0x07], 'comprovante deve iniciar com 1b 40 1b 74 07')
assertSingleCutAtEnd(payment, 'comprovante de pagamento')
const payText = payment.toString('latin1')
assert(payText.includes('COMPROVANTE DE PAGAMENTO'), 'titulo do comprovante')
assert(payText.includes('Valor Recebido'), 'valorRecebido deve continuar no comprovante dinheiro')
assert(payText.includes('Troco'), 'troco deve continuar no comprovante dinheiro')
assert(payText.includes('PAGAMENTO DIVIDIDO'), 'PAGAMENTO DIVIDIDO deve continuar no comprovante')
assert(payText.includes('Pessoa 1') && payText.includes('Pessoa 2'), 'linhas do split devem continuar')

console.log('\nOK — todos os asserts passaram:')
console.log('  [1] vias cozinha/cliente em buffers separados (corte de uma nunca corta a outra)')
console.log('  [2] cada via inicia com 1b 40 1b 74 07')
console.log('  [3] ESTABELECIMENTO/endereco/telefone/CNPJ intactos no cabecalho')
console.log('  [4] exatamente UM corte por via, no fim, apos rodape + 4 LFs')
console.log('  [5] nenhum raster (GS v 0 / GS ( k), sem "Escaneie..."')
console.log('  [6] ordem: estabelecimento -> PEDIDO -> ENTREGA -> CLIENTE -> ENDERECO -> ITENS -> totais -> pagamento')
console.log('  [7] comprovante: valorRecebido/troco/PAGAMENTO DIVIDIDO + corte unico no fim')
