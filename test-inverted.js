'use strict'

// Diagnóstico: descobre o comando de INVERTIDO (branco-no-preto) aceito pela
// Daruma DR800. Comandos de controle = bytes CRUS; só o texto passa por cp1252.
// Uso: node test-inverted.js [COM7]

const iconv = require('iconv-lite')
const { sendToComPort } = require('./src/serial-print')

const COM  = (process.argv[2] || process.env.PEDE_PRINT_COM || 'COM8').trim()
const COLS = 48
const TXT  = 'TESTE INVERTIDO 123'

const ESC_INIT = Buffer.from([0x1b, 0x40])             // ESC @
const CHARSET  = Buffer.from([0x1b, 0x74, 0x07])       // ESC t 7 — cp1252
const CUT      = Buffer.from([0x1d, 0x56, 0x41, 0x00]) // GS V A 0
const FEED     = Buffer.from('\n'.repeat(4), 'ascii')
const LF       = Buffer.from([0x0a])

const GS_B_ON   = Buffer.from([0x1d, 0x42, 0x01])      // GS B 1
const GS_B_OFF  = Buffer.from([0x1d, 0x42, 0x00])      // GS B 0
const ESCBR_ON  = Buffer.from([0x1b, 0x7b, 0x01])      // ESC { 1
const ESCBR_OFF = Buffer.from([0x1b, 0x7b, 0x00])      // ESC { 0
const BIG_ON    = Buffer.from([0x1b, 0x21, 0x30])      // ESC ! double H+W
const NORMAL    = Buffer.from([0x1b, 0x21, 0x00])      // ESC ! normal

const txt   = (s) => iconv.encode(String(s), 'cp1252') // só texto visível
const ascii = (s) => Buffer.from(s + '\n', 'ascii')    // labels ASCII puro
const pad48 = (s) => { const t = String(s).slice(0, COLS); return t + ' '.repeat(COLS - t.length) }

const segs = [ESC_INIT, CHARSET]

// 1) GS B 1 / GS B 0
segs.push(ascii('== GS B 1 (1D 42 01) =='), GS_B_ON, txt(TXT), GS_B_OFF, LF, LF)

// 2) ESC { 1 / ESC { 0
segs.push(ascii('== ESC { 1 (1B 7B 01) =='), ESCBR_ON, txt(TXT), ESCBR_OFF, LF, LF)

// 3) GS B 1 com pad full-width (barra edge-to-edge)
segs.push(ascii('== GS B raw + full-width pad =='), GS_B_ON, txt(pad48(TXT)), GS_B_OFF, LF, LF)

// 4) Invertido + dupla-altura (ESC ! + GS B)
segs.push(ascii('== inverted + double height (ESC ! + GS B) =='), BIG_ON, GS_B_ON, txt(pad48(TXT)), GS_B_OFF, NORMAL, LF, LF)

// 5) ESC { + dupla-altura (alternativa de reverse)
segs.push(ascii('== ESC { 1 + double height =='), BIG_ON, ESCBR_ON, txt(pad48(TXT)), ESCBR_OFF, NORMAL, LF, LF)

segs.push(FEED, CUT)
const buf = Buffer.concat(segs)

console.log(`[test-inverted] porta: ${COM} | bytes: ${buf.length}`)
sendToComPort(COM, buf)
  .then(() => console.log('[test-inverted] OK — veja qual bloco saiu branco-no-preto'))
  .catch((err) => { console.error('[test-inverted] erro:', err); process.exit(1) })
