'use strict'

// Diagnóstico: imprime a mesma palavra acentuada sob várias combinações de
// ESC t <n> + encoding iconv, para descobrir qual code page a DR800 usa.
// Uso: node test-codepage.js [COM7]

const iconv = require('iconv-lite')
const { sendToComPort } = require('./src/serial-print')

const COM = (process.argv[2] || process.env.PEDE_PRINT_COM || 'COM8').trim()
const WORD = 'Porção Camarão Refeição'

const ESC_INIT = Buffer.from([0x1b, 0x40])             // ESC @ — init
const CUT      = Buffer.from([0x1d, 0x56, 0x41, 0x00]) // GS V A 0 — full cut
const FEED      = Buffer.from('\n'.repeat(4), 'ascii')
const ascii    = (s) => Buffer.from(s + '\n', 'ascii')
const charset  = (n) => Buffer.from([0x1b, 0x74, n])

// (n, encoding)
const CANDIDATES = [
  [2, 'cp850'],
  [3, 'cp850'],
  [3, 'cp860'],
  [4, 'cp860'],
  [8, 'cp860'],
  [5, 'cp858'],
  [6, 'cp858'],
  [7, 'cp1252'],
  [16, 'cp1252'],
  [0, 'cp437'],
  [1, 'cp850'],
  // Daruma-specific
  [8, 'cp860'],
  [9, 'cp860'],
]

const segs = [ESC_INIT]
for (const [n, enc] of CANDIDATES) {
  segs.push(ascii(`== ESC t ${n} + ${enc} ==`))
  segs.push(charset(n))
  segs.push(iconv.encode(WORD + '\n', enc))
  segs.push(ascii(''))
}
segs.push(FEED, CUT)

const buf = Buffer.concat(segs)

console.log(`[test-codepage] porta: ${COM} | candidatos: ${CANDIDATES.length} | bytes: ${buf.length}`)
sendToComPort(COM, buf)
  .then(() => console.log('[test-codepage] OK — confira o cupom'))
  .catch((err) => { console.error('[test-codepage] erro:', err); process.exit(1) })
