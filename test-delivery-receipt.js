'use strict'

// Teste offline do cupom de DELIVERY (Daruma DR800): gera os bytes completos e
// valida o layout SOMENTE-TEXTO da via cliente:
//   1. via cozinha e via cliente sao buffers SEPARADOS (cada cupom fisico e um
//      stream contiguo proprio — o corte de um nunca cai no meio do outro)
//   2. cada via inicia com ESC @ + ESC t 3 (1b 40 1b 74 03)
//   3. "ESTABELECIMENTO" intacto + endereco/telefone/CNPJ no cabecalho
//   4. exatamente UM corte por via, no FIM, depois do rodape + 4 LFs de feed
//   5. nenhum raster (GS v 0 / GS ( k) nem linha "Escaneie..."
//   6. ordem: estabelecimento -> PEDIDO # -> ENTREGA -> CLIENTE -> ENDERECO ->
//      ITENS -> totais -> pagamento
//   7. nao-regressao: comprovante de pagamento (valorRecebido/troco/PAGAMENTO
//      DIVIDIDO) com um unico corte no fim
// Roda com: node test-delivery-receipt.js

const assert = require('assert')
const { buildReceiptBuffer, setPrintParams, setActiveProfile } = require('./printer')
const { EMBEDDED_SEED, toRuntime } = require('./printer-profiles')

// Perfil ativo = Epson TM-T20 (cp860 / ESC t 3 / corte GS V B 0) — device VERIFICADO
// (matriz de codepage rodou nele); par de codepage com acentos PT-BR corretos.
setActiveProfile(toRuntime(EMBEDDED_SEED.find((p) => p.name === 'Epson TM-T20')))
setPrintParams({ encoding: 'cp860', codepage: 3 }) // Epson TM-T20 (verificado): cp860 / ESC t 3

// Localiza todos os comandos de corte: GS V (1d 56 ..), ESC i (1b 69), ESC m (1b 6d).
function findCuts(buf) {
  const cuts = []
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x56) cuts.push(i)
    if (buf[i] === 0x1b && (buf[i + 1] === 0x69 || buf[i + 1] === 0x6d)) cuts.push(i)
  }
  return cuts
}

// Valida: UM corte, ultimo comando do buffer (1d 56 42 00), precedido de 4 LFs.
function assertSingleCutAtEnd(buf, label) {
  const cuts = findCuts(buf)
  assert.strictEqual(cuts.length, 1, `${label}: deve ter exatamente UM corte (achou ${cuts.length} em ${cuts.join(',')})`)
  assert.strictEqual(cuts[0], buf.length - 4, `${label}: corte deve ser os 4 ultimos bytes`)
  assert.deepStrictEqual([...buf.subarray(buf.length - 4)], [0x1d, 0x56, 0x42, 0x00], `${label}: corte deve ser GS V B 0`)
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
    // Complementos: um PAGO (preco > 0 -> valor alinhado a direita) e um GRATIS
    // (preco 0 -> so "+ 1x Nome"). O total do pedido nao muda: o preco do
    // adicional ja esta embutido no preco unitario do item.
    { qty: 2, name: 'X-Burguer Especial', preco: 25, subtotal: 50, observacao: null,
      adicionais: [
        { nome: 'Extra queijo', quantidade: 1, preco: 3.5 },
        { nome: 'Sem cebola',   quantidade: 1, preco: 0 },
      ] },
  ],
}

// 1) Vias separadas: cozinha e cliente sao buffers independentes.
const job = buildReceiptBuffer(delivery, 48)
assert(job && job.jobs === true && Buffer.isBuffer(job.kitchen) && Buffer.isBuffer(job.client),
  'delivery deve gerar vias cozinha e cliente como buffers SEPARADOS')

const client = job.client
const text = client.toString('latin1')

