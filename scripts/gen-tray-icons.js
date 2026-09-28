'use strict'

// Gera os ícones da bandeja a partir de build/icon.png (o mesmo do atalho):
// logo reduzido + bolinha de status no canto inferior direito.
// Rodar uma vez (`node scripts/gen-tray-icons.js`) e commitar os PNGs — o app
// não depende deste script em runtime.

const path = require('path')
const fs = require('fs')
const Jimp = require('jimp')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon.png')
const OUT = path.join(ROOT, 'assets', 'tray')

const STATES = {
  connected:    { color: [0x22, 0xC5, 0x5E], desat: 0 },
  reconnecting: { color: [0xF5, 0xC2, 0x11], desat: 0 },
  disconnected: { color: [0x88, 0x88, 0x88], desat: 60 },
}
const BORDER = [0x1A, 0x1A, 0x1A]

// Redução em passos de 2x (bilinear): antialias decente sem depender do sharp.
function downscale(img, size) {
  const out = img.clone()
  while (out.bitmap.width / 2 >= size) out.resize(out.bitmap.width / 2, out.bitmap.height / 2, Jimp.RESIZE_BILINEAR)
  if (out.bitmap.width !== size) out.resize(size, size, Jimp.RESIZE_BILINEAR)
  return out
}

// Bolinha com borda escura, supersampling 4x por pixel p/ borda suave.
function drawDot(img, size, color) {
  const d = Math.round(size * 0.4)
  const r = d / 2
  const cx = size - r
  const cy = size - r
  const inner = r - Math.max(1, size / 16)
  const SS = 4
  for (let y = size - d; y < size; y++) {
    for (let x = size - d; x < size; x++) {
      let cov = 0
      let fill = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const dist = Math.hypot(px - cx, py - cy)
          if (dist <= r) { cov++; if (dist <= inner) fill++ }
        }
      }
      if (!cov) continue
      const a = cov / (SS * SS)
      const f = fill / cov
      const c = [0, 1, 2].map((i) => color[i] * f + BORDER[i] * (1 - f))
      const idx = img.getPixelIndex(x, y)
      const b = img.bitmap.data
      const da = b[idx + 3] / 255
      const oa = a + da * (1 - a)
      for (let i = 0; i < 3; i++) b[idx + i] = Math.round((c[i] * a + b[idx + i] * da * (1 - a)) / (oa || 1))
      b[idx + 3] = Math.round(oa * 255)
    }
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const src = await Jimp.read(SRC)
  for (const [state, { color, desat }] of Object.entries(STATES)) {
    for (const [size, suffix] of [[16, ''], [32, '@2x']]) {
      const img = downscale(src, size)
      if (desat) img.color([{ apply: 'desaturate', params: [desat] }])
      drawDot(img, size, color)
      const file = path.join(OUT, `tray-${state}${suffix}.png`)
      await img.writeAsync(file)
      console.log('ok', path.relative(ROOT, file))
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
