'use strict'
// Diagnóstico do cabeçalho da Daruma (sem dado real no repositório: o tenant vem
// da config do app instalado). Usado por scripts/teste-daruma.js e pelo botão
// "Imprimir teste Daruma" do app. Só monta bytes — quem envia é o chamador.

// Pedido de delivery fictício (mesmo formato do test/fixtures/cupons-snapshot.js,
// que não vai no instalador).
const DELIVERY = {
  type: 'delivery', serviceType: 'DELIVERY', type_: 'DELIVERY',
  cabecalhoVia: { canal: 'DELIVERY', destino: 'DELIVERY - CLIENTE TESTE', tipo: 'DELIVERY', cliente: 'Cliente Teste', mesa: null },
  paymentStatus: 'Pendente', paymentMethod: 'Dinheiro', formaPagamento: 'dinheiro',
  customer: { name: 'Cliente Teste', phone: '88999990000' }, customer_name: 'Cliente Teste',
  deliveryAddress: { street: 'Rua Teste', number: '10', neighborhood: 'Centro', city: 'Cidade', reference: 'Perto da praça' },
  items: [
    { name: 'Porcao de Queijo Coalho', qty: 1, unitPrice: 32, subtotal: 32, addons: [], addonsDetail: [] },
    { name: 'Refrigerante Lata', qty: 2, unitPrice: 6, subtotal: 12, addons: ['Gelo e limão'], addonsDetail: [{ name: 'Gelo e limão', qty: 1, price: 0 }] },
  ],
  subtotal: 44, deliveryFee: 5, taxaEntrega: 5, total: 49, needsChange: true, trocoPara: 100,
  entregador: 'Joao', previsaoEntrega: '40 a 50 minutos',
}

const RESET_DARUMA = Buffer.from([0x1b, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x2d, 0x00])
const CORTE = Buffer.concat([Buffer.from('\n'.repeat(6)), Buffer.from([0x1d, 0x56, 0x01, 0x1b, 0x6d])])
const rotulo = (s) => Buffer.concat([RESET_DARUMA, Buffer.from('^^^ ' + s + '\n', 'latin1')])
const ateData = (c) => c.subarray(0, c.indexOf('\n', c.indexOf(Buffer.from('/20'))) + 1)

// Tenant como o app imprime: campos da config local por cima (main.js _tenantEnrich).
function tenantDaConfig(cfg = {}, extra = {}) {
  return {
    tenantName: cfg.tenantName || extra.tenantName || 'ESTABELECIMENTO',
    tenantAddress: cfg.tenantAddress || extra.tenantAddress || null,
    tenantPhone: cfg.tenantPhone || extra.tenantPhone || null,
    tenantCnpj: cfg.tenantCnpj || extra.tenantCnpj || null,
    tenantNumber: extra.tenantNumber ?? null,
    tenantNeighborhood: extra.tenantNeighborhood ?? null,
    tenantCity: extra.tenantCity ?? null,
    tenantState: extra.tenantState ?? null,
    _logoSource: cfg.logoPath || null,
    _logoEnabled: cfg.logoEnabled === true,
  }
}

// Pedido de delivery (fixture) com o tenant dado; agora como horário do pedido.
function pedidoDelivery(tenant, codigo = 'D258', agora = new Date().toISOString()) {
  return {
    ...DELIVERY, ...tenant, orderCode: codigo, code: codigo, _printType: 'kitchen',
    cabecalhoVia: { ...DELIVERY.cabecalhoVia, numero: codigo, criadoEm: agora },
    createdAt: agora, created_at: agora, printedAt: agora,
  }
}

function semAcentoTenant(t, semAcento) {
  const o = { ...t }
  for (const k of Object.keys(o)) if (/^tenant/.test(k) && typeof o[k] === 'string') o[k] = semAcento(o[k])
  return o
}

/**
 * Bytes dos testes E/F/G/H no perfil Daruma (perfil ativo já setado pelo chamador).
 *   E: cabeçalho Daruma com o tenant real (acentos)    F: E sem acento
 *   G: [via cozinha, via cliente] reais completas      H: via cliente real sozinha
 */
function montarTestes(printer, tenant, cols = 48) {
  const log = console.log; console.log = () => {}
  try {
    const real = printer.buildReceiptBuffer(pedidoDelivery(tenant), cols, { familia: 'daruma' })
    const ascii = printer.buildReceiptBuffer(pedidoDelivery(semAcentoTenant(tenant, printer.semAcento)), cols, { familia: 'daruma' })
    return {
      E: Buffer.concat([ateData(real.client), rotulo('TESTE E - DARUMA dados reais'), CORTE]),
      F: Buffer.concat([ateData(ascii.client), rotulo('TESTE F - DARUMA dados reais sem acento'), CORTE]),
      G: [real.kitchen, Buffer.concat([real.client.subarray(0, real.client.length - CORTE.length), rotulo('TESTE G - via cliente apos a cozinha'), CORTE])],
      H: Buffer.concat([real.client.subarray(0, real.client.length - CORTE.length), rotulo('TESTE H - via cliente sozinha'), CORTE]),
    }
  } finally { console.log = log }
}

module.exports = { RESET_DARUMA, CORTE, rotulo, ateData, tenantDaConfig, pedidoDelivery, semAcentoTenant, montarTestes }
