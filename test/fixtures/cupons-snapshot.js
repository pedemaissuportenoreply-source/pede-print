'use strict'
// Payloads fixos p/ o snapshot de bytes do perfil Genérico (saída de hoje) e p/
// os testes do perfil Daruma. Datas fixas; TZ setado pelo teste.
const CRIADO = '2026-10-12T21:30:00Z'
const IMPRESSO = '2026-10-12T21:31:00Z'
const URL_QR = 'https://app.pedeplus.com.br/motoboy/q/AbCdEfGhIjKlMnOpQrStUv'

const itens = [
  { name: 'Porcao de Queijo Coalho', qty: 1, unitPrice: 32, subtotal: 32, addons: [], addonsDetail: [] },
  { name: 'Refrigerante Lata', qty: 2, unitPrice: 6, subtotal: 12, addons: ['Gelo e limão'], addonsDetail: [{ name: 'Gelo e limão', qty: 1, price: 0 }] },
]

const cabecalhoVia = { numero: 'D249', canal: 'DELIVERY', destino: 'DELIVERY - CLIENTE TESTE', tipo: 'DELIVERY', cliente: 'Cliente Teste', mesa: null, criadoEm: CRIADO }

const delivery = {
  type: 'delivery', tenantName: 'Pede Restaurante', tenantAddress: 'Rua A, 10', tenantPhone: '88999990000',
  orderCode: 'D249', code: 'D249', serviceType: 'DELIVERY', type_: 'DELIVERY', cabecalhoVia,
  deliveryCode: 'DLV-698181', paymentStatus: 'Pendente', paymentMethod: 'Dinheiro', formaPagamento: 'dinheiro',
  customer: { name: 'Cliente Teste', phone: '88981308321' }, customer_name: 'Cliente Teste',
  deliveryAddress: { street: 'Rua Smoke', number: '10', neighborhood: 'Sitio Bode', city: 'Jaguaribe', reference: 'Perto da praça' },
  items: itens, subtotal: 44, deliveryFee: 5, taxaEntrega: 5, total: 49,
  needsChange: true, trocoPara: 100,
  entregador: 'Joao', previsaoEntrega: '40 a 50 minutos (entrega estimada pela loja hoje)',
  qrEntrega: { url: URL_QR, rotulo: 'Motoboy: escaneie pra iniciar' },
  createdAt: CRIADO, created_at: CRIADO, printedAt: IMPRESSO,
}

const cozinha = {
  type: 'kitchen', _kitchenOnly: true, orderCode: 'G101', code: 'G101', serviceType: 'MESA', table: '5',
  cabecalhoVia: { numero: 'G101', canal: 'MESA', destino: 'MESA 5', tipo: 'MESA', cliente: 'Ana', mesa: 5, criadoEm: CRIADO },
  items: [{ nome: 'Arroz à grega', quantity: 1, adicionais: [{ nome: 'Macarrão' }], observacao: 'sem cebola' }],
  createdAt: CRIADO, printedAt: IMPRESSO,
}

const bar = {
  ...cozinha, setor: 'BAR', _bar: true, viaTitulo: 'VIA BAR',
  items: [{ nome: 'Caipirinha de limão', quantity: 2, adicionais: ['Açúcar'] }],
}

const pagamentoDividido = {
  type: 'payment', _printType: 'receipt', tenantName: 'Pede Restaurante', orderCode: 'G300', serviceType: 'MESA', table: '7',
  paymentMethod: 'Dividido', items: itens, subtotal: 44, total: 48.4, taxaServico: 4.4, taxaServicoPercent: 10,
  splitPayments: [{ label: 'Pessoa 1', amount: 24.2, paymentMethod: 'pix' }, { label: 'Pessoa 2', amount: 24.2, paymentMethod: 'dinheiro' }],
  splitRows: [{ label: 'Pessoa 1', amount: 24.2, paymentMethod: 'pix' }, { label: 'Pessoa 2', amount: 24.2, paymentMethod: 'dinheiro' }],
  createdAt: CRIADO, printedAt: IMPRESSO,
}

module.exports = { delivery, cozinha, bar, pagamentoDividido, URL_QR }
