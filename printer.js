'use strict'

// Carregado sob demanda: o binario nativo e compilado p/ a ABI do Electron e
// nao carrega no node puro (testes offline). So e necessario p/ spooler.
let _nodePrinter = null
function nodePrinter() {
  if (!_nodePrinter) _nodePrinter = require('@thiagoelg/node-printer')
  return _nodePrinter
}
const iconv = require('iconv-lite')
const { isComPort, sendToComPort } = require('./src/serial-print')
const { buildLogoBands, sendLogoBands } = require('./src/logo')

// Logo raster na COM (DR800) sai como lixo — desabilitado por padrão. Só liga
// com confirmação explícita: PEDE_LOGO_ALLOW_RASTER=1.
const LOGO_RASTER_ON_COM = process.env.PEDE_LOGO_ALLOW_RASTER === '1'

// ── ESC/POS buffers — ZERO bytes nulos exceto no CUT (último byte do job) ─────
//
// BOLD_OFF  = [0x1b,0x45,0x00] — byte nulo termina a string no driver Windows
// ALIGN_LT  = [0x1b,0x61,0x00] — idem
// EMPH_OFF  = [0x1b,0x21,0x00] — idem
// Solução: usar ESC_INIT ([0x1b,0x40]) como reset universal.
// Não tem byte nulo, repõe: left-align + bold-off + font normal.

const ESC_INIT  = Buffer.from([0x1b, 0x40])          // init / reset universal
const BOLD_ON   = Buffer.from([0x1b, 0x45, 0x01])    // bold on
const BIG_ON    = Buffer.from([0x1b, 0x21, 0x30])    // ESC ! 0x30 — double-height + double-width
const TALL_ON   = Buffer.from([0x1b, 0x21, 0x10])    // ESC ! 0x10 — double-height only
const INVERT_ON = Buffer.from([0x1d, 0x42, 0x01])    // GS B 1 — white-on-black
const INVERT_OFF= Buffer.from([0x1d, 0x42, 0x00])    // GS B 0 — fim invertido
const UNDER_ON  = Buffer.from([0x1b, 0x2d, 0x01])    // ESC - 1 — sublinhado on
const UNDER_OFF = Buffer.from([0x1b, 0x2d, 0x00])    // ESC - 0 — sublinhado off
const CUT       = Buffer.from([0x1d, 0x56, 0x41, 0x00]) // full cut (null só aqui, último byte)

// Daruma DR800: diagnóstico confirmou ESC t 7 + cp1252 (acentos corretos).
// Estes são os DEFAULTS — a config armazenada (electron-store) sobrescreve por
// impressora via setPrintParams({ encoding, codepage }). Env ainda funciona como
// fallback inicial:
//   PEDE_PRINT_ENCODING (default 'cp1252') — iconv.encode(text, encoding)
//   PEDE_PRINT_CODEPAGE (default 7)         — ESC t n no início do cupom
const DEFAULT_ENCODING = (process.env.PEDE_PRINT_ENCODING || 'cp1252').trim()
const DEFAULT_CODEPAGE = (() => {
  const n = parseInt(process.env.PEDE_PRINT_CODEPAGE, 10)
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : 7
})()

// Estado de impressão corrente (mutável por job via setPrintParams).
let ENCODING   = DEFAULT_ENCODING
let CODEPAGE_N = DEFAULT_CODEPAGE
const charset = () => Buffer.from([0x1b, 0x74, CODEPAGE_N]) // ESC t n — code page (acentos da DR800)

// Aplica encoding/codepage da config do tenant; valores ausentes voltam ao default.
function setPrintParams(opts) {
  const enc = opts && typeof opts.encoding === 'string' && opts.encoding.trim()
  ENCODING = enc ? enc.trim() : DEFAULT_ENCODING
  const n = opts ? parseInt(opts.codepage, 10) : NaN
  CODEPAGE_N = Number.isInteger(n) && n >= 0 && n <= 255 ? n : DEFAULT_CODEPAGE
}

// Largura padrão única (80mm = 48 colunas). Todo layout deriva deste valor.
const COLS = 48


// Mínimo de LF para o papel sair do cutter da DR800 antes do corte.
const FEED_CUT = Buffer.from('\n'.repeat(4), 'ascii')

// Texto codificado em CP1252 (não UTF-8) — Daruma DR800 imprime acentos corretos.
function ln(text) { return iconv.encode(String(text) + '\n', ENCODING) }

// ── Formatters ─────────────────────────────────────────────────────────────────

// Mapeia origem/canal técnico para texto amigável (Atendido por).
const ORIGIN_MAP = { QR_CODE: 'QR Code', GARCOM: 'Garcom', BALCAO: 'Balcao', CAIXA: 'Caixa' }
function fmtOrigin(v) {
  const key = String(v ?? '').trim().toUpperCase()
  return ORIGIN_MAP[key] ?? String(v ?? '')
}

function fmtBRL(v) {
  const cents = Math.round(Number(v ?? 0) * 100)
  const abs   = Math.abs(cents)
  const int   = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const dec   = String(abs % 100).padStart(2, '0')
  return 'R$ ' + (cents < 0 ? '-' : '') + int + ',' + dec
}

function fmtDate(iso) {
  try {
    const d   = new Date(iso)
    const p   = (n) => String(n).padStart(2, '0')
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch { return String(iso ?? '') }
}

function fmtPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '')
  if (!d) return ''
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2)
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return d
}

