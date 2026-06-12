// Converte um logo (arquivo local ou URL) em bytes de raster ESC/POS (GS v 0).
//
// IMPORTANTE: estes bytes são BINÁRIOS (imagem) e NUNCA podem passar pelo
// encode CP850/iconv usado no texto. Quem consome (printer.js) concatena este
// Buffer cru via Buffer.concat — só os segmentos de TEXTO são encodados.
//
// Lixo (ÿÿÿ...) acima da imagem = desync: o tamanho dos dados não bate com
// widthBytes*height. Solução: largura SEMPRE múltipla de 8 (padding branco à
// direita) e dados com comprimento EXATO widthBytes*height.

const fs = require('fs')
const Jimp = require('jimp')
const sharp = require('sharp')
const QRCode = require('qrcode')
const { sendRaster } = require('./raster-send')

const MAX_WIDTH = 576 // 80mm @ 203dpi (48 col)
const LOAD_TIMEOUT_MS = 4000 // download/leitura nunca pode travar o cupom
const ALIGN_CT = Buffer.from([0x1b, 0x61, 0x01]) // ESC a 1 — centraliza
const ALIGN_LT = Buffer.from([0x1b, 0x61, 0x00]) // ESC a 0 — esquerda

const _cache = new Map() // source -> Buffer | null

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout ' + label)), ms)),
  ])
}

