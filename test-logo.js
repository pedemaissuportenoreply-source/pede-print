'use strict'

// Imprime um LOGO real na Daruma DR800 via GS v 0 m=0 (caminho comprovado pela
// barra sólida). Pipeline sharp determinístico -> raw 1 byte/px -> pack 1-bit
// MSB-first, pixel preto (0) seta o bit. Uso: node test-logo.js [COM7]

const fs = require('fs')
const sharp = require('sharp')
const { sendRaster } = require('./src/raster-send') // raster = escrita contígua (NÃO o sender de texto)

// ── Config ──────────────────────────────────────────────────────────────────
const LOGO_PATH = process.env.PEDE_LOGO || './logo-test.png' // arquivo local ou URL
const COM       = (process.argv[2] || process.env.PEDE_PRINT_COM || 'COM8').trim()
const WIDTH_PX  = 384            // múltiplo de 8 (384/8 = 48 widthBytes)
const WIDTH_BYTES = WIDTH_PX / 8 // 48
const THRESHOLD = Number(process.env.PEDE_LOGO_THRESHOLD || 128) // 0..255
const BAND_HEIGHT = Math.max(1, Number(process.env.PEDE_LOGO_BAND || 24)) // linhas por banda
const BAND_DELAY_MS = 60         // pausa entre bandas (cada uma é um GS v 0 completo)

const ESC_INIT = Buffer.from([0x1b, 0x40])             // ESC @ reset
const ALIGN_CT = Buffer.from([0x1b, 0x61, 0x01])       // ESC a 1 — centraliza
const ALIGN_LT = Buffer.from([0x1b, 0x61, 0x00])       // ESC a 0 — esquerda
const CUT      = Buffer.from([0x1d, 0x56, 0x41, 0x00]) // GS V A 0
const FEED     = Buffer.from('\n'.repeat(4), 'ascii')
const LF       = Buffer.from([0x0a])

async function main() {
  if (!/^https?:\/\//i.test(LOGO_PATH) && !fs.existsSync(LOGO_PATH)) {
    throw new Error('logo nao encontrado: ' + LOGO_PATH)
  }

  // Pipeline determinístico: fundo branco opaco (sem alpha), 1 canal, 1 byte/px,
  // largura exata 384, já binarizado (0 ou 255) pelo threshold.
  const { data: raw, info } = await sharp(LOGO_PATH)
    .resize({ width: WIDTH_PX, fit: 'contain', background: '#fff' })
    .flatten({ background: '#fff' })
    .greyscale()
    .threshold(THRESHOLD)
    .raw()
    .toBuffer({ resolveWithObject: true })

  const w = info.width   // 384
  const h = info.height
  const channels = info.channels // 1
  if (w !== WIDTH_PX) throw new Error(`largura inesperada: ${w} != ${WIDTH_PX}`)
  if (channels !== 1) throw new Error(`channels inesperado: ${channels} != 1`)

  // Pack 1-bit: MSB-first; pixel 0 (preto) -> bit 1. Padding final = branco (0).
  const expected = WIDTH_BYTES * h
  const packed = Buffer.alloc(expected, 0x00)
  for (let y = 0; y < h; y++) {
    const srcOff = y * w
    const dstOff = y * WIDTH_BYTES
    for (let x = 0; x < w; x++) {
      if (raw[srcOff + x] === 0) packed[dstOff + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }

  if (packed.length !== expected) {
    throw new Error(`raster mismatch: actual=${packed.length} expected=${expected} (wB=${WIDTH_BYTES} h=${h})`)
  }

  // GS v 0 grande estoura o receptor da DR800. Fatia em BANDAS horizontais:
  // cada banda é um GS v 0 COMPLETO (header + dados) — vários "retângulos"
  // empilhados, com pausa entre eles (seguro: cada um é comando autossuficiente).
  const bandCount = Math.ceil(h / BAND_HEIGHT)
  console.log(`[test-logo] widthPx=${w} height=${h} widthBytes=${WIDTH_BYTES} threshold=${THRESHOLD}`)
  console.log(`[test-logo] bandas=${bandCount} | linhasPorBanda=${BAND_HEIGHT} (última pode ser menor)`)

  const header = (rows) => Buffer.from([
    0x1d, 0x76, 0x30, 0x00,                          // GS v 0 m=0
    WIDTH_BYTES & 0xff, (WIDTH_BYTES >> 8) & 0xff,    // widthBytes = 48
    rows & 0xff, (rows >> 8) & 0xff,                  // altura desta banda
  ])

  const delay = (ms) => new Promise((r) => setTimeout(r, ms))

  for (let bi = 0; bi < bandCount; bi++) {
    const y0   = bi * BAND_HEIGHT
    const rows = Math.min(BAND_HEIGHT, h - y0)        // última banda = resto
    const slice = packed.subarray(y0 * WIDTH_BYTES, (y0 + rows) * WIDTH_BYTES)
    if (slice.length !== WIDTH_BYTES * rows) {
      throw new Error(`banda ${bi}: ${slice.length} != ${WIDTH_BYTES * rows}`)
    }
    // ESC a 1 (centro) só na 1ª banda; persiste na impressora p/ as seguintes.
    const pre = bi === 0 ? [ESC_INIT, ALIGN_CT] : []
    const buf = Buffer.concat([...pre, header(rows), slice])
    console.log(`[test-logo] banda ${bi + 1}/${bandCount} | rows=${rows} | dataBytes=${WIDTH_BYTES * rows} | bufBytes=${buf.length}`)
    await sendRaster(COM, buf, { widthBytes: WIDTH_BYTES }) // 1 escrita contígua, sem chunk interno
    if (bi < bandCount - 1) await delay(BAND_DELAY_MS)
  }

  // Finaliza: volta alinhamento à esquerda, alimenta e corta.
  await delay(BAND_DELAY_MS)
  await sendRaster(COM, Buffer.concat([ALIGN_LT, LF, FEED, CUT]))
  console.log('[test-logo] OK — confira o cupom')
}

main().catch((err) => { console.error('[test-logo] erro:', err.message); process.exit(1) })