// 2) Init: ESC @ + ESC t 7 sao os PRIMEIROS bytes de cada via.
assert.deepStrictEqual([...client.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 0x03], 'via cliente deve iniciar com 1b 40 1b 74 03')
assert.deepStrictEqual([...job.kitchen.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 0x03], 'via cozinha deve iniciar com 1b 40 1b 74 03')

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
  ['ITENS',                 at('ITENS')],
  ['TOTAL:',                at('TOTAL:')],
  ['A PAGAR NA ENTREGA',    at('A PAGAR NA ENTREGA')],
]
for (let i = 0; i < order.length; i++) {
  assert(order[i][1] !== -1, `secao "${order[i][0]}" deve existir na via cliente`)
  if (i > 0) assert(order[i - 1][1] < order[i][1], `"${order[i - 1][0]}" deve vir antes de "${order[i][0]}"`)
}
// Complementos: pago mostra o valor alinhado a direita (48 cols); gratis, nada.
const addonPaid = text.split('\n').find((l) => l.includes('+ Extra queijo'))
const addonFree = text.split('\n').find((l) => l.includes('+ Sem cebola'))
assert(addonPaid && addonPaid.includes('+R$ 3,50'), 'complemento pago deve exibir "+R$ 3,50"')
assert.strictEqual(addonPaid.replace(/\r/g, '').length, 48, 'linha do complemento pago deve ocupar as 48 colunas (valor a direita)')
assert(addonFree && !addonFree.includes('R$'), 'complemento gratis nao pode exibir valor')
assert(text.includes('R$ 50,00'), 'subtotal do item nao pode mudar com a exibicao dos complementos')

assert(text.includes('TROCO PARA'), 'cupom delivery dinheiro deve mostrar troco no bloco de pagamento')
// Bloco de pagamento = emoldurado ("===" + bold centrado), NUNCA reverso: a via
// cliente inteira nao pode conter GS B (1d 42), nem no bloco do codigo da entrega.
assert.strictEqual(client.indexOf(Buffer.from([0x1d, 0x42])), -1, 'via cliente NAO pode usar modo reverso (GS B)')
assert(text.includes('A PAGAR NA ENTREGA') && text.includes('FORMA: DINHEIRO'), 'bloco emoldurado deve conter status + forma')

// Bloco destacado do codigo da entrega (o motoboy digita estes digitos no app).
// Sai no fim do slip, antes do rodape, e nao introduz corte/raster extra.
assert(text.includes('CODIGO DA ENTREGA'), 'slip deve ter o bloco CODIGO DA ENTREGA')
assert(text.includes('Informe ao entregador'), 'bloco do codigo deve instruir o balcao')
assert(text.indexOf('CODIGO DA ENTREGA') < footerAt, 'bloco do codigo vem antes do rodape')

// Fallback camelCase: payload do recibo usa deliveryCode (sem snake_case).
const camel = buildReceiptBuffer({ ...delivery, delivery_code: undefined, deliveryCode: 'DLV-123456', _customerOnly: true }, 48)
const camelText = camel.toString('latin1')
assert(camelText.includes('CODIGO DA ENTREGA'), 'codigo deve sair tambem com payload camelCase (deliveryCode)')
assert(camelText.includes('1 2 3 4 5 6'), 'os 6 digitos devem sair espacados no bloco destacado')
assertSingleCutAtEnd(camel, 'slip camelCase')

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
assert.deepStrictEqual([...payment.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 0x03], 'comprovante deve iniciar com 1b 40 1b 74 03')
assertSingleCutAtEnd(payment, 'comprovante de pagamento')
const payText = payment.toString('latin1')
assert(payText.includes('COMPROVANTE DE PAGAMENTO'), 'titulo do comprovante')
assert(payText.includes('Valor Recebido'), 'valorRecebido deve continuar no comprovante dinheiro')
assert(payText.includes('Troco'), 'troco deve continuar no comprovante dinheiro')
assert(payText.includes('PAGAMENTO DIVIDIDO'), 'PAGAMENTO DIVIDIDO deve continuar no comprovante')
assert(payText.includes('Pessoa 1') && payText.includes('Pessoa 2'), 'linhas do split devem continuar')

console.log('\nOK — todos os asserts passaram:')
console.log('  [1] vias cozinha/cliente em buffers separados (corte de uma nunca corta a outra)')
console.log('  [2] cada via inicia com 1b 40 1b 74 03')
console.log('  [3] ESTABELECIMENTO/endereco/telefone/CNPJ intactos no cabecalho')
console.log('  [4] exatamente UM corte por via, no fim, apos rodape + 4 LFs')
console.log('  [5] nenhum raster (GS v 0 / GS ( k), sem "Escaneie..."')
console.log('  [6] ordem: estabelecimento -> PEDIDO -> ENTREGA -> CLIENTE -> ENDERECO -> ITENS -> totais -> pagamento')
console.log('  [7] comprovante: valorRecebido/troco/PAGAMENTO DIVIDIDO + corte unico no fim')