async function _loadImage(source) {
  const s = String(source).trim()
  if (/^https?:\/\//i.test(s)) return _withTimeout(Jimp.read(s), LOAD_TIMEOUT_MS, 'download ' + s)
  if (!fs.existsSync(s)) throw new Error('logo nao encontrado: ' + s)
  return _withTimeout(Jimp.read(s), LOAD_TIMEOUT_MS, 'read ' + s)
}

// Gera GS v 0 a partir de imagem já em P&B. Largura padded a múltiplo de 8.
// Retorna { buf, widthBytes, height, dataLen } ou lança se houver mismatch.
function _toRaster(img) {
  const w = img.bitmap.width
  const h = img.bitmap.height
  const widthBytes = Math.ceil(w / 8)        // bytes por linha (largura padded/8)
  const paddedW = widthBytes * 8             // largura efetiva, múltiplo de 8

  // Empacota: 1 bit/pixel, MSB primeiro, bit set = preto. Padding à direita = branco (0).
  const data = Buffer.alloc(widthBytes * h, 0x00)
  for (let y = 0; y < h; y++) {
    const rowOff = y * widthBytes
    for (let x = 0; x < w; x++) {             // x >= w (até paddedW) fica 0 = branco
      const { r } = Jimp.intToRGBA(img.getPixelColor(x, y))
      if (r < 128) data[rowOff + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }

  const expected = widthBytes * h
  if (data.length !== expected) {
    throw new Error(`raster mismatch: data=${data.length} esperado=${expected} (wB=${widthBytes} h=${h})`)
  }

  const header = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    widthBytes & 0xff, (widthBytes >> 8) & 0xff,
    h & 0xff, (h >> 8) & 0xff,
  ])

  console.log(`[logo] widthPx=${w} paddedW=${paddedW} heightPx=${h} widthBytes=${widthBytes} dataLen=${data.length} (==${expected})`)
  return { buf: Buffer.concat([header, data]), widthBytes, height: h, dataLen: data.length }
}

// Retorna o Buffer binário do logo (centralizado) ou null se falhar/ausente.
async function getLogoBuffer(source) {
  if (!source) return null
  if (_cache.has(source)) return _cache.get(source)

  try {
    const img = await _loadImage(source)
    if (img.bitmap.width > MAX_WIDTH) img.resize(MAX_WIDTH, Jimp.AUTO)
    img.greyscale().dither565()           // grayscale + dithering Floyd-Steinberg
    const { buf: raster, widthBytes, height, dataLen } = _toRaster(img)
    if (dataLen !== widthBytes * height) {
      console.warn('[logo] raster malformado, pulando logo')
      _cache.set(source, null)
      return null
    }
    const buf = Buffer.concat([ALIGN_CT, raster, ALIGN_LT, Buffer.from('\n', 'ascii')])
    _cache.set(source, buf)
    return buf
  } catch (e) {
    console.error('[logo] falha ao processar, imprimindo so texto:', e.message)
    _cache.set(source, null)             // não retenta toda vez
    return null
  }
}

// ── Logo em BANDAS GS v 0 (caminho comprovado no test-logo.js) ───────────────
//
// GS v 0 grande estoura o receptor da DR800. Fatia em bandas de poucas linhas;
// cada banda é um GS v 0 COMPLETO (ESC @ + ESC a 1 + header + dados), enviada
// como UMA escrita contígua (src/raster-send.js, NUNCA o sender de texto
// chunked), com pausa entre bandas. Resultado idêntico ao test-logo.

const LOGO_WIDTH_PX  = 384            // múltiplo de 8
const LOGO_WIDTH_B   = LOGO_WIDTH_PX / 8 // 48
const LOGO_MAX_H     = Math.max(8, Number(process.env.PEDE_LOGO_MAX_HEIGHT || 120)) // teto de altura
const BAND_HEIGHT    = Math.max(1, Number(process.env.PEDE_LOGO_BAND || 8))      // linhas/banda
const BAND_DELAY_MS  = Math.max(0, Number(process.env.PEDE_LOGO_BAND_DELAY || 150))
const LOGO_THRESHOLD = Number(process.env.PEDE_LOGO_THRESHOLD || 128)

const _ESC_INIT = Buffer.from([0x1b, 0x40])       // ESC @
const _ALIGN_CT = Buffer.from([0x1b, 0x61, 0x01]) // ESC a 1 — centraliza
const _ALIGN_LT = Buffer.from([0x1b, 0x61, 0x00]) // ESC a 0 — esquerda
const _LF       = Buffer.from([0x0a])

const _delay = (ms) => new Promise((r) => setTimeout(r, ms))

// Carrega o input como Buffer (URL via fetch, ou arquivo local).
async function _loadInputBuffer(source) {
  const s = String(source).trim()
  if (/^https?:\/\//i.test(s)) {
    const res = await _withTimeout(fetch(s), LOAD_TIMEOUT_MS, 'download ' + s)
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + s)
    return Buffer.from(await res.arrayBuffer())
  }
  if (!fs.existsSync(s)) throw new Error('logo nao encontrado: ' + s)
  return fs.readFileSync(s)
}

