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

// ── Perfil de impressora (bytes ESC/POS específicos do modelo) ────────────────
// Os bytes de CORTE e CODE PAGE vêm do PERFIL ATIVO (printer-profiles.js), por
// VID/PID — nunca hardcoded aqui. Default = Epson TM-T20; setActiveProfile()
// troca em runtime quando o auto-detect identifica o modelo. A config do tenant
// ainda sobrescreve o code page por impressora (override explícito).
const { DEFAULT_PROFILE } = require('./printer-profiles')

let _activeProfile = DEFAULT_PROFILE
// "ESC t n" do perfil: commands.codepage = [0x1B, 0x74, n] -> extrai n.
const _profileCodepage = (prof) => {
  const cp = prof && prof.commands && prof.commands.codepage
  return Array.isArray(cp) && cp.length >= 3 ? cp[2] : 16
}

const ESC_INIT  = Buffer.from([0x1b, 0x40])          // init / reset universal
const BOLD_ON   = Buffer.from([0x1b, 0x45, 0x01])    // bold on
const BIG_ON    = Buffer.from([0x1b, 0x21, 0x30])    // ESC ! 0x30 — double-height + double-width
const TALL_ON   = Buffer.from([0x1b, 0x21, 0x10])    // ESC ! 0x10 — double-height only
const INVERT_ON = Buffer.from([0x1d, 0x42, 0x01])    // GS B 1 — white-on-black
const INVERT_OFF= Buffer.from([0x1d, 0x42, 0x00])    // GS B 0 — fim invertido
const UNDER_ON  = Buffer.from([0x1b, 0x2d, 0x01])    // ESC - 1 — sublinhado on
const UNDER_OFF = Buffer.from([0x1b, 0x2d, 0x00])    // ESC - 0 — sublinhado off
// Combos ESC ! com bold embutido (bit 0x08) — para o bloco reverso contínuo da
// via cozinha, onde ESC_INIT NÃO pode rodar no meio (derrubaria o GS B ligado).
// GS B é independente de ESC !, então trocar fonte não desliga o reverso.
const FONT_BOLD      = Buffer.from([0x1b, 0x21, 0x08]) // fonte A + bold
const FONT_TALL_BOLD = Buffer.from([0x1b, 0x21, 0x18]) // dupla-altura + bold
const FONT_BIG_BOLD  = Buffer.from([0x1b, 0x21, 0x38]) // dupla-altura+largura + bold
// Espaçamento de linha = altura do caractere (24 dots): linhas reversas coladas,
// sem faixa branca entre elas (com dupla-altura o feed mínimo vira a própria
// altura do char). ESC 2 restaura o default depois do bloco.
const LINE_SPACING_TIGHT   = Buffer.from([0x1b, 0x33, 24]) // ESC 3 24
const LINE_SPACING_DEFAULT = Buffer.from([0x1b, 0x32])     // ESC 2
// Corte do perfil ativo (Epson TM-T20: parcial c/ avanço, GS V 66 0). O 0x00
// final é o parâmetro n=0 do comando E o único byte nulo do job (último byte).
// `let` porque setActiveProfile() pode trocá-lo em runtime (auto-detect VID/PID).
let CUT         = Buffer.from(_activeProfile.commands.cut)

// Code page vem do perfil ativo; encoding do texto continua cp1252 (acentos
// PT-BR corretos). Estes são os DEFAULTS — a config do tenant (electron-store)
// sobrescreve por impressora via setPrintParams({ encoding, codepage }). Env
// ainda funciona como fallback inicial:
//   PEDE_PRINT_ENCODING (default 'cp1252') — iconv.encode(text, encoding)
//   PEDE_PRINT_CODEPAGE (default = perfil) — ESC t n no início do cupom
const _ENV_ENCODING = (process.env.PEDE_PRINT_ENCODING || '').trim() || null
let DEFAULT_ENCODING = _ENV_ENCODING || _activeProfile.encoding || 'cp1252'
const _ENV_CODEPAGE = (() => {
  const n = parseInt(process.env.PEDE_PRINT_CODEPAGE, 10)
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null
})()
let DEFAULT_CODEPAGE = _ENV_CODEPAGE != null ? _ENV_CODEPAGE : _profileCodepage(_activeProfile)

// Troca o perfil ativo (auto-detect por VID/PID OU catálogo do backend). Atualiza
// corte, code page, encoding do texto e colunas default a partir do perfil. Env
// (PEDE_PRINT_*) e a config do tenant continuam com prioridade sobre o default.
function setActiveProfile(profile) {
  if (!profile || !profile.commands || !Array.isArray(profile.commands.cut)) return
  _activeProfile = profile
  CUT = Buffer.from(profile.commands.cut)
  if (_ENV_CODEPAGE == null) DEFAULT_CODEPAGE = _profileCodepage(profile)
  if (_ENV_ENCODING == null && typeof profile.encoding === 'string' && profile.encoding.trim()) {
    DEFAULT_ENCODING = profile.encoding.trim()
  }
  if (Number.isInteger(profile.columns) && profile.columns > 0) COLS = profile.columns
  console.log('[printer] perfil ativo:', profile.name || '(sem nome)',
    '| cut:', [...CUT].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' '),
    '| ESC t n:', _profileCodepage(profile), '| encoding:', DEFAULT_ENCODING, '| cols:', COLS)
}

// GS B (reverso) é suportado por toda a térmica homologada; o flag por perfil
// (supportsInvert:false) ou o env PEDE_PRINT_NO_INVERT=1 forçam o fallback ASCII
// (moldura + bold) — nunca sai caixa preta quebrada numa impressora sem suporte.
function invertSupported() {
  if (process.env.PEDE_PRINT_NO_INVERT === '1') return false
  return !_activeProfile || _activeProfile.supportsInvert !== false
}

// Estado de impressão corrente (mutável por job via setPrintParams).
let ENCODING   = DEFAULT_ENCODING
let CODEPAGE_N = DEFAULT_CODEPAGE
const charset = () => Buffer.from([0x1b, 0x74, CODEPAGE_N]) // ESC t n — code page (Epson WPC1252 = 16)

// Aplica encoding/codepage da config do tenant; valores ausentes voltam ao default.
function setPrintParams(opts) {
  const enc = opts && typeof opts.encoding === 'string' && opts.encoding.trim()
  ENCODING = enc ? enc.trim() : DEFAULT_ENCODING
  const n = opts ? parseInt(opts.codepage, 10) : NaN
  CODEPAGE_N = Number.isInteger(n) && n >= 0 && n <= 255 ? n : DEFAULT_CODEPAGE
}

// Largura padrão (80mm = 48 colunas). Default; setActiveProfile() pode ajustar
// a partir de profile.columns. Todo layout deriva deste valor.
let COLS = 48


// Mínimo de LF para o papel avançar até a guilhotina antes do corte parcial.
const FEED_CUT = Buffer.from('\n'.repeat(4), 'ascii')

// Texto codificado no ENCODING do perfil ativo (iconv), casado com o ESC t n do
// mesmo perfil (charset da ROM) — par verificado p/ acentos PT-BR corretos. Ex.:
// Daruma DR800 = cp860 + ESC t 3 (cp1252 + ESC t 7 mangla; ver printer-profiles.js).
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