function fmtDateParts(iso) {
  try {
    const d  = new Date(iso)
    const p  = (n) => String(n).padStart(2, '0')
    return {
      date: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`,
      time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    }
  } catch { return { date: String(iso ?? ''), time: '' } }
}

// ── Payload normaliser ─────────────────────────────────────────────────────────

const PM_MAP = {
  cash: 'DINHEIRO', dinheiro: 'DINHEIRO', DINHEIRO: 'DINHEIRO',
  pix: 'PIX', PIX: 'PIX', online_mp: 'PIX (MP)',
  credit_card: 'CARTAO CREDITO', credito: 'CARTAO CREDITO', CREDITO: 'CARTAO CREDITO',
  debit_card:  'CARTAO DEBITO',  debito:  'CARTAO DEBITO',  DEBITO:  'CARTAO DEBITO',
  fiado: 'FIADO', FIADO: 'FIADO',
}

function normalizePayload(data) {
  const rawItems = data.items ?? data.itens ?? []
  const items = rawItems.map((item) => {
    const qty       = item.quantity ?? item.quantidade ?? item.qty ?? 1
    const unitPrice = item.preco    ?? item.unitPrice  ?? item.price ?? null
    return {
      qty,
      name:     item.produto?.nome ?? item.name ?? item.nome ?? '(sem nome)',
      obs:      item.observacao    ?? item.obs   ?? '',
      unitPrice,
      subtotal: item.subtotal ?? (unitPrice != null ? unitPrice * qty : null),
      addons:   (item.adicionais ?? item.addons ?? [])
        .map((a) => (typeof a === 'string' ? a : (a.nome ?? a.name ?? '')))
        .filter(Boolean),
    }
  })

  const customerStr = typeof data.customer === 'string'
    ? data.customer
    : (data.customer?.name ?? data.customer?.nome ?? null)

  const rawPM = data.paymentMethod ?? data.formaPagamento ?? null

  return {
    tenantName:    data.tenantName    ?? data.tenant?.name ?? 'ESTABELECIMENTO',
    tenantAddress: data.tenantAddress ?? null,
    tenantPhone:   data.tenantPhone   ?? null,
    tenantCnpj:    data.tenantCnpj    ?? null,
    orderCode:     data.orderCode ?? data.code ?? data.numeroPedido ?? data.numero_pedido ?? data.id ?? '?',
    serviceType: (() => {
      const raw = String(data.serviceType ?? data.type ?? data.tipo ?? data.modalidade ?? '').toUpperCase()
      if (raw === 'TABLE'  || raw === 'MESA')    return 'MESA'
      if (raw === 'DELIVERY')                    return 'DELIVERY'
      if (raw === 'COUNTER' || raw === 'BALCAO') return 'BALCAO'
      return raw || 'MESA'
    })(),
    table:         data.mesa?.numero?.toString() ?? data.table?.toString() ?? null,
    paraViagem:    data.paraViagem ?? data.para_viagem ?? false,
    customer:      data.customer_name ?? data.nomeCliente ?? data.cliente?.nome ?? customerStr ?? null,
    garcom:        data.operator?.name ?? data.user?.name ?? data.garcom ?? null,
    createdAt:     data.created_at ?? data.createdAt ?? new Date().toISOString(),
    paymentMethod: rawPM ? (PM_MAP[rawPM] ?? String(rawPM)) : null,
    address: data.address ?? data.endereco ?? data.logradouro ?? data.enderecoEntrega
      ?? (typeof data.deliveryAddress === 'object'
          ? (data.deliveryAddress?.street ?? data.deliveryAddress?.raw ?? null)
          : (data.deliveryAddress ?? null)),
    phone: data.phone ?? data.telefone ?? data.customerPhone
      ?? data.cliente?.telefone
      ?? (typeof data.customer === 'object' ? data.customer?.phone : null)
      ?? null,
    subtotal:    data.subtotal    ?? null,
    deliveryFee: data.deliveryFee ?? data.taxaEntrega ?? null,
    discount:    data.discount    ?? null,
    total:       data.total       ?? data.valorTotal  ?? null,
    items,
  }
}

// ── Receipt builder ────────────────────────────────────────────────────────────

function buildReceiptBuffer(rawData, cols) {
  const data = normalizePayload(rawData)
  // Logo só existe quando habilitado e já convertido (apenas comprovante de pagamento)
  const logoBuf = Buffer.isBuffer(rawData._logoBuffer) ? rawData._logoBuffer : null
  console.log('[printer] build | type:', rawData._printType ?? rawData.type ?? 'payment', '| order:', data.orderCode, '| items:', data.items.length, '| logo:', !!logoBuf, '| enc:', ENCODING, '| codepage(ESC t n):', CODEPAGE_N)

  // Helpers — sem bytes nulos
  const eq  = () => ln('='.repeat(cols))
  const ctr = (str) => {
    const s = String(str).slice(0, cols)
    return ' '.repeat(Math.max(0, Math.floor((cols - s.length) / 2))) + s
  }
  const row = (l, v, w) => {
    w = w || cols
    const label = String(l), val = String(v)
    const gap = w - label.length - val.length
    if (gap < 1) return label.slice(0, w - val.length - 1) + ' ' + val
    return label + ' '.repeat(gap) + val
  }
  const wrap = (text, w) => {
    const out = []
    let line = ''
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      if (!line.length) { line = word.slice(0, w) }
      else if (line.length + 1 + word.length <= w) { line += ' ' + word }
      else { out.push(line); line = word.slice(0, w) }
    }
    if (line.length) out.push(line)
    return out.length ? out : ['']
  }

  const HALF = Math.floor(cols / 2) // colunas úteis em double-width (48/2 = 24)
  const ctrBig = (str) => {
    const s = String(str)
    if (s.length <= HALF) {
      const pad = ' '.repeat(Math.max(0, Math.floor((HALF - s.length) / 2)))
      return [BIG_ON, ln(pad + s), ESC_INIT]
    }
    const t = s.slice(0, cols)
    const pad = ' '.repeat(Math.max(0, Math.floor((cols - t.length) / 2)))
    return [TALL_ON, ln(pad + t), ESC_INIT]
  }

  const isDelivery = data.serviceType === 'DELIVERY'
  const isBalcao   = data.serviceType === 'BALCAO'
  const pedido     = 'PEDIDO #' + (data.orderCode || '?')
  const { date, time } = fmtDateParts(data.createdAt)
  const da = (typeof rawData.deliveryAddress === 'object' && rawData.deliveryAddress) || {}

  let destino
  if (isDelivery) {
    destino = 'DELIVERY - ' + String(data.customer || '').toUpperCase()
  } else if (isBalcao) {
    destino = 'BALCAO'
  } else {
    const t = data.table ? (/^mesa/i.test(String(data.table)) ? data.table : 'MESA ' + data.table) : 'MESA'
    destino = String(t).toUpperCase()
  }

  // ── VIA COZINHA — itens apenas, sem precos/entrega/totais ─────────────────────
  function buildKitchenVia() {
    console.log('[kitchen] build start | itens:', (data.items ?? []).length)
    const b = []
    const p = (...x) => b.push(...x)
    p(ESC_INIT, charset())
    // Cozinha SEMPRE texto-puro — nunca logo
    p(BOLD_ON, ...ctrBig(data.tenantName || 'ESTABELECIMENTO'))
    p(eq())
    p(BOLD_ON, ...ctrBig('VIA COZINHA'))
    p(eq())
    p(INVERT_ON, BOLD_ON, TALL_ON, ln(row(' ' + pedido, destino + ' ', cols)), INVERT_OFF, ESC_INIT)
    if (data.paraViagem) {
      // Linha própria, centrada para double-width (ctrBig usa HALF=24 cols e cai
      // para altura-dupla se não couber), envolta em inverso+bold. Nunca quebra.
      p(INVERT_ON, BOLD_ON, ...ctrBig('** PARA VIAGEM **'), INVERT_OFF, ESC_INIT)
    }
    if (data.customer && !isDelivery) p(ln('Cliente: ' + String(data.customer).slice(0, cols - 9)))
    const tipoLabel = isDelivery ? 'DELIVERY' : isBalcao ? 'BALCAO' : 'MESA'
    p(ln(row('Tipo: ' + tipoLabel, 'Hora: ' + time)))
    p(ln('Data: ' + date))
    p(eq())
    // Itens = foco visual: nome em double-height+double-width (BIG_ON), cada item
    // separado por divisor para destacar. obs/adicionais em tamanho normal.
    for (const item of data.items ?? []) {
      const prefix = String(item.qty ?? 1).padStart(2, '0') + 'X '
      const indent = ' '.repeat(prefix.length)
      const lines  = wrap(String(item.name ?? '').toUpperCase(), HALF - prefix.length)
      p(BOLD_ON, BIG_ON, ln((prefix + lines[0]).slice(0, cols)), ESC_INIT)
      for (const extra of lines.slice(1)) p(BOLD_ON, BIG_ON, ln((indent + extra).slice(0, cols)), ESC_INIT)
      if (item.obs) p(BOLD_ON, ln(('   >> ' + item.obs).slice(0, cols)), ESC_INIT)
      for (const addon of item.addons ?? []) p(ln(('   + ' + addon).slice(0, cols)))
      p(ln('-'.repeat(cols)))
    }
    p(BOLD_ON, ln(ctr('*** CONFIRA OS ITENS ***')), ESC_INIT)
    p(FEED_CUT, CUT)
    console.log('[kitchen] build end | segmentos:', b.length)
    return b
  }

  // ── VIA CLIENTE (DELIVERY) — ênfase nativa DR800 (bold/dupla-altura/sublinhado) ─
  function buildClientVia() {
    const b = []
    const p = (...x) => b.push(...x)
    const divD   = () => p(eq())                       // divisor duplo ===
    const divS   = () => p(ln('-'.repeat(cols)))       // divisor simples ---
    const blank  = () => p(ln(''))
    const lblB   = (s) => p(BOLD_ON, ln(s), ESC_INIT)  // label em bold
    const lblBU  = (s) => p(BOLD_ON, UNDER_ON, ln(s), UNDER_OFF, ESC_INIT) // bold + sublinhado
    // Bloco emoldurado: linha "=" / texto centralizado dupla-altura+bold / linha "=".
    const framedTB = (s) => { p(eq()); p(BOLD_ON, TALL_ON, ln(ctr(s)), ESC_INIT); p(eq()) }
    // Emoldurado com valor à direita (row preenche 48 cols), dupla-altura+bold.
    const framedRowTB = (l, v) => { p(eq()); p(BOLD_ON, TALL_ON, ln(row(l, v)), ESC_INIT); p(eq()) }

    p(ESC_INIT, charset())

    // 1) ESTABELECIMENTO (topo, centrado)
    if (data.tenantName) p(BOLD_ON, ln(ctr(String(data.tenantName))), ESC_INIT)
    const tEnd = [
      [data.tenantAddress, rawData.tenantNumber].filter((x) => x != null && x !== '').join(', '),
      rawData.tenantNeighborhood,
    ].filter((x) => x != null && x !== '').join(' - ')
    if (tEnd) p(ln(ctr(tEnd)))
    const tCity = [rawData.tenantCity, rawData.tenantState].filter((x) => x != null && x !== '').join('/')
    if (tCity) p(ln(ctr(tCity)))
    if (data.tenantPhone) p(ln(ctr('Tel: ' + String(data.tenantPhone))))
    if (data.tenantCnpj)  p(ln(ctr('CNPJ: ' + String(data.tenantCnpj))))

    // 2) PEDIDO + ENTREGA (emoldurados, dupla-altura + bold)
    framedTB('PEDIDO #' + (data.orderCode || '?'))
    if (rawData.delivery_code) framedTB('ENTREGA ' + String(rawData.delivery_code).toUpperCase())

    // 3) CLIENTE
    lblB('CLIENTE')
    const cliente = rawData.customer_name ?? data.customer
    if (cliente) p(ln(String(cliente)))
    const fone = fmtPhone(rawData.customer_phone ?? data.phone)
    if (fone) p(ln('Tel: ' + fone))
    divS()

    // 4) ENDERECO DE ENTREGA (header bold + sublinhado)
    lblBU('ENDERECO DE ENTREGA')
    const street = da.street ?? da.logradouro
    const number = da.number ?? da.numero
    const endereco = [street, number].filter((x) => x != null && x !== '').join(', ')
    if (endereco) {
      const lines = wrap(endereco, cols)
      p(ln(lines[0]))
      for (const extra of lines.slice(1)) p(ln(('  ' + extra).slice(0, cols)))
    }
    if (da.neighborhood) p(ln('Bairro: ' + da.neighborhood))
    if (da.city)         p(ln('Cidade: ' + da.city))
    if (da.complement)   p(ln('Compl: ' + da.complement))
    if (da.reference)    lblB('Ref: ' + da.reference) // referencia destacada
    divS()

    // 5) ITENS — tabela: QTD | DESCRICAO | UNIT | TOTAL (igual ao comprovante caixa)
    lblB('ITENS')
    const dlvRows = (data.items ?? []).map((item) => {
      const qtyN  = Number(item.qty ?? 1)
      const unitV = item.unitPrice != null
        ? item.unitPrice
        : (item.subtotal != null && qtyN ? item.subtotal / qtyN : null)
      return {
        qty:    String(item.qty ?? 1) + 'x',
        name:   String(item.name ?? '').toUpperCase(),
        unit:   unitV != null ? fmtBRL(unitV) : '',
        total:  item.subtotal != null ? fmtBRL(item.subtotal) : '',
        obs:    item.obs,
        addons: item.addons ?? [],
      }
    })
    const dlvQtyW   = Math.max(3, ...dlvRows.map((r) => r.qty.length))
    const dlvUnitW  = Math.max(4, ...dlvRows.map((r) => r.unit.length))
    const dlvTotalW = Math.max(5, ...dlvRows.map((r) => r.total.length))
    const dlvDescW  = cols - dlvQtyW - dlvUnitW - dlvTotalW - 3
    const dlvNumCell = (u, t) => u.padStart(dlvUnitW) + ' ' + t.padStart(dlvTotalW)
    p(BOLD_ON, ln(row('QTD'.padEnd(dlvQtyW) + ' DESCRICAO', dlvNumCell('UNIT', 'TOTAL'), cols)), ESC_INIT)
    for (const it of dlvRows) {
      if (it.name.length <= dlvDescW && dlvDescW >= 6) {
        p(ln(row(it.qty.padEnd(dlvQtyW) + ' ' + it.name, dlvNumCell(it.unit, it.total), cols)))
      } else {
        const lines = wrap(it.name, cols - dlvQtyW - 1)
        p(ln(it.qty.padEnd(dlvQtyW) + ' ' + lines[0]))
        for (const extra of lines.slice(1)) p(ln(' '.repeat(dlvQtyW + 1) + extra))
        p(ln(row('', dlvNumCell(it.unit, it.total), cols)))
      }
      if (it.obs) p(ln(('   >> ' + it.obs).slice(0, cols)))
      for (const addon of it.addons) p(ln(('   + ' + addon).slice(0, cols)))
    }
    divS()

    // 6) TOTAIS — TOTAL deve sempre ser itens + taxa de entrega
    const fee = Number(rawData.taxaEntrega ?? data.deliveryFee ?? 0)
    // itemsTotal: soma dos subtotais dos itens; fallback p/ subtotal do payload.
    const itemsSum = (data.items ?? []).reduce((acc, it) => acc + Number(it.subtotal ?? 0), 0)
    const itemsTotal = itemsSum > 0 ? itemsSum : Number(data.subtotal ?? 0)
    const payloadTotal = rawData.total ?? data.total
    const sumWithFee = itemsTotal + fee
    // Se o total do payload já inclui a taxa, usa-o; senão, soma a taxa.
    const displayedTotal = (payloadTotal != null && Math.abs(Number(payloadTotal) - sumWithFee) < 0.005)
      ? Number(payloadTotal)
      : sumWithFee
    console.log('[delivery total] items:', itemsTotal, '| fee:', fee, '| payloadTotal:', payloadTotal, '| displayed:', displayedTotal)
    p(ln(row('Subtotal:', fmtBRL(itemsTotal))))
    if (fee) p(ln(row('Taxa entrega:', fmtBRL(fee))))
    framedRowTB('TOTAL:', fmtBRL(displayedTotal))

    // 7) PAGAMENTO — alta visibilidade
    const ps = String(rawData.paymentStatus ?? data.paymentStatus ?? '').toUpperCase()
    const isPaid = /PAGO|PAID|APROVAD|CONFIRMAD/.test(ps)
    framedTB(isPaid ? '** PAGO **' : '** A PAGAR NA ENTREGA **')
    const pg = rawData.formaPagamento ?? data.paymentMethod
    if (pg) lblB('Forma: ' + String(pg).toUpperCase())
    const isCash = /DINHEIRO|CASH|ESPECIE/.test(String(pg ?? '').toUpperCase())
    if (rawData.needsChange) {
      const troco = Number(rawData.trocoPara ?? rawData.changeFor ?? 0)
      p(ln('Troco para: ' + fmtBRL(troco)))
      framedRowTB('LEVAR TROCO:', fmtBRL(troco - displayedTotal))
    } else if (isCash) {
      lblB('NAO PRECISA TROCO')
    }
    divD()

    // 8) RODAPE (centrado) — via cliente é SOMENTE texto: sem QR, sem raster.
    // A URL pública de acompanhamento (reviewUrl) segue no payload p/ outros
    // canais (ex.: WhatsApp), mas não é impressa.
    p(ln(ctr('Obrigado pela preferencia!')))
    p(FEED_CUT, CUT)
    return b
  }

  // ── COMPROVANTE DE PAGAMENTO (receipt:print / type payment) ───────────────────
  function buildPaymentVia() {
    const b = []
    const p = (...x) => b.push(...x)
    p(ESC_INIT, charset())
    if (logoBuf) p(logoBuf)

    // Header
    p(BOLD_ON, ln(ctr(rawData.tenantName ?? data.tenantName ?? 'ESTABELECIMENTO')), ESC_INIT)
    const endLinha = [rawData.tenantAddress ?? data.tenantAddress, rawData.tenantNumber]
      .filter((x) => x != null && x !== '').join(', ')
    if (endLinha) p(ln(ctr(endLinha)))
    const bairroCidade = [
      rawData.tenantNeighborhood,
      [rawData.tenantCity, rawData.tenantState].filter((x) => x != null && x !== '').join('/'),
    ].filter((x) => x != null && x !== '').join(' - ')
    if (bairroCidade) p(ln(ctr(bairroCidade)))
    if (rawData.tenantCep)   p(ln(ctr('CEP: ' + rawData.tenantCep)))
    const wpp = rawData.tenantPhone ?? data.tenantPhone
    if (wpp)                 p(ln(ctr('WhatsApp: ' + wpp)))
    const cnpj = rawData.tenantCnpj ?? data.tenantCnpj
    if (cnpj)                p(ln(ctr('CNPJ: ' + cnpj)))
    p(eq())

    // Título
    p(BOLD_ON, ln(ctr('COMPROVANTE DE PAGAMENTO')), ESC_INIT)
    const tituloPedido = [data.serviceType, data.table].filter((x) => x != null && x !== '').join(' ')
      + ' - #' + (data.orderCode || '?')
    p(ln(ctr(tituloPedido.trim())))
    p(ln('-'.repeat(cols)))

    // Info
    if (data.customer)        p(ln('Cliente: ' + String(data.customer)))
    const origin = rawData.origin ?? rawData.canalOrigem
    if (origin)               p(ln('Atendido por: ' + fmtOrigin(origin)))
    const operator = data.garcom ?? rawData.operator?.name ?? rawData.operator
    if (operator)             p(ln('Recebido por: ' + (typeof operator === 'object' ? (operator.name ?? '') : operator)))
    const openedAt = rawData.openedAt ?? rawData.abertoEm ?? data.createdAt
    if (openedAt)             p(ln('Aberto: ' + fmtDate(openedAt)))
    const paidAt = rawData.paidAt ?? rawData.pagoEm
    if (paidAt)               p(ln('Pago:   ' + fmtDate(paidAt)))
    const duracao = rawData.durationText ?? rawData.duracao
    if (duracao)              p(ln('Duracao: ' + duracao))
    p(ln('-'.repeat(cols)))

    // Itens — tabela: QTD | DESCRICAO | UNIT | TOTAL (total = qty x unit)
    const itemRows = (data.items ?? []).map((item) => {
      const qtyN  = Number(item.qty ?? 1)
      const unitV = item.unitPrice != null
        ? item.unitPrice
        : (item.subtotal != null && qtyN ? item.subtotal / qtyN : null)
      return {
        qty:    String(item.qty ?? 1) + 'x',
        name:   String(item.name ?? ''),
        unit:   unitV != null ? fmtBRL(unitV) : '',
        total:  item.subtotal != null ? fmtBRL(item.subtotal) : '',
        obs:    item.obs,
        addons: item.addons ?? [],
      }
    })
    const qtyW    = Math.max(3, ...itemRows.map((r) => r.qty.length))
    const unitW   = Math.max(4, ...itemRows.map((r) => r.unit.length))
    const totalW  = Math.max(5, ...itemRows.map((r) => r.total.length))
    const descW   = cols - qtyW - unitW - totalW - 3
    const numCell = (u, t) => u.padStart(unitW) + ' ' + t.padStart(totalW)

    // Cabecalho de colunas
    p(BOLD_ON, ln(row('QTD'.padEnd(qtyW) + ' DESCRICAO', numCell('UNIT', 'TOTAL'), cols)), ESC_INIT)

    for (const it of itemRows) {
      if (it.name.length <= descW && descW >= 6) {
        // cabe em uma linha
        p(ln(row(it.qty.padEnd(qtyW) + ' ' + it.name, numCell(it.unit, it.total), cols)))
      } else {
        // descricao longa: qty+nome quebram; unit/total na linha seguinte a direita
        const lines = wrap(it.name, cols - qtyW - 1)
        p(ln(it.qty.padEnd(qtyW) + ' ' + lines[0]))
        for (const extra of lines.slice(1)) p(ln(' '.repeat(qtyW + 1) + extra))
        p(ln(row('', numCell(it.unit, it.total), cols)))
      }
      if (it.obs) p(ln(('   >> ' + it.obs).slice(0, cols)))
      for (const addon of it.addons) p(ln(('   + ' + addon).slice(0, cols)))
    }
    p(ln('-'.repeat(cols)))

    // Totais (UMA vez)
    const taxa = rawData.taxaEntrega ?? data.deliveryFee
    if (taxa != null) {
      if (data.subtotal != null) p(ln(row('Subtotal:', fmtBRL(data.subtotal))))
      p(ln(row('Taxa entrega:', fmtBRL(taxa))))
    }
    const total = rawData.total ?? data.total
    if (total != null) p(BOLD_ON, ln(row('TOTAL:', fmtBRL(total))), ESC_INIT)
    const pg = rawData.formaPagamento ?? data.paymentMethod
    if (pg) p(ln('Pagamento: ' + String(pg).toUpperCase()))

    // Dinheiro: valor recebido + troco (só quando informado no caixa)
    const isCashPayment = String(pg ?? '').toUpperCase().includes('DINHEIRO')
    const valorRecebido = rawData.valorRecebido ?? data.valorRecebido
    if (isCashPayment && valorRecebido != null) {
      const trocoVal = rawData.troco ?? data.troco ?? (Number(valorRecebido) - Number(total ?? 0))
      p(ln(row('Valor Recebido', fmtBRL(valorRecebido))))
      p(ln(row('Troco', fmtBRL(trocoVal))))
    }

    // Pagamento dividido (Dividir conta) — por pessoa: valor + forma
    const splits = rawData.splitPayments ?? data.splitPayments
    if (Array.isArray(splits) && splits.length > 0) {
      p(ln('-'.repeat(cols)))
      p(BOLD_ON, ln(ctr('PAGAMENTO DIVIDIDO')), ESC_INIT)
      for (const s of splits) {
        const label = String(s.label ?? 'Pessoa')
        const forma = String(s.paymentMethod ?? s.formaPagamento ?? '')
        const valor = s.amount != null ? fmtBRL(s.amount) : ''
        p(ln(row(label, (valor + (forma ? ' - ' + forma : '')).trim())))
      }
    }
    p(eq())

    // Footer
    p(ln(ctr('Powered by Pede+')))
    p(ln(ctr('Nao e comprovante fiscal')))
    p(FEED_CUT, CUT)
    return b
  }

  // ── RELATORIO DE CAIXA (fechamento de sessao) — layout dedicado ───────────────
  function buildCaixaVia() {
    const b = []
    const p = (...x) => b.push(...x)
    p(ESC_INIT, charset())

    // Header do estabelecimento (mesmo bloco do comprovante)
    p(BOLD_ON, ln(ctr(rawData.tenantName ?? data.tenantName ?? 'ESTABELECIMENTO')), ESC_INIT)
    const endLinha = [rawData.tenantAddress ?? data.tenantAddress, rawData.tenantNumber]
      .filter((x) => x != null && x !== '').join(', ')
    if (endLinha) p(ln(ctr(endLinha)))
    const bairroCidade = [
      rawData.tenantNeighborhood,
      [rawData.tenantCity, rawData.tenantState].filter((x) => x != null && x !== '').join('/'),
    ].filter((x) => x != null && x !== '').join(' - ')
    if (bairroCidade) p(ln(ctr(bairroCidade)))
    if (rawData.tenantCep)   p(ln(ctr('CEP: ' + rawData.tenantCep)))
    const wpp = rawData.tenantPhone ?? data.tenantPhone
    if (wpp)                 p(ln(ctr('WhatsApp: ' + wpp)))
    const cnpj = rawData.tenantCnpj ?? data.tenantCnpj
    if (cnpj)                p(ln(ctr('CNPJ: ' + cnpj)))
    p(eq())

    // Titulo
    p(BOLD_ON, ln(ctr('RELATORIO DE CAIXA')), ESC_INIT)
    if (rawData.sessaoId != null) p(ln(ctr('Sessao #' + rawData.sessaoId)))
    p(ln('-'.repeat(cols)))

    // Periodo
    if (rawData.operator)  p(ln(row('Operador:', String(rawData.operator))))
    if (rawData.openedAt)  p(ln(row('Abertura:', fmtDate(rawData.openedAt))))
    if (rawData.closedAt)  p(ln(row('Fechamento:', fmtDate(rawData.closedAt))))
    p(ln(row('Valor de abertura:', fmtBRL(rawData.valorAbertura ?? 0))))
    p(ln('-'.repeat(cols)))

    // Vendas por forma de pagamento
    const pay = rawData.payments ?? {}
    p(BOLD_ON, ln('VENDAS POR FORMA DE PAGAMENTO'), ESC_INIT)
    p(ln(row('Dinheiro:', fmtBRL(pay.dinheiro ?? 0))))
    p(ln(row('PIX:', fmtBRL(pay.pix ?? 0))))
    if (pay.credito != null || pay.debito != null) {
      p(ln(row('Cartao credito:', fmtBRL(pay.credito ?? 0))))
      p(ln(row('Cartao debito:', fmtBRL(pay.debito ?? 0))))
    } else {
      p(ln(row('Cartao:', fmtBRL(pay.cartao ?? 0))))
    }
    if ((pay.fiado ?? 0) > 0)  p(ln(row('Fiado:', fmtBRL(pay.fiado))))
    if ((pay.outros ?? 0) > 0) p(ln(row('Outros:', fmtBRL(pay.outros))))
    p(ln('-'.repeat(cols)))
    p(BOLD_ON, ln(row('TOTAL DE VENDAS:', fmtBRL(rawData.totalVendas ?? 0))), ESC_INIT)
    if (rawData.numPedidos != null) {
      p(ln(row('Nro pedidos:', String(rawData.numPedidos))))
      const ticket = rawData.numPedidos > 0 ? (rawData.totalVendas ?? 0) / rawData.numPedidos : 0
      p(ln(row('Ticket medio:', fmtBRL(ticket))))
    }

    // Suprimentos / Sangrias
    const sups = rawData.suprimentos ?? []
    const sangs = rawData.sangrias ?? []
    p(ln('-'.repeat(cols)))
    p(BOLD_ON, ln('SUPRIMENTOS'), ESC_INIT)
    if (sups.length) for (const m of sups) p(ln(row('+ ' + (m.motivo || 'Suprimento'), fmtBRL(m.valor ?? 0))))
    else p(ln('Nenhum'))
    p(ln(row('Total suprimentos:', '+' + fmtBRL(rawData.totalSuprimentos ?? 0))))
    p(BOLD_ON, ln('SANGRIAS'), ESC_INIT)
    if (sangs.length) for (const m of sangs) p(ln(row('- ' + (m.motivo || 'Sangria'), fmtBRL(m.valor ?? 0))))
    else p(ln('Nenhum'))
    p(ln(row('Total sangrias:', '-' + fmtBRL(rawData.totalSangrias ?? 0))))

    // Saldo
    p(eq())
    p(BOLD_ON, ln(row('SALDO ESPERADO:', fmtBRL(rawData.saldoEsperado ?? 0))), ESC_INIT)
    if (rawData.valorFechamento != null) {
      p(ln(row('Valor no fechamento:', fmtBRL(rawData.valorFechamento))))
      const dif = rawData.diferenca != null ? rawData.diferenca : (rawData.valorFechamento - (rawData.saldoEsperado ?? 0))
      const sinal = dif > 0 ? '+' : ''
      p(BOLD_ON, ln(row('DIFERENCA:', sinal + fmtBRL(dif))), ESC_INIT)
    }
    p(eq())

    // Footer
    p(ln(ctr('Nao e comprovante fiscal')))
    p(ln(ctr('Powered by Pede+')))
    p(FEED_CUT, CUT)
    return b
  }

  // Comprovante de pagamento (caixa) — layout dedicado, sem cozinha
  const isReceipt = !isDelivery && (rawData._printType === 'receipt' || rawData._via === 'cliente'
    || rawData.type === 'payment')
  // Buffer.concat nunca recebe null/undefined
  const concat = (segs) => Buffer.concat(segs.filter(Buffer.isBuffer))
  // Relatorio de caixa: tem prioridade e nunca usa o template de pedido/pagamento.
  // Reimpressão manual (ex.: botão "Recibo" do histórico): só a via do cliente,
  // NUNCA a via cozinha. O fluxo de criação do pedido não envia esta flag.
  const customerOnly = rawData._customerOnly === true
  if (customerOnly) console.log('[reprint] via cliente | type:', rawData.type ?? '?', '| isDelivery:', isDelivery, '| builder:', isDelivery ? 'buildClientVia' : isReceipt ? 'buildPaymentVia' : 'buildPaymentVia')
  if (rawData.type === 'caixa') return concat(buildCaixaVia())
  if (isReceipt) return concat(buildPaymentVia())
  // Delivery: via cozinha e via cliente são DOIS cupons físicos. Cada via é UM
  // buffer contíguo com UM único corte no fim; printCupom envia cozinha ->
  // pausa (guilhotina atua) -> cliente. Concatenar as duas num stream só faz o
  // corte da cozinha disparar no meio do cabeçalho da via cliente (o corte da
  // DR800 é mecânico/assíncrono e o texto seguinte passa da guilhotina antes).
  if (isDelivery) {
    if (customerOnly) return concat(buildClientVia())
    return { kitchen: concat(buildKitchenVia()), client: concat(buildClientVia()), jobs: true }
  }
  if (customerOnly) return concat(buildPaymentVia())
  return concat(buildKitchenVia())
}

// ── Printing ───────────────────────────────────────────────────────────────────

// Escreve direto na porta COM em blocos pequenos com atraso entre eles.
// A DR800 em porta USB virtual (COM7) começa a processar o buffer antes de
// todos os bytes chegarem e descarta o início (cabeçalho + itens) quando o
// job é escrito de uma vez só. O envio chunked (32 bytes + 50ms) dá tempo
// para a impressora drenar o buffer e o cupom sai íntegro. Ver src/serial-print.js.
async function printViaSerial(comPort, buf) {
  // sender de TEXTO chunked: 32 bytes + 50ms (ver src/serial-print.js CHUNK_SIZE/CHUNK_DELAY_MS)
  console.log('[KITCHEN SEND] bytes:', buf.length, '| sender: serial-print chunked (texto) | chunk: 32B | delay: 50ms | porta:', comPort)
  console.log('[printViaSerial]', comPort, '| chunked | bytes:', buf.length)
  await sendToComPort(comPort.trim(), buf)
  console.log('[printViaSerial]', comPort, '| OK')
}

function printViaSpooler(printerName, buf) {
  return new Promise((resolve, reject) => {
    nodePrinter().printDirect({
      data:    buf,
      printer: printerName,
      type:    'RAW',
      success: (jobId) => { console.log('[printViaSpooler] jobId:', jobId); resolve(jobId) },
      error:   (err)   => { console.error('[printViaSpooler] erro:', err); reject(err instanceof Error ? err : new Error(String(err))) },
    })
  })
}

const _comDelay = (ms) => new Promise((r) => setTimeout(r, ms))

// Fila ÚNICA de jobs da impressora: garante que logo (raster contíguo) e texto
// (chunked) NUNCA se sobreponham na COM7. Todo envio passa por aqui, serializado.
let _printQueue = Promise.resolve()
function _enqueue(fn) {
  const job = _printQueue.then(fn)
  _printQueue = job.catch(() => {}) // mantém a cadeia viva sem propagar erro
  return job
}

// Envio efetivo de UM buffer (sem enfileirar) — usado dentro de _enqueue.
function _sendRawNow(printerNameOrPort, buf) {
  if (!printerNameOrPort) return Promise.reject(new Error('Impressora nao configurada'))
  if (isComPort(String(printerNameOrPort))) {
    console.log('[printRaw] usando serial direto chunked (bypass spooler)')
    return printViaSerial(printerNameOrPort.trim(), buf)
  }
  console.log('[printRaw] usando spooler Windows')
  return printViaSpooler(printerNameOrPort, buf)
}

function printRaw(printerNameOrPort, bufOrText) {
  const buf = Buffer.isBuffer(bufOrText) ? bufOrText : Buffer.from(bufOrText, 'binary')
  console.log('[printRaw]', printerNameOrPort, '| bytes:', buf.length)
  return _enqueue(() => _sendRawNow(printerNameOrPort, buf))
}

async function printCupom(data, printerName, cols, opts) {
  cols = cols || COLS
  setPrintParams(opts) // encoding/codepage do tenant (default Daruma cp1252/ESC t 7)
  let _logoBuffer = null
  let _logoBands = null
  // Logo APENAS no comprovante de pagamento e somente se habilitado na config.
  // Kitchen/delivery nunca chegam aqui com logo. Qualquer falha => pula o logo.
  const isPayment = data._printType === 'receipt' || data._via === 'cliente' || data.type === 'payment'
  const onComPort = isComPort(String(printerName))
  if (data._logoEnabled === true && isPayment) {
    const logoSource = data._logoSource
      ?? data.tenantLogoUrl ?? data.logoUrl ?? data.logo_url ?? data.tenantLogo
      ?? data.tenant?.logoUrl ?? data.tenant?.logo ?? null
    if (logoSource) {
      try {
        // buildLogoBands só PROCESSA a imagem (não envia) — fora da fila da COM.
        const logo = await Promise.race([
          buildLogoBands(logoSource),
          new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
        ])
        if (logo && logo.bands.length) {
          if (onComPort) {
            // DR800: raster do logo sai como lixo (9φ999...). OPT-IN explícito e
            // confirmado funcionando via env; senão NÃO emite nenhum byte raster.
            if (LOGO_RASTER_ON_COM) _logoBands = logo.bands
            else console.warn('[printCupom] logo raster na COM (DR800) desabilitado — pulando (set PEDE_LOGO_ALLOW_RASTER=1 p/ habilitar)')
          } else {
            _logoBuffer = Buffer.concat(logo.bands)            // spooler: embute no topo do texto
          }
        }
      } catch (err) {
        // Logo NUNCA bloqueia o cupom: falhou, segue só com o texto.
        console.warn('[printCupom] logo ignorado:', err?.message || err)
        _logoBands = null
        _logoBuffer = null
      }
    }
  }
  const buf = buildReceiptBuffer({ ...data, _logoBuffer }, cols)

  // Delivery (cozinha + cliente): dois cupons no MESMO job atômico da fila.
  // Pausa entre as vias: garante que o corte da via cozinha conclua antes das
  // primeiras linhas da via cliente alcançarem a guilhotina.
  if (buf && buf.jobs) {
    return _enqueue(async () => {
      await _sendRawNow(printerName, buf.kitchen)
      await _comDelay(500) // guilhotina atua (corte mecânico) antes da via cliente
      await _sendRawNow(printerName, buf.client)
    })
  }

  // COM/DR800 com logo: logo (raster) + texto (chunked) como UM job atômico na
  // fila única. Após a última banda E porta fechada, espera 200ms, então o texto.
  if (_logoBands) {
    return _enqueue(async () => {
      try {
        await sendLogoBands(printerName.trim(), _logoBands)
        await _comDelay(200) // garante porta liberada antes do sender de texto
      } catch (err) {
        console.warn('[printCupom] logo ignorado no envio:', err?.message || err)
      }
      await _sendRawNow(printerName, buf) // mesmo job/fila => sem colisão na COM7
    })
  }
  return printRaw(printerName, buf)
}

function printReceipt(data, printerName, cols) {
  return printCupom(Object.assign({}, data, { _via: 'cliente' }), printerName, cols)
}

function printTestCupom(printerName, cols, type, opts) {
  cols = cols || COLS
  type = type || 'balcao'
  setPrintParams(opts) // teste usa o encoding/codepage selecionado pelo usuário
  // Teste rápido de acentos: imprime as palavras-chave para conferir visualmente.
  if (type === 'acentos') {
    const seg = [
      ESC_INIT, charset(),
      BOLD_ON, ln(`TESTE ACENTOS (${ENCODING}/ESC t ${CODEPAGE_N})`), ESC_INIT,
      ln('='.repeat(cols)),
      BIG_ON, ln('Porção'), ESC_INIT,
      BIG_ON, ln('Camarão'), ESC_INIT,
      BIG_ON, ln('Refeição'), ESC_INIT,
      BIG_ON, ln('Promoção'), ESC_INIT,
      ln('='.repeat(cols)),
      ln('Porção Camarão Refeição Promoção'),
      ln('Água Açaí Pão Limão Café Pêssego'),
      FEED_CUT, CUT,
    ]
    return printRaw(printerName, Buffer.concat(seg.filter(Buffer.isBuffer)))
  }
  const isKitchen = type === 'cozinha'
  return printCupom(
    {
      _printType:    isKitchen ? 'kitchen' : 'receipt',
      tenantName:    'Pede+ Print',
      tenantAddress: 'Rua Exemplo, 123 - Centro',
      tenantPhone:   '(11) 99999-9999',
      orderCode:     'TESTE',
      createdAt:     new Date().toISOString(),
      serviceType:   isKitchen ? 'MESA' : 'BALCAO',
      table:         isKitchen ? '5' : 'Mesa 1',
      customer:      'Cliente Teste',
      paymentMethod: 'Dinheiro',
      items: [
        { qty: 1, name: 'Refrigerante Lata',     subtotal: 7.00,  addons: [], obs: null },
        { qty: 2, name: 'X-Burguer Especial',    subtotal: 35.80, addons: ['Sem cebola', 'Extra queijo'], obs: 'Sem pimenta' },
        { qty: 1, name: 'Suco de Laranja 500ml', subtotal: 12.00, addons: [], obs: 'Sem acucar' },
      ],
      subtotal: 47.80,
      total:    47.80,
    },
    printerName,
    cols,
    opts,
  )
}

async function getPrinters() {
  const printers = nodePrinter().getPrinters()
  console.log('[getPrinters]', printers.map((p) => p.name).filter(Boolean).join(', '))
  return printers
}

// Enumera portas seriais (COM) realmente presentes na máquina. Usado no setup
// para o usuário escolher a porta da impressora sem digitar manualmente.
// 'serialport' não é dependência deste agente (impressão usa \\.\COMx direto),
// então no Windows lemos o registro SERIALCOMM como fonte das portas.
function getSerialPorts() {
  // Caminho preferido: pacote serialport, se algum dia estiver instalado.
  try {
    const { SerialPort } = require('serialport')
    return SerialPort.list().then((ports) =>
      ports.map((p) => String(p.path || '').toUpperCase()).filter((p) => /^COM\d+$/.test(p)),
    )
  } catch { /* sem serialport — usa o registro do Windows abaixo */ }

  if (process.platform !== 'win32') return Promise.resolve([])

  return new Promise((resolve) => {
    const { execFile } = require('child_process')
    execFile('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { console.warn('[getSerialPorts] sem portas (SERIALCOMM)'); return resolve([]) }
      const names = []
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/\b(COM\d+)\s*$/i)
        if (m) names.push(m[1].toUpperCase())
      }
      console.log('[getSerialPorts]', names.join(', ') || '(nenhuma)')
      resolve([...new Set(names)])
    })
  })
}

module.exports = { printCupom, printReceipt, printTestCupom, getPrinters, getSerialPorts, setPrintParams, buildReceiptBuffer }