// Gera as bandas GS v 0 do logo. Retorna { bands: Buffer[], widthBytes, height }
// ou null se falhar/ausente. Cada banda já inclui ESC @ + ESC a 1.
async function buildLogoBands(source, opts = {}) {
  if (!source) return null
  const threshold  = Number(opts.threshold ?? LOGO_THRESHOLD)
  const bandHeight = Math.max(1, Number(opts.bandHeight ?? BAND_HEIGHT))

  const input = await _loadInputBuffer(source)
  // Pipeline determinístico: fundo branco opaco (sem alpha), 1 canal, 1 byte/px,
  // binarizado (0 ou 255). CRÍTICO: fit:'inside' com TETO de altura (LOGO_MAX_H)
  // preservando aspecto — senão a altura fica enorme (367px/46 bandas) e desync.
  const { data: raw, info } = await sharp(input)
    .resize({ width: LOGO_WIDTH_PX, height: LOGO_MAX_H, fit: 'inside', withoutEnlargement: false })
    .flatten({ background: '#fff' })
    .greyscale()
    .threshold(threshold)
    .raw()
    .toBuffer({ resolveWithObject: true })

  const w = info.width, h = info.height
  if (w > LOGO_WIDTH_PX) throw new Error(`largura inesperada: ${w} > ${LOGO_WIDTH_PX}`)
  if (info.channels !== 1) throw new Error(`channels inesperado: ${info.channels}`)

  // Pack 1-bit: MSB-first; pixel 0 (preto) -> bit 1. Padding à direita = branco.
  const packed = Buffer.alloc(LOGO_WIDTH_B * h, 0x00)
  for (let y = 0; y < h; y++) {
    const srcOff = y * w, dstOff = y * LOGO_WIDTH_B
    for (let x = 0; x < w; x++) {
      if (raw[srcOff + x] === 0) packed[dstOff + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }

  const header = (rows) => Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    LOGO_WIDTH_B & 0xff, (LOGO_WIDTH_B >> 8) & 0xff,
    rows & 0xff, (rows >> 8) & 0xff,
  ])

  const bands = []
  for (let y0 = 0; y0 < h; y0 += bandHeight) {
    const rows  = Math.min(bandHeight, h - y0)
    const slice = packed.subarray(y0 * LOGO_WIDTH_B, (y0 + rows) * LOGO_WIDTH_B)
    // ESC @ + ESC a 1 ANTES DE CADA banda (config comprovada no test-logo).
    bands.push(Buffer.concat([_ESC_INIT, _ALIGN_CT, header(rows), slice]))
  }
  console.log('[logo] height:', h, '| bands:', bands.length, '| widthPx:', w, '| linhasPorBanda:', bandHeight)
  return { bands, widthBytes: LOGO_WIDTH_B, height: h }
}

// ── QR Code em BANDAS GS v 0 (MESMO formato/pipeline do logo) ────────────────
//
// A DR800 não imprime o QR nativo (GS ( k) — sai nada. Geramos a matriz de
// módulos do QR (sem PNG), escalamos para dots de impressora, empacotamos no
// MESMO raster 1-bit do logo e enviamos pelas MESMAS bandas GS v 0 via
// sendLogoBands (escrita contígua + mutex da COM7). Retorna { bands, widthBytes,
// height } ou lança em erro.
function buildQrBands(text, opts = {}) {
  const quiet      = Math.max(0, Number(opts.quiet ?? 4))          // zona de silêncio (módulos)
  const bandHeight = Math.max(1, Number(opts.bandHeight ?? BAND_HEIGHT))

  const qr   = QRCode.create(String(text), { errorCorrectionLevel: 'M' })
  const size = qr.modules.size
  const mods = qr.modules.data // Uint8Array size*size, 1 = módulo escuro
  const modsTotal = size + quiet * 2

  // Escala adaptativa: ~4 dots/módulo no mínimo, ajustada p/ ~288px (250–320px),
  // limitada a 12 dots e à largura máxima do papel (576).
  let scale = Math.max(4, Math.min(12, Math.round(288 / modsTotal)))
  if (modsTotal * scale > MAX_WIDTH) scale = Math.floor(MAX_WIDTH / modsTotal)

  const widthPx    = modsTotal * scale
  const widthBytes = Math.ceil(widthPx / 8) // largura padded a múltiplo de 8
  const height     = widthPx                // QR é quadrado

  // Pack 1-bit: MSB-first; módulo escuro -> bit 1. Padding à direita = branco.
  const packed = Buffer.alloc(widthBytes * height, 0x00)
  for (let py = 0; py < height; py++) {
    const my = Math.floor(py / scale) - quiet
    const rowOff = py * widthBytes
    for (let px = 0; px < widthPx; px++) {
      const mx = Math.floor(px / scale) - quiet
      const dark = mx >= 0 && mx < size && my >= 0 && my < size && mods[my * size + mx]
      if (dark) packed[rowOff + (px >> 3)] |= 0x80 >> (px & 7)
    }
  }

  const header = (rows) => Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    widthBytes & 0xff, (widthBytes >> 8) & 0xff,
    rows & 0xff, (rows >> 8) & 0xff,
  ])

  // Cada banda é APENAS um GS v 0 (header + dados). ESC @ / ESC a NÃO entram aqui:
  // init+alinhamento são enviados UMA vez antes da 1ª banda (ver sendQrBands).
  // Fonte única de verdade: o mesmo widthBytes vai pro header e define o tamanho
  // de cada linha; rows reflete a altura REAL da banda (a última pode ser menor).
  const bands = []
  for (let y0 = 0; y0 < height; y0 += bandHeight) {
    const rows  = Math.min(bandHeight, height - y0)
    const slice = packed.subarray(y0 * widthBytes, (y0 + rows) * widthBytes)
    bands.push(Buffer.concat([header(rows), slice]))
  }
  // Versão inline (spooler não-COM): init+centraliza uma vez, bandas, volta à esquerda.
  const inline = Buffer.concat([_ESC_INIT, _ALIGN_CT, ...bands, _ALIGN_LT, _LF, _LF])
  console.log(`[qr] size:${size} quiet:${quiet} scale:${scale} widthPx:${widthPx} (widthBytes:${widthBytes}) height:${height} bands:${bands.length}`)
  return { bands, widthBytes, height, inline }
}