// Telefone "DD NNNNN-NNNN" (sem parenteses, sem +55). Sem masking: nenhum cupom
// do Pede+ mascara o contato do cliente. Entrada invalida sai como veio.
function fmtFone(v) {
  let d = String(v ?? '').replace(/\D/g, '')
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2)
  if (d.length === 11) return `${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `${d.slice(0, 2)} ${d.slice(2, 6)}-${d.slice(6)}`
  return String(v ?? '').trim()
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

// Nome de exibição do item: meio a meio mostra os DOIS sabores + tamanho.
// "1/2 A + 1/2 B (G)". Usa "1/2" ASCII (o glifo cp1252 0xBD nao e confiavel na DR800).
function itemDisplayName(item) {
  const appendWeight = (name) => {
    const wg = Number(item.weightGrams ?? item.weight_grams ?? 0)
    const saleType = String(item.saleType ?? item.sale_type ?? '').toUpperCase()
    if (saleType !== 'WEIGHT' || !Number.isFinite(wg) || wg <= 0 || new RegExp(`${wg}\\s*g`, 'i').test(name)) return name
    return `${name} (${wg}g)`
  }
  if (item.meioAMeio && item.sabor2Nome) {
    const s1 = item.sabor1Nome || item.name
    const base = `1/2 ${s1} + 1/2 ${item.sabor2Nome}`
    return appendWeight(item.variacaoNome ? `${base} (${item.variacaoNome})` : base)
  }
  return appendWeight(item.name)
}

// Agentes pareados ANTES da correção guardaram em config.tenantAddress o endereço
// INTEIRO ("Rua X, 17 · Bairro · Cidade - UF · CEP"), enquanto bairro/cidade/CEP
// vêm em campos próprios e ganham linha só deles — o cabeçalho repetia tudo.
// Aqui a linha de endereço fica só com o que NÃO será reimpresso abaixo.
function soLogradouro(addr, rawData = {}) {
  const texto = addr == null ? '' : String(addr).trim()
  if (!texto) return ''
  const norm = (v) => String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '').toLowerCase()
  const cidadeUf = [rawData.tenantCity, rawData.tenantState].filter(Boolean).join('-')
  const redundantes = [rawData.tenantNeighborhood, rawData.tenantCity, rawData.tenantState, cidadeUf, rawData.tenantCep]
    .map(norm).filter((x) => x.length > 1)
  const partes = texto.split(/\s*·\s*/).filter((parte) => {
    const p = norm(parte)
    if (!p) return false
    if (/^cep/.test(p)) return false
    return !redundantes.includes(p)
  })
  return partes.join(' · ')
}

// Sem acento, minusculo, sem pontuacao, espacos colapsados.
function normEnd(v) {
  return String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Logradouro + numero SEM duplicar o numero.
//
// DEFENSIVO de proposito: agentes pareados antes da correcao guardaram em
// config.tenantAddress o logradouro JA com o numero ("Sitio Bode, 17"), e o
// _tenantEnrich do main.js faz esse valor vencer o do job — o numero vinha de
// novo em tenantNumber e o cabecalho saia "Sitio Bode, 17, 17". A mesma regra
// vive no backend (common/endereco/logradouro.ts), mas ela so vale pra quem
// parear de novo. Aqui conserta quem ja esta em campo.
function enderecoComNumero(logradouro, numero) {
  const rua = String(logradouro ?? '').trim()
  const num = String(numero ?? '').trim()
  if (!rua) return num
  if (!num) return rua
  const n = normEnd(num)
  // Ja termina com o numero: como ultimo segmento apos virgula ("Bode, 17") ou
  // solto no fim ("Bode 17").
  const ultimo = normEnd(rua.split(',').pop())
  const inteiro = normEnd(rua)
  if (n && (ultimo === n || inteiro === n || inteiro.endsWith(' ' + n))) return rua
  return rua + ', ' + num
}

// Title Case leve pro bairro: "feiticeiro" -> "Feiticeiro", preservando as
// preposicoes em minusculo ("Vila da Paz"). So exibicao — o banco nao muda.
const MINUSCULAS_END = new Set(['de', 'da', 'do', 'das', 'dos', 'e'])
function titleCaseBairro(valor) {
  const texto = String(valor ?? '').trim()
  if (!texto) return texto
  return texto.split(/\s+/).map((palavra, i) => {
    const baixo = palavra.toLocaleLowerCase('pt-BR')
    if (i > 0 && MINUSCULAS_END.has(baixo)) return baixo
    return baixo.charAt(0).toLocaleUpperCase('pt-BR') + baixo.slice(1)
  }).join(' ')
}

function normalizePayload(data) {
  const rawItems = data.items ?? data.itens ?? []
  const items = rawItems.map((item) => {
    const qty       = item.quantity ?? item.quantidade ?? item.qty ?? 1
    const unitPrice = item.preco    ?? item.unitPrice  ?? item.price ?? null
    const saleType = item.saleType ?? item.sale_type ?? item.produto?.saleType ?? item.produto?.sale_type ?? null
    const weightGrams = item.weightGrams ?? item.weight_grams ?? null
    const pricePerKg = item.pricePerKg ?? item.price_per_kg ?? item.produto?.pricePerKg ?? item.produto?.price_per_kg ?? null
    return {
      qty,
      name:     item.produto?.nome ?? item.name ?? item.nome ?? '(sem nome)',
      categoria: item.categoria ?? item.categoriaNome ?? item.categoria_nome
        ?? item.produto?.categoria?.nome ?? item.produto?.categoriaNome ?? null,
      obs:      item.observacao    ?? item.obs   ?? '',
      unitPrice,
      subtotal: item.subtotal ?? (unitPrice != null ? unitPrice * qty : null),
      saleType,
      weightGrams,
      pricePerKg,
      // Meio a meio (max 2 sabores) — campos do DTO 6A repassados ao builder.
      brinde:       item.brinde === true,
      meioAMeio:    item.meioAMeio ?? item.meio_a_meio ?? false,
      sabor1Nome:   item.sabor1Nome ?? item.sabor1_nome ?? null,
      sabor2Nome:   item.sabor2Nome ?? item.sabor2_nome ?? null,
      variacaoNome: item.variacaoNome ?? item.variacao_nome ?? null,
      // Combo (fase 2): componente já explodido pelo backend; comboNome agrupa a via.
      comboNome:    item.comboNome ?? item.combo_nome ?? null,
      addons:   (item.adicionais ?? item.addons ?? [])
        .map((a) => (typeof a === 'string' ? a : (a.nome ?? a.name ?? '')))
        .filter(Boolean),
      // Complementos com preço unitário (payload novo: addonsDetail; pedido cru:
      // objetos em adicionais). Só exibição — nunca entra no total.
      addonsDetail: (Array.isArray(item.addonsDetail) ? item.addonsDetail
        : (item.adicionais ?? item.addons ?? []).filter((a) => a && typeof a === 'object'))
        .map((a) => ({
          name:  String(a.nome ?? a.name ?? ''),
          qty:   Number(a.quantidade ?? a.qty ?? 1) || 1,
          price: Number(a.preco ?? a.price ?? a.valor ?? 0) || 0,
        }))
        .filter((a) => a.name),
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
    customer:      data.clienteNome ?? data.customer_name ?? data.nomeCliente ?? data.cliente?.nome ?? customerStr ?? null,
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
    // Cupom de desconto (valores SEMPRE do servidor; o app só renderiza).
    cupomCodigo:   data.cupomCodigo   ?? null,
    descontoCupom: data.descontoCupom ?? null,
    freteGratis:   data.freteGratis   ?? false,
    // Fechamento no Caixa (valores do servidor): desconto manual + couvert.
    desconto:      data.desconto      ?? null,
    couvert:       data.couvert       ?? null,
    nrPessoas:     data.nrPessoas     ?? null,
    // Enriquecimento estilo iFood (delivery) — só renderiza o que existir.
    cpf:           data.cpf           ?? null,
    entregador:    data.entregador    ?? data.motoboy?.nome ?? null,
    previsao:      data.previsaoEntrega ?? data.previsao ?? data.tempoEstimadoEntrega ?? null,
    itemCount:     data.itemCount     ?? null,
    printedAt:     data.printedAt     ?? null,
    // Horario combinado da retirada, ja formatado pelo backend ("o quanto antes"
    // ou "HH:MM"). O agente so imprime — nunca deriva/adivinha.
    retiradaLabel: data.retiradaLabel ?? null,
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

  // Rodapé de assinatura da marca — impresso em TODAS as vias, após o conteúdo
  // e ANTES do corte. Centralizado (ctr), fonte normal (sem negrito/grande).
  // ESC_INIT antes garante reset de alinhamento/ênfase herdada do conteúdo.
  const brandFooter = () => [ESC_INIT, ln(''), ln(ctr('Emitido por Pede+')), ln(ctr('pedeplus.com.br')), ln('')]

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

  // ── VIA COZINHA ───────────────────────────────────────────────────────────────
  // Flags do tenant (config Comprovantes → _receiptOpts). Defaults reproduzem o
  // comportamento histórico: sem preços, com horário/cliente, obs destacada, corte.
  function buildKitchenVia() {
    const opts = rawData._receiptOpts || {}
    const showPrices  = opts.ocultarPrecos === false   // default: oculta (true)
    const showHora    = opts.exibirHorario !== false
    const showCliente = opts.exibirClienteMesa !== false
    const destacaObs  = opts.destacarObservacoes !== false
    const agrupar     = opts.agruparPorCategoria === true
    const porSetor    = opts.umaViaPorSetor === true
    const noCut       = opts.noCut === true
    const allItems = data.items ?? []
    console.log('[kitchen] build start | itens:', allItems.length, '| showPrices:', showPrices, '| agrupar:', agrupar, '| porSetor:', porSetor)
    const b = []
    const p = (...x) => b.push(...x)

    // Cabeçalho "COMBO <nome>" impresso 1x por bloco contíguo de componentes do
    // mesmo combo. Reset por seção (grupo/setor) faz o cabeçalho reaparecer na via
    // de cada setor — ex.: o refri (BEBIDAS) sai na impressora de bebidas também
    // sob o cabeçalho do combo.
    let lastCombo = null
    const resetCombo = () => { lastCombo = null }

    const renderItem = (item) => {
      if (item.comboNome && item.comboNome !== lastCombo) {
        p(BOLD_ON, ln(('COMBO ' + String(item.comboNome)).toUpperCase().slice(0, cols)), ESC_INIT)
        lastCombo = item.comboNome
      } else if (!item.comboNome) {
        lastCombo = null
      }
      const comboIndent = item.comboNome ? '  ' : ''
      // Caixinha p/ a cozinha marcar à caneta quando o item ficar pronto. SÓ no
      // item principal (normal/meio-a-meio/brinde) — complementos "+" não recebem.
      // Entra no prefix, então `indent` alinha as continuações sob o nome.
      const prefix = comboIndent + '[ ] ' + String(item.qty ?? 1).padStart(2, '0') + 'X '
      const indent = ' '.repeat(prefix.length)
      // BRINDE (cupom PRODUTO_GRATIS): marcação forte antes do produto (ASCII-safe).
      // Barra reversa borda a borda (mesmo pad full-width do bloco PEDIDO/MESA) +
      // item emoldurado ('+---+' / '|') pra destacar na cozinha.
      const framed = item.brinde === true
      const raw = (s) => iconv.encode(String(s), ENCODING) // trecho de linha, sem \n
      // fonts = buffers de estilo do miolo; bigWidth = miolo em dupla-largura.
      // Bordas '|' sempre em fonte normal; a soma dá `cols` colunas exatas.
      const emitLine = (fonts, text, bigWidth) => {
        if (!framed) {
          p(...fonts, ln(String(text).slice(0, cols)), ...(fonts.includes(INVERT_ON) ? [INVERT_OFF] : []), ESC_INIT)
          return
        }
        const w = bigWidth ? Math.floor((cols - 2) / 2) : cols - 2
        const t = String(text).slice(0, w)
        p(FONT_BOLD, raw('|'), ...fonts, raw(t + ' '.repeat(w - t.length)), INVERT_OFF, FONT_BOLD, ln('|'), ESC_INIT)
      }
      if (framed) {
        const s = '*** BRINDE ***'
        if (invertSupported()) {
          const left = Math.floor((cols - s.length) / 2)
          p(INVERT_ON, FONT_BOLD, ln(' '.repeat(left) + s + ' '.repeat(Math.max(0, cols - left - s.length))), INVERT_OFF, ESC_INIT)
        } else {
          p(BOLD_ON, ln(ctr(s)), ESC_INIT)
        }
        p(ln('+' + '-'.repeat(cols - 2) + '+'))
      }
      if (item.meioAMeio && item.sabor2Nome) {
        const tam = item.variacaoNome ? ` (${item.variacaoNome})` : ''
        const head = wrap(('MEIO A MEIO' + tam).toUpperCase(), HALF - prefix.length)
        emitLine([BOLD_ON, BIG_ON], prefix + head[0], true)
        for (const extra of head.slice(1)) emitLine([BOLD_ON, BIG_ON], indent + extra, true)
        const sabor = (n) => {
          const sl = wrap(('1/2 ' + n).toUpperCase(), cols - 3)
          emitLine([BOLD_ON, TALL_ON], '   ' + sl[0], false)
          for (const extra of sl.slice(1)) emitLine([BOLD_ON, TALL_ON], '       ' + extra, false)
        }
        sabor(item.sabor1Nome || item.name)
        sabor(item.sabor2Nome)
      } else {
        const lines = wrap(String(itemDisplayName(item) ?? '').toUpperCase(), HALF - prefix.length)
        emitLine([BOLD_ON, BIG_ON], prefix + lines[0], true)
        for (const extra of lines.slice(1)) emitLine([BOLD_ON, BIG_ON], indent + extra, true)
      }
      // Preço por item (apenas quando "ocultar preços" está DESLIGADO).
      if (showPrices && item.subtotal != null) {
        const unit = item.unitPrice != null ? item.unitPrice : (item.qty ? item.subtotal / item.qty : item.subtotal)
        emitLine([], row('   ' + fmtBRL(unit) + ' un', fmtBRL(item.subtotal), framed ? cols - 2 : cols), false)
      }
      if (item.obs) {
        if (destacaObs) emitLine([INVERT_ON, BOLD_ON], '   >> ' + item.obs, false)
        else emitLine([], '   >> ' + item.obs, false)
      }
      for (const addon of item.addons ?? []) emitLine([], comboIndent + '   + ' + addon, false)
      if (framed) p(ln('+' + '-'.repeat(cols - 2) + '+'))
      else p(ln('-'.repeat(cols)))
    }

    const header = () => {
      p(ESC_INIT, charset())
      p(BOLD_ON, ...ctrBig(data.tenantName || 'ESTABELECIMENTO'))
      p(eq())
      p(BOLD_ON, ...ctrBig('VIA COZINHA'))
      p(eq())
      // Bloco do pedido: UM retângulo preto contínuo. GS B liga UMA vez, cada
      // linha é padded até a largura total (borda a borda), o \n sai com o
      // reverso ainda ligado e ESC 3 24 elimina a faixa branca entre linhas.
      // Respiro = linha só de espaços (invertida) no topo e na base.
      const padFull = (s, w) => { const t = String(s).slice(0, w); return t + ' '.repeat(Math.max(0, w - t.length)) }
      const destaque = data.paraViagem ? '** PARA VIAGEM **' : null
      if (invertSupported()) {
        p(LINE_SPACING_TIGHT, INVERT_ON)
        p(FONT_BOLD, ln(' '.repeat(cols)))
        p(FONT_TALL_BOLD, ln(padFull(row(' ' + pedido, destino + ' ', cols), cols)))
        if (destaque) {
          // Dupla-largura: cada char ocupa 2 colunas → pad dos DOIS lados até HALF.
          const s = destaque.slice(0, HALF)
          const left = Math.floor((HALF - s.length) / 2)
          p(FONT_BIG_BOLD, ln(' '.repeat(left) + s + ' '.repeat(Math.max(0, HALF - left - s.length))))
        }
        p(FONT_BOLD, ln(' '.repeat(cols)))
        p(INVERT_OFF, LINE_SPACING_DEFAULT, ESC_INIT)
      } else {
        // Fallback sem GS B (supportsInvert:false / PEDE_PRINT_NO_INVERT=1):
        // moldura "===" + bold, padrão já usado nas vias sem reverso.
        p(eq())
        p(BOLD_ON, TALL_ON, ln(row(' ' + pedido, destino + ' ', cols)), ESC_INIT)
        if (destaque) p(BOLD_ON, ...ctrBig(destaque), ESC_INIT)
        p(eq())
      }
      if (data.customer && !isDelivery && showCliente) p(ln('Cliente: ' + String(data.customer).slice(0, cols - 9)))
      const tipoLabel = isDelivery ? 'DELIVERY' : isBalcao ? 'BALCAO' : 'MESA'
      if (showHora) {
        p(ln(row('Tipo: ' + tipoLabel, 'Hora: ' + time)))
        p(ln('Data: ' + date))
      } else {
        p(ln('Tipo: ' + tipoLabel))
      }
      p(eq())
    }

    const footer = () => {
      if (showPrices) {
        const tot = data.total != null
          ? data.total
          : allItems.reduce((s, i) => s + (Number(i.subtotal) || 0), 0)
        p(eq())
        p(BOLD_ON, TALL_ON, ln(row('TOTAL:', fmtBRL(tot), cols)), ESC_INIT)
      }
      p(BOLD_ON, ln(ctr('*** CONFIRA OS ITENS ***')), ESC_INIT)
      p(...brandFooter())
      if (noCut) p(FEED_CUT)
      else p(FEED_CUT, CUT)
    }

    // Agrupa por categoria/setor quando habilitado e houver dado de categoria.
    const groups = new Map()
    if (agrupar || porSetor) {
      for (const it of allItems) {
        const key = (it.categoria || 'OUTROS').toString().toUpperCase()
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(it)
      }
    }
    const hasCategorias = groups.size > 1 || (groups.size === 1 && ![...groups.keys()].includes('OUTROS'))

    if ((porSetor || agrupar) && hasCategorias) {
      // UMA comanda única: cabeçalho/corte uma vez, setores como subseções.
      header()
      let first = true
      for (const [cat, items] of groups) {
        const label = porSetor ? 'SETOR: ' + cat : '— ' + cat + ' —'
        if (porSetor && !first) p(ln('-'.repeat(cols)))
        p(BOLD_ON, ln(ctr(label)), ESC_INIT)
        p(ln('-'.repeat(cols)))
        resetCombo()
        for (const it of items) renderItem(it)
        first = false
      }
      footer()
    } else {
      header()
      resetCombo()
      for (const item of allItems) renderItem(item)
      footer()
    }
    console.log('[kitchen] build end | segmentos:', b.length)
    return b
  }

  // ── VIA CLIENTE (DELIVERY) — ênfase nativa DR800 (bold/dupla-altura/sublinhado) ─
  function buildClientVia() {
    console.log('[CLIENTE-DEBUG] buildClientVia | deliveryCode:', rawData.delivery_code ?? rawData.deliveryCode ?? '(sem)', '| deliveryAddress obj:', typeof rawData.deliveryAddress === 'object' && !!rawData.deliveryAddress, '| street:', da.street ?? '(sem)', '| bairro:', da.neighborhood ?? da.district ?? '(sem)', '| subtotal:', data.subtotal, '| total:', data.total, '| itens c/ subtotal:', (data.items ?? []).filter((i) => i.subtotal != null).length + '/' + (data.items ?? []).length, '| needsChange:', rawData.needsChange, '| trocoPara:', rawData.trocoPara ?? rawData.changeFor ?? '(sem)')
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
      enderecoComNumero(soLogradouro(data.tenantAddress, rawData), rawData.tenantNumber),
      titleCaseBairro(rawData.tenantNeighborhood),
    ].filter((x) => x != null && x !== '').join(' - ')
    if (tEnd) p(ln(ctr(tEnd)))
    const tCity = [rawData.tenantCity, rawData.tenantState].filter((x) => x != null && x !== '').join('/')
    if (tCity) p(ln(ctr(tCity)))
    if (data.tenantPhone) p(ln(ctr('Tel: ' + String(data.tenantPhone))))
    if (data.tenantCnpj)  p(ln(ctr('CNPJ: ' + String(data.tenantCnpj))))

    // 2) PEDIDO + ENTREGA (emoldurados, dupla-altura + bold)
    framedTB('PEDIDO #' + (data.orderCode || '?'))
    // TIPO + DATA/HORA do pedido (condicional, null-safe)
    if (data.serviceType) p(ln(ctr(String(data.serviceType))))
    if (date) p(ln(ctr(date + (time ? ' - ' + time : ''))))
    // Código de entrega — aceita snake_case (pedido cru via emitOrder) e camelCase
    // (contentJson do recibo). É EXATAMENTE o valor que o app do motoboy consulta
    // em "Iniciar percurso" (DLV-XXXXXX); os 6 dígitos saem destacados no rodapé.
    const deliveryCodeRaw = rawData.delivery_code ?? rawData.deliveryCode ?? null
    if (deliveryCodeRaw) framedTB('ENTREGA ' + String(deliveryCodeRaw).toUpperCase())

    // 3) CLIENTE
    lblB('CLIENTE')
    const cliente = rawData.customer_name ?? data.customer
    if (cliente) p(ln(String(cliente)))
    const fone = fmtPhone(rawData.customer_phone ?? data.phone)
    if (fone) p(ln('Tel: ' + fone))
    if (data.cpf) p(ln('CPF: ' + String(data.cpf)))
    divS()

    // 4) ENDERECO DE ENTREGA (header bold + sublinhado) — ocultável pela config.
    if (rawData._receiptOpts?.exibirEnderecoEntrega !== false) {
      lblBU('ENDERECO DE ENTREGA')
      const street = da.street ?? da.logradouro
      const number = da.number ?? da.numero
      const endereco = [street, number].filter((x) => x != null && x !== '').join(', ')
      if (endereco) {
        const lines = wrap(endereco, cols)
        p(ln(lines[0]))
        for (const extra of lines.slice(1)) p(ln(('  ' + extra).slice(0, cols)))
      }
      if (da.neighborhood ?? da.district) p(ln('Bairro: ' + (da.neighborhood ?? da.district)))
      if (da.city)         p(ln('Cidade: ' + da.city))
      // contentJson do recibo pode vir com prefixo ("Complemento: X") — remove
      // p/ nao imprimir "Compl: Complemento: X".
      const daCompl = da.complement ? String(da.complement).replace(/^complemento:\s*/i, '') : null
      const daRef   = da.reference  ? String(da.reference).replace(/^(referencia|referência):\s*/i, '') : null
      if (daCompl) p(ln('Compl: ' + daCompl))
      if (daRef)   lblB('Ref: ' + daRef) // referencia destacada
      divS()
    }

    // 5) ITENS — tabela: QTD | DESCRICAO | UNIT | TOTAL (igual ao comprovante caixa)
    const dlvCount = data.itemCount ?? (data.items ?? []).reduce((s, it) => s + Number(it.qty ?? 1), 0)
    lblB('ITENS' + (dlvCount ? ` (${dlvCount} ${dlvCount === 1 ? 'item' : 'itens'})` : ''))
    const dlvRows = (data.items ?? []).map((item) => {
      const qtyN  = Number(item.qty ?? 1)
      const unitV = item.unitPrice != null
        ? item.unitPrice
        : (item.subtotal != null && qtyN ? item.subtotal / qtyN : null)
      const isBrinde = item.brinde === true
      return {
        qty:    String(item.qty ?? 1) + 'x',
        name:   (isBrinde ? 'BRINDE - ' : '') + String(itemDisplayName(item) ?? '').toUpperCase(),
        unit:   isBrinde ? fmtBRL(0) : (unitV != null ? fmtBRL(unitV) : ''),
        total:  isBrinde ? fmtBRL(0) : (item.subtotal != null ? fmtBRL(item.subtotal) : ''),
        obs:    item.obs,
        addons: item.addons ?? [],
        addonsDetail: item.addonsDetail ?? [],
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
      // Complementos: com preço unitário > 0 sai o valor alinhado na coluna TOTAL
      // ("+R$ 2,00"); grátis mantém só "+ 1x Nome". Rastreabilidade — o total do
      // pedido já contempla o adicional (preço embutido no unitPrice do item).
      const dlvDetail = it.addonsDetail.length === it.addons.length ? it.addonsDetail : null
      it.addons.forEach((addon, i) => {
        const det = dlvDetail?.[i]
        const label = ('   + ' + addon)
        if (det && det.price > 0) p(ln(row(label, dlvNumCell('', '+' + fmtBRL(det.price)), cols)))
        else p(ln(label.slice(0, cols)))
      })
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
    // Cupom de desconto (estilo iFood). Valores do servidor; sem cupom = layout atual.
    const dlvDescTotal = Number(rawData.descontoCupom ?? data.descontoCupom ?? 0)
    const dlvCupomCod = (rawData.cupomCodigo ?? data.cupomCodigo) ? String(rawData.cupomCodigo ?? data.cupomCodigo).slice(0, 14) : null
    const dlvFreteGratis = !!(rawData.freteGratis ?? data.freteGratis)
    const dlvDescSub = dlvFreteGratis ? 0 : dlvDescTotal
    const dlvCupomTag = dlvCupomCod ? ` (${dlvCupomCod})` : ''
    // itemsTotal é o subtotal CHEIO; o desconto incide sobre ele (antes do frete).
    const dlvTotalLiquido = displayedTotal - dlvDescSub
    console.log('[delivery total] items:', itemsTotal, '| fee:', fee, '| payloadTotal:', payloadTotal, '| desconto:', dlvDescTotal, '| displayed:', dlvTotalLiquido)
    p(ln(row('Subtotal:', fmtBRL(itemsTotal))))
    if (dlvDescSub > 0) p(ln(row('Desconto' + dlvCupomTag + ':', '-' + fmtBRL(dlvDescSub))))
    if (dlvFreteGratis && dlvDescTotal > 0) p(ln(row('Taxa entrega:', 'GRATIS' + dlvCupomTag)))
    else if (fee) p(ln(row('Taxa entrega:', fmtBRL(fee))))
    const dlvServ = rawData.taxaServico ?? data.taxaServico
    const dlvServPct = rawData.taxaServicoPercent ?? data.taxaServicoPercent
    const dlvHasServ = dlvServ != null && Number(dlvServ) > 0
    if (dlvHasServ) {
      const lbl = 'Taxa de servico' + (dlvServPct ? ` (${dlvServPct}%)` : '') + ':'
      p(ln(row(lbl, fmtBRL(dlvServ))))
    }
    if (dlvHasServ) framedRowTB('TOTAL C/ SERVICO:', fmtBRL(dlvTotalLiquido + Number(dlvServ)))
    else framedRowTB('TOTAL:', fmtBRL(dlvTotalLiquido))
    if (dlvDescTotal > 0) p(ln(ctr('Voce economizou ' + fmtBRL(dlvDescTotal) + dlvCupomTag)))

    // 7) PAGAMENTO — bloco EMOLDURADO (separador "===" full-width, texto centrado
    // em bold, separador "==="). Sem reverso (GS B): o fundo preto borra e gasta
    // ribbon/térmica em papel barato. ASCII-safe nas duas codificações. Lógica de
    // pagamento intacta; status em dupla-altura p/ saltar.
    const ps = String(rawData.paymentStatus ?? data.paymentStatus ?? '').toUpperCase()
    const isPaid = /PAGO|PAID|APROVAD|CONFIRMAD/.test(ps)
    const statusTxt = isPaid ? 'PAGO' : 'A PAGAR NA ENTREGA'
    const pg = rawData.formaPagamento ?? data.paymentMethod
    const formaTxt = pg ? 'FORMA: ' + String(pg).toUpperCase() : null
    const isCash = /DINHEIRO|CASH|ESPECIE/.test(String(pg ?? '').toUpperCase())
    const needsChange = !!rawData.needsChange
    const trocoPara = Number(rawData.trocoPara ?? rawData.changeFor ?? 0)
    // Linha de troco só faz sentido em DINHEIRO.
    const trocoTxt = isCash ? (needsChange ? 'TROCO PARA ' + fmtBRL(trocoPara) : 'NAO PRECISA TROCO') : null

    blank()
    p(eq())
    p(BOLD_ON, TALL_ON, ln(ctr(statusTxt)), ESC_INIT)
    if (formaTxt) p(BOLD_ON, ln(ctr(formaTxt)), ESC_INIT)
    if (trocoTxt) p(BOLD_ON, ln(ctr(trocoTxt)), ESC_INIT)
    p(eq())
    blank()

    // TROCO A LEVAR (valor que o entregador devolve) — mantido abaixo do bloco.
    if (isCash && needsChange) {
      const totalFinalDlv = dlvHasServ ? dlvTotalLiquido + Number(dlvServ) : dlvTotalLiquido
      framedRowTB('TROCO A LEVAR:', fmtBRL(Math.max(0, trocoPara - totalFinalDlv)))
    }

    // Entregador + Previsao de entrega (condicionais)
    if (data.entregador || data.previsao) {
      divS()
      if (data.entregador) p(ln('Entregador: ' + String(data.entregador)))
      if (data.previsao)   p(ln('Previsao: ' + String(data.previsao)))
    }

    // CODIGO DA ENTREGA — destaque no fim do slip p/ o balcao destacar e informar
    // ao entregador, que digita os 6 digitos em "Iniciar percurso" no app. So na
    // via cliente do delivery; double-width (ctrBig) p/ leitura facil. ASCII puro.
    // Emoldurado com "===" (sem reverso GS B).
    if (deliveryCodeRaw) {
      const codeDigits = String(deliveryCodeRaw).replace(/\D/g, '')
      const codeShown = (codeDigits.length >= 4 ? codeDigits : String(deliveryCodeRaw).toUpperCase()).split('').join(' ')
      blank()
      p(eq())
      p(BOLD_ON, ln(ctr('CODIGO DA ENTREGA')), ESC_INIT)
      p(...ctrBig(codeShown))   // número em destaque: dupla largura+altura, centrado
      p(BOLD_ON, ln(ctr('Informe ao entregador')), ESC_INIT)
      p(eq())
      blank()
    }
    divD()

    // 8) RODAPE (centrado) — via cliente é SOMENTE texto: sem QR, sem raster.
    // A URL pública de acompanhamento (reviewUrl) segue no payload p/ outros
    // canais (ex.: WhatsApp), mas não é impressa.
    const footerMsgC = rawData.footerMessage ?? data.footerMessage
    if (footerMsgC) for (const fl of wrap(String(footerMsgC), cols)) p(ln(ctr(fl)))
    p(ln(ctr('Obrigado pela preferencia!')))
    const impressoEm = fmtDate(data.printedAt ?? new Date().toISOString())
    if (impressoEm) p(ln(ctr('Impresso ' + impressoEm)))
    p(...brandFooter())
    if (rawData._receiptOpts?.noCut === true) p(FEED_CUT)
    else p(FEED_CUT, CUT)
    return b
  }

  // ── COMPROVANTE DE PAGAMENTO (receipt:print / type payment) ───────────────────
  function buildPaymentVia(preconta = false) {
    const b = []
    const p = (...x) => b.push(...x)
    const blank = () => p(ln(''))
    // WhatsApp formatado "DD NNNNN-NNNN" (sem parenteses, sem lixo no fim).
    const fmtWpp = (v) => {
      let d = String(v ?? '').replace(/\D/g, '')
      if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2)
      if (d.length === 11) return `${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`
      if (d.length === 10) return `${d.slice(0, 2)} ${d.slice(2, 6)}-${d.slice(6)}`
      return String(v ?? '').trim()
    }
    p(ESC_INIT, charset())
    if (logoBuf) p(logoBuf)

    // Header — nome em bold + dupla-altura, centrado; respiro antes do endereco.
    // Bloco de cabeçalho (endereço/contato) pode ser ocultado pela config do tenant.
    p(BOLD_ON, TALL_ON, ln(ctr(rawData.tenantName ?? data.tenantName ?? 'ESTABELECIMENTO')), ESC_INIT)
    blank()
    if (rawData._receiptOpts?.exibirCabecalho !== false) {
      const endLinha = enderecoComNumero(soLogradouro(rawData.tenantAddress ?? data.tenantAddress, rawData), rawData.tenantNumber)
      if (endLinha) p(ln(ctr(endLinha)))
      const bairroCidade = [
        titleCaseBairro(rawData.tenantNeighborhood),
        [rawData.tenantCity, rawData.tenantState].filter((x) => x != null && x !== '').join('/'),
      ].filter((x) => x != null && x !== '').join(' - ')
      if (bairroCidade) p(ln(ctr(bairroCidade)))
      if (rawData.tenantCep)   p(ln(ctr('CEP: ' + rawData.tenantCep)))
      const wpp = rawData.tenantPhone ?? data.tenantPhone
      if (wpp)                 p(ln(ctr('WhatsApp: ' + fmtWpp(wpp))))
      const cnpj = rawData.tenantCnpj ?? data.tenantCnpj
      if (cnpj)                p(ln(ctr('CNPJ: ' + cnpj)))
    }

    // Pagamento CAPTURADO de fato? Quem decide e o BACKEND (paymentCaptured no
    // payload); o agente nunca adivinha. Ausente = payload antigo -> comportamento
    // historico (comprovante de pagamento). Explicitamente false = ainda vai ser
    // pago na entrega/retirada: a via NAO pode afirmar pagamento.
    const naoPago = !preconta && rawData.paymentCaptured === false

    // Banner COMPROVANTE + MESA — emoldurado por "===" com respiro antes/depois.
    // Sem captura o titulo vira "PEDIDO - <modalidade>" (nada de "comprovante").
    blank()
    p(eq())
    const banner = preconta
      ? 'PRE-CONTA'
      : naoPago
        ? ('PEDIDO - ' + String(data.serviceType || 'PEDIDO')).trim()
        : 'COMPROVANTE DE PAGAMENTO'
    p(BOLD_ON, ln(ctr(banner)), ESC_INIT)
    // MESA limpa: "MESA 1 - #6177" (remove prefixo "Mesa/MESA" duplicado do valor).
    const tableClean = String(data.table ?? '').replace(/^\s*mesa\s*/i, '').trim()
    // Sem captura a modalidade ja esta no banner ("PEDIDO - RETIRADA") — nao repete.
    const prefixoTitulo = [naoPago ? null : data.serviceType, tableClean]
      .filter((x) => x != null && x !== '').join(' ')
    const tituloPedido = (prefixoTitulo ? prefixoTitulo + ' - ' : '') + '#' + (data.orderCode || '?')
    p(ln(ctr(tituloPedido.trim())))
    p(eq())
    if (preconta) p(BOLD_ON, ln(ctr('*** NAO E DOCUMENTO FISCAL ***')), ESC_INIT)
    blank()

    // Info — labels alinhados em coluna; dois grupos separados por linha em branco.
    const infoW = 14
    const info = (label, value) => p(ln((label + ':').padEnd(infoW) + String(value)))
    if (data.customer)        info('Cliente', data.customer)
    const cpfNota = rawData.cpf ?? data.cpf
    if (cpfNota)              info('CPF', cpfNota)
    const origin = rawData.origin ?? rawData.canalOrigem
    if (origin)               info('Atendido por', fmtOrigin(origin))
    const operator = data.garcom ?? rawData.operator?.name ?? rawData.operator
    if (operator)             info('Recebido por', (typeof operator === 'object' ? (operator.name ?? '') : operator))
    blank()
    const openedAt = rawData.openedAt ?? rawData.abertoEm ?? data.createdAt
    if (openedAt)             info('Aberto', fmtDate(openedAt))
    // Pré-conta: timestamp de emissão já formatado no fuso America/Fortaleza.
    const emitidoEm = rawData.emitidoEm ?? data.emitidoEm
    if (preconta && emitidoEm) info('Emitido', emitidoEm)
    const paidAt = rawData.paidAt ?? rawData.pagoEm
    // "Pago" so quando o dinheiro entrou de fato.
    if (!preconta && !naoPago && paidAt) info('Pago', fmtDate(paidAt))
    const duracao = rawData.durationText ?? rawData.duracao
    if (duracao)              info('Duracao', duracao)
    // Horario combinado da RETIRADA — texto pronto vindo do backend.
    const retiradaLabel = rawData.retiradaLabel ?? data.retiradaLabel
    if (retiradaLabel)        info('Retirada', String(retiradaLabel))
    p(ln('-'.repeat(cols)))

    // Itens — tabela: QTD | DESCRICAO | UNIT | TOTAL (total = qty x unit)
    // PESO: QTD = "0,452 kg" e UNIT = preco/kg.  MEIO A MEIO: cabecalho + sabores.
    // Tudo null-safe; um item malformado NUNCA derruba a via inteira (so e logado).
    const fmtKg = (g) => (Number(g) / 1000).toFixed(3).replace('.', ',') + ' kg'
    const buildItemRow = (item) => {
      const qtyN = Number(item.qty ?? 1) || 1
      // Item por PESO: UNIT = preco por unidade real (kg), nunca o total da linha.
      const isWeight = String(item.saleType ?? '').toUpperCase() === 'WEIGHT' && Number(item.weightGrams) > 0
      let unitV
      if (isWeight) {
        const wgKg = Number(item.weightGrams) / 1000
        unitV = item.pricePerKg != null
          ? item.pricePerKg
          : (item.subtotal != null && wgKg ? item.subtotal / wgKg : null)
      } else {
        unitV = item.unitPrice != null
          ? item.unitPrice
          : (item.subtotal != null && qtyN ? item.subtotal / qtyN : null)
      }
      const isMeio = !!(item.meioAMeio && item.sabor2Nome)
      const name = isMeio
        ? ('MEIO A MEIO' + (item.variacaoNome ? ` (${item.variacaoNome})` : ''))
        : String(itemDisplayName(item) ?? '(sem nome)')
      // UNIT = preco BASE do produto: o unitPrice do payload ja embute os
      // adicionais (item.price = base + soma dos complementos), entao subtrai a
      // soma por unidade. TOTAL da linha permanece o subtotal (base + adicionais) x qty.
      const addonsDetail = Array.isArray(item.addonsDetail) ? item.addonsDetail : []
      const addonsPerUnit = addonsDetail.reduce((s, a) => s + (Number(a.price) || 0) * (Number(a.qty) || 1), 0)
      let baseUnit = unitV
      if (!isWeight && unitV != null && addonsPerUnit > 0) {
        const b = Math.round((unitV - addonsPerUnit) * 100) / 100
        if (b >= 0) baseUnit = b
      }
      return {
        // Peso nao usa "Nx"; mostra a massa medida com virgula decimal.
        qty:    isWeight ? fmtKg(item.weightGrams) : (String(item.qty ?? 1) + 'x'),
        name,
        unit:   baseUnit != null ? fmtBRL(baseUnit) : '',
        total:  item.subtotal != null ? fmtBRL(item.subtotal) : '',
        obs:    item.obs,
        addons: Array.isArray(item.addons) ? item.addons : [],
        addonsDetail,
        // Sabores do meio a meio: linhas indentadas SEM preco abaixo do cabecalho.
        sabores: isMeio ? ['1/2 ' + (item.sabor1Nome || item.name || '?'), '1/2 ' + item.sabor2Nome] : null,
      }
    }
    const itemRows = (data.items ?? []).map((item) => {
      try { return buildItemRow(item) }
      catch (e) {
        console.error('[BUILD ITEM FAIL]', JSON.stringify(item), e.message, e.stack)
        return { qty: String(item?.qty ?? 1) + 'x', name: String(item?.name ?? '(item)'), unit: '', total: '', obs: null, addons: [], addonsDetail: [], sabores: null }
      }
    })
    const qtyW    = Math.max(3, ...itemRows.map((r) => r.qty.length))
    const unitW   = Math.max(4, ...itemRows.map((r) => r.unit.length))
    const totalW  = Math.max(5, ...itemRows.map((r) => r.total.length))
    const descW   = cols - qtyW - unitW - totalW - 3
    const numCell = (u, t) => String(u).padStart(unitW) + ' ' + String(t).padStart(totalW)

    // Cabecalho de colunas
    p(BOLD_ON, ln(row('QTD'.padEnd(qtyW) + ' DESCRICAO', numCell('UNIT', 'TOTAL'), cols)), ESC_INIT)

    for (const it of itemRows) {
      try {
        blank() // respiro entre cabecalho/itens; item + modificadores ficam juntos
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
        for (const s of it.sabores ?? []) {
          const sl = wrap(s, cols - 3)
          for (const line of sl) p(ln(('   ' + line).slice(0, cols)))
        }
        if (it.obs) p(ln(('   >> ' + it.obs).slice(0, cols)))
        // Complementos: pago (preco > 0) sai com o valor unitario alinhado na
        // coluna de preco ("+R$ 2,00"); gratis mantem so "+ 1x Nome". O valor e
        // informativo — o TOTAL da linha ja soma base + adicionais.
        const det = it.addonsDetail && it.addonsDetail.length === it.addons.length ? it.addonsDetail : null
        it.addons.forEach((addon, i) => {
          const d = det?.[i]
          const label = '   + ' + addon
          if (d && d.price > 0) p(ln(row(label, numCell('', '+' + fmtBRL(d.price)), cols)))
          else p(ln(label.slice(0, cols)))
        })
      } catch (e) {
        console.error('[BUILD ITEM FAIL]', JSON.stringify(it), e.message, e.stack)
      }
    }
    p(ln('-'.repeat(cols)))

    // Totais (UMA vez)
    const taxa = rawData.taxaEntrega ?? data.deliveryFee
    const taxaServ = rawData.taxaServico ?? data.taxaServico
    const taxaServPct = rawData.taxaServicoPercent ?? data.taxaServicoPercent
    const hasServ = taxaServ != null && Number(taxaServ) > 0
    // Cupom de desconto (estilo iFood). Valores do servidor; sem cupom = layout atual.
    const descTotal = Number(data.descontoCupom ?? 0)
    const cupomCod = data.cupomCodigo ? String(data.cupomCodigo).slice(0, 14) : null
    const freteGratis = !!data.freteGratis
    const descSub = freteGratis ? 0 : descTotal
    const cupomTag = cupomCod ? ` (${cupomCod})` : ''
    // Fechamento no Caixa (valores do servidor): desconto manual + couvert por pessoa.
    const descManual = Number(rawData.desconto ?? data.desconto ?? 0)
    const couvert = Number(rawData.couvert ?? data.couvert ?? 0)
    const nrPessoas = rawData.nrPessoas ?? data.nrPessoas ?? null
    if (taxa != null || hasServ || descTotal > 0 || descManual > 0 || couvert > 0) {
      if (data.subtotal != null) p(ln(row('Subtotal:', fmtBRL(Number(data.subtotal) + descSub))))
      if (descSub > 0) p(ln(row('Desconto' + cupomTag + ':', '-' + fmtBRL(descSub))))
      if (descManual > 0) p(ln(row('Desconto:', '-' + fmtBRL(descManual))))
      if (freteGratis && descTotal > 0) p(ln(row('Taxa entrega:', 'GRATIS' + cupomTag)))
      else if (taxa != null) p(ln(row('Taxa entrega:', fmtBRL(taxa))))
      if (hasServ) {
        const lbl = 'Taxa de servico' + (taxaServPct ? ` (${taxaServPct}%)` : '') + ':'
        p(ln(row(lbl, fmtBRL(taxaServ))))
      }
      if (couvert > 0) {
        const lbl = nrPessoas ? `Couvert (${nrPessoas}x):` : 'Couvert:'
        p(ln(row(lbl, fmtBRL(couvert))))
      }
    }
    blank() // respiro antes do TOTAL
    const total = rawData.total ?? data.total
    const totalComServ = rawData.totalComServico ?? data.totalComServico
    // TOTAL = unica linha enfatizada: bold + dupla-altura.
    if (hasServ && totalComServ != null) {
      p(BOLD_ON, TALL_ON, ln(row('TOTAL C/ SERVICO:', fmtBRL(totalComServ))), ESC_INIT)
    } else if (total != null) {
      p(BOLD_ON, TALL_ON, ln(row('TOTAL:', fmtBRL(total))), ESC_INIT)
    }
    if (descTotal > 0) p(ln(ctr('Voce economizou ' + fmtBRL(descTotal) + cupomTag)))
    blank() // separa TOTAL do grupo Pagamento/Valor Recebido/Troco
    // Pré-conta NÃO mostra forma de pagamento, troco nem "PAGO".
    const pg = preconta ? null : (rawData.formaPagamento ?? data.paymentMethod)
    if (naoPago) {
      // Ainda vai ser pago: rotulo honesto com a forma DESEJADA (texto do backend).
      const aPagar = rawData.paymentDueLabel ?? pg
      if (aPagar) p(BOLD_ON, ln('A PAGAR: ' + String(aPagar).toUpperCase()), ESC_INIT)
    } else if (pg) {
      p(ln('Pagamento: ' + String(pg).toUpperCase()))
    }

    // Dinheiro: valor recebido + troco (só quando informado no caixa)
    const isCashPayment = String(pg ?? '').toUpperCase().includes('DINHEIRO')
    const valorRecebido = rawData.valorRecebido ?? data.valorRecebido
    if (!preconta && isCashPayment && valorRecebido != null) {
      const trocoVal = rawData.troco ?? data.troco ?? (Number(valorRecebido) - Number(total ?? 0))
      p(ln(row('Valor Recebido', fmtBRL(valorRecebido))))
      p(ln(row('Troco', fmtBRL(trocoVal))))
    }

    // Pagamento dividido (Dividir conta) — por pessoa: valor + forma
    const splits = preconta ? null : (rawData.splitPayments ?? data.splitPayments)
    if (Array.isArray(splits) && splits.length > 0) {
      blank()
      p(ln('-'.repeat(cols)))
      p(BOLD_ON, ln(ctr('PAGAMENTO DIVIDIDO')), ESC_INIT)
      blank()
      for (const s of splits) {
        const label = String(s.label ?? 'Pessoa')
        const forma = String(s.paymentMethod ?? s.formaPagamento ?? '')
        const valor = s.amount != null ? fmtBRL(s.amount) : ''
        p(ln(row(label, (valor + (forma ? ' - ' + forma : '')).trim())))
        // Taxa de servico proporcional por parte (informativo; nao altera o valor).
        if (s.taxaServico != null && Number(s.taxaServico) > 0) {
          p(ln(row('   + Taxa de servico:', fmtBRL(s.taxaServico))))
        }
      }
    }
    blank() // respiro antes do rodape
    p(eq())
    blank()

    // Footer
    const footerMsg = rawData.footerMessage ?? data.footerMessage
    if (footerMsg) for (const fl of wrap(String(footerMsg), cols)) p(ln(ctr(fl)))
    p(ln(ctr('Obrigado pela preferencia!')))
    p(ln(ctr('Nao e comprovante fiscal')))
    p(...brandFooter())
    if (rawData._receiptOpts?.noCut === true) p(FEED_CUT)
    else p(FEED_CUT, CUT)
    return b
  }

  // ── VIA DO CLIENTE — RETIRADA (etiqueta p/ grampear no pacote) ───────────────
  // NAO e cupom fiscal: e a ETIQUETA de entrega no balcao. Codigo/senha, cliente e
  // horario em fonte grande (identificacao de longe); itens com suas observacoes;
  // TOTAL e status de pagamento em destaque (e o que diz se cobra ou nao na
  // entrega). Todo campo e OPCIONAL: payload sem o campo => sem a linha, entao
  // pedido antigo continua saindo igual. Corte proprio respeitando noCut.
  function buildViaClienteRetirada() {
    const b = []
    const p = (...x) => b.push(...x)
    const blank = () => p(ln(''))
    p(ESC_INIT, charset())

    // Faixa RETIRADA: e o que o atendente enxerga de longe no maco de etiquetas.
    p(eq())
    p(...ctrBig('RETIRADA'))
    p(eq())
    blank()

    // Codigo/senha do pedido — o maior elemento da etiqueta.
    p(ln(ctr('PEDIDO')))
    p(...ctrBig('#' + (data.orderCode || '?')))
    blank()

    // Horario combinado: e a informacao que o balcao precisa ver na etiqueta.
    // Fica ANTES do cliente — junto com o codigo, forma o bloco de identificacao.
    const retiradaLabel = rawData.retiradaLabel ?? data.retiradaLabel
    if (retiradaLabel) {
      p(ln(ctr('RETIRAR')))
      p(...ctrBig(String(retiradaLabel).toUpperCase()))
      blank()
    }

    const cliente = String(rawData.customer ?? data.customer ?? '').trim()
    if (cliente) {
      p(ln(ctr('CLIENTE')))
      p(...ctrBig(cliente.toUpperCase()))
    }
    // WhatsApp e OPCIONAL (mesa/retirada): sem telefone NAO sai linha nenhuma.
    const fone = String(rawData.phone ?? data.phone ?? '').trim()
    if (fone) p(ln(ctr(fmtFone(fone))))
    if (cliente || fone) blank()

    // Itens compactos: "2x Refrigerante Lata" + a observacao logo abaixo, quando
    // houver ("sem cebola"). Item sem obs nao ganha linha extra.
    const itens = data.items ?? []
    if (itens.length) {
      p(ln('-'.repeat(cols)))
      for (const item of itens) {
        const qty = Number(item.qty ?? 1) || 1
        const linhas = wrap(qty + 'x ' + String(item.name ?? ''), cols)
        p(ln(linhas[0]))
        for (const extra of linhas.slice(1)) p(ln('   ' + extra.slice(0, cols - 3)))
        const obs = String(item.obs ?? '').trim()
        if (obs) for (const ol of wrap('>> ' + obs, cols - 3)) p(ln('   ' + ol))
      }
      p(ln('-'.repeat(cols)))
    }

    // TOTAL + status de pagamento: o bloco que decide se cobra na entrega.
    const totalVia = rawData.total ?? data.total
    if (totalVia != null) {
      blank()
      p(BOLD_ON, TALL_ON, ln(row('TOTAL:', fmtBRL(totalVia))), ESC_INIT)
    }
    // paymentCaptured e a verdade do BACKEND — o agente nunca deduz. Ausente
    // (payload antigo) => nao imprime status algum.
    if (rawData.paymentCaptured === true) {
      p(...ctrBig('PAGO'))
    } else if (rawData.paymentCaptured === false) {
      const aPagar = rawData.paymentDueLabel ?? rawData.formaPagamento ?? data.paymentMethod
      p(BOLD_ON, ln(ctr('A PAGAR: ' + String(aPagar ?? '').toUpperCase().trim())), ESC_INIT)
    }
    if (totalVia != null || rawData.paymentCaptured != null) {
      blank()
      p(ln('-'.repeat(cols)))
    }

    p(ln(ctr(date + '  ' + time)))
    p(...brandFooter())
    if (rawData._receiptOpts?.noCut === true) p(FEED_CUT)
    else p(FEED_CUT, CUT)
    return b
  }

  // ── RELATORIO DE CAIXA (fechamento de sessao) — layout dedicado ───────────────
  function buildCaixaVia() {
    const b = []
    const p = (...x) => b.push(...x)
    p(ESC_INIT, charset())

    // Header do estabelecimento (mesmo bloco do comprovante)
    p(BOLD_ON, ln(ctr(rawData.tenantName ?? data.tenantName ?? 'ESTABELECIMENTO')), ESC_INIT)
    const endLinha = enderecoComNumero(soLogradouro(rawData.tenantAddress ?? data.tenantAddress, rawData), rawData.tenantNumber)
    if (endLinha) p(ln(ctr(endLinha)))
    const bairroCidade = [
      titleCaseBairro(rawData.tenantNeighborhood),
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
    p(...brandFooter())
    if (rawData._receiptOpts?.noCut === true) p(FEED_CUT)
    else p(FEED_CUT, CUT)
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
  console.log('[CLIENTE-DEBUG] builder | type:', rawData.type ?? '?', '| serviceType:', data.serviceType, '| isDelivery:', isDelivery, '| isReceipt:', isReceipt, '| customerOnly:', customerOnly, '| _via:', rawData._via ?? '(sem)', '| _kitchenOnly:', rawData._kitchenOnly === true)
  if (customerOnly) console.log('[reprint] via cliente | type:', rawData.type ?? '?', '| isDelivery:', isDelivery, '| builder:', isDelivery ? 'buildClientVia' : isReceipt ? 'buildPaymentVia' : 'buildPaymentVia')
  if (rawData.type === 'caixa') return concat(buildCaixaVia())
  // Etiqueta de retirada: via ADICIONAL enfileirada pelo backend no order:new.
  // Tem prioridade sobre os demais templates e nunca imprime comanda/comprovante.
  if (rawData.type === 'viaClienteRetirada' || rawData._printType === 'viaClienteRetirada') {
    return concat(buildViaClienteRetirada())
  }
  // Pré-conta: reusa o builder do comprovante (itens/addons/obs/totais), mas com
  // cabeçalho PRE-CONTA, aviso "NAO E DOCUMENTO FISCAL" e SEM pagamento/troco.
  if (rawData.type === 'prebill') return concat(buildPaymentVia(true))
  if (isReceipt) return concat(buildPaymentVia())
  // Delivery: via cozinha e via cliente são DOIS cupons físicos. Cada via é UM
  // buffer contíguo com UM único corte no fim; printCupom envia cozinha ->
  // pausa (guilhotina atua) -> cliente. Concatenar as duas num stream só faz o
  // corte da cozinha disparar no meio do cabeçalho da via cliente (o corte da
  // DR800 é mecânico/assíncrono e o texto seguinte passa da guilhotina antes).
  if (isDelivery) {
    if (customerOnly) return concat(buildClientVia())
    // _kitchenOnly: na via da cozinha (order:new) imprime SÓ a comanda; o recibo
    // do cliente sai pelo gate próprio do destino (delivery.autoPrint).
    if (rawData._kitchenOnly === true) return concat(buildKitchenVia())
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

// Fila POR ALVO: garante que logo (raster contíguo) e texto (chunked) NUNCA se
// sobreponham NA MESMA impressora, mas mantém impressoras distintas isoladas —
// um job travado num alvo não bloqueia os demais (roteamento multi-setor).
const _printQueues = new Map()
function _enqueue(fn, target) {
  const key = String(target || '_default').trim().toUpperCase()
  const prev = _printQueues.get(key) || Promise.resolve()
  const job = prev.then(fn)
  _printQueues.set(key, job.catch(() => {})) // mantém a cadeia do alvo viva sem propagar erro
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
  return _enqueue(() => _sendRawNow(printerNameOrPort, buf), printerNameOrPort)
}

async function printCupom(data, printerName, cols, opts) {
  cols = cols || COLS
  setPrintParams(opts) // encoding/codepage do tenant (default perfil Epson cp1252/ESC t 16)
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
  // Perfil POR IMPRESSORA (roteamento multi-setor): aplica o ESC/POS do alvo
  // IMEDIATAMENTE antes do build (síncrono) — fecha a janela de corrida com jobs
  // concorrentes em outra impressora, pois o buffer já sai com corte/code page certos.
  if (opts && opts.profile) { setActiveProfile(opts.profile); setPrintParams(opts) }
  // Corte por impressora: noCut via opts (test-print/roteamento) OU via _receiptOpts
  // (caminho roteado). Suprime GS V / ESC m no rodapé, mantém o FEED final.
  const noCut = (opts && opts.noCut === true) || data._receiptOpts?.noCut === true
  console.log('[printer] cut:', noCut ? '(suprimido por cortarPapel=false)' : [...CUT].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' '))
  const _data = noCut ? { ...data, _receiptOpts: { ...(data._receiptOpts || {}), noCut: true } } : data
  let buf = buildReceiptBuffer({ ..._data, _logoBuffer }, cols)

  // Bipe ao imprimir (config do tenant). BEL (0x07) é o comando mais seguro/
  // universal; impressoras sem buzzer simplesmente ignoram o byte.
  if (data._receiptOpts?.beep === true) {
    const BEEP = Buffer.from([0x07])
    if (buf && buf.jobs) buf = { ...buf, kitchen: Buffer.concat([BEEP, buf.kitchen]) }
    else if (Buffer.isBuffer(buf)) buf = Buffer.concat([BEEP, buf])
  }

  // Delivery (cozinha + cliente): dois cupons no MESMO job atômico da fila.
  // Pausa entre as vias: garante que o corte da via cozinha conclua antes das
  // primeiras linhas da via cliente alcançarem a guilhotina.
  if (buf && buf.jobs) {
    return _enqueue(async () => {
      await _sendRawNow(printerName, buf.kitchen)
      await _comDelay(500) // guilhotina atua (corte mecânico) antes da via cliente
      await _sendRawNow(printerName, buf.client)
    }, printerName)
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
    }, printerName)
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
    const noCut = opts && opts.noCut === true
    console.log('[printer] cut:', noCut ? '(suprimido por cortarPapel=false)' : [...CUT].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' '))
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
      FEED_CUT, ...(noCut ? [] : [CUT]),
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

function getActiveProfile() { return _activeProfile }
function getActiveColumns() { return COLS }

module.exports = { printCupom, printReceipt, printTestCupom, getPrinters, getSerialPorts, setPrintParams, setActiveProfile, getActiveProfile, getActiveColumns, buildReceiptBuffer }