// Envia as bandas para a COM via raster-send (escrita contígua), pausa entre
// elas e finaliza com alinhamento à esquerda + um avanço. Lança em erro.
async function sendLogoBands(comPort, bands, opts = {}) {
  const delayMs = Math.max(0, Number(opts.delayMs ?? BAND_DELAY_MS))
  for (let i = 0; i < bands.length; i++) {
    await sendRaster(comPort, bands[i], { widthBytes: LOGO_WIDTH_B })
    if (i < bands.length - 1) await _delay(delayMs)
  }
  await _delay(delayMs)
  await sendRaster(comPort, Buffer.concat([_ALIGN_LT, _LF, _LF])) // separa do texto
}

// Envia bandas QR: ESC @ + ESC a 1 UMA vez antes da 1ª banda, depois SÓ bandas
// GS v 0 (sem re-init/realinhamento que tira a impressora do modo raster no meio).
// Antes de cada escrita, valida que o widthBytes do header bate com o comprimento
// real de cada linha de dados da banda — lança se divergir (causa do lixo/desync).
async function sendQrBands(comPort, bands, opts = {}) {
  const delayMs = Math.max(0, Number(opts.delayMs ?? BAND_DELAY_MS))
  const expectWidthBytes = opts.widthBytes != null ? Number(opts.widthBytes) : null

  await sendRaster(comPort, Buffer.concat([_ESC_INIT, _ALIGN_CT])) // init + centraliza (1x)

  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]
    const headerWidthBytes = band[4] | (band[5] << 8)
    const rows = band[6] | (band[7] << 8)
    const dataLen = band.length - 8 // 8 = header GS v 0 (sem ESC @ / ESC a)
    const rowLengthBytes = rows > 0 ? dataLen / rows : NaN
    if (
      headerWidthBytes !== rowLengthBytes ||
      !Number.isInteger(rowLengthBytes) ||
      (expectWidthBytes != null && headerWidthBytes !== expectWidthBytes)
    ) {
      throw new Error(
        `[qr] banda ${i} mismatch: headerWidthBytes=${headerWidthBytes} rowLengthBytes=${rowLengthBytes} rows=${rows} dataLen=${dataLen} esperado=${expectWidthBytes}`
      )
    }
    console.log(`[qr] banda ${i}: headerWidthBytes=${headerWidthBytes} === rowLengthBytes=${rowLengthBytes} (rows=${rows})`)
    await sendRaster(comPort, band, { widthBytes: headerWidthBytes })
    if (i < bands.length - 1) await _delay(delayMs)
  }

  await _delay(delayMs)
  await sendRaster(comPort, Buffer.concat([_ALIGN_LT, _LF, _LF])) // separa do texto
}

module.exports = { getLogoBuffer, buildLogoBands, buildQrBands, sendLogoBands, sendQrBands }
