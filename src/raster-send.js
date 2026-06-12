'use strict'

// Envio de blocos RASTER (GS v 0) para a Daruma DR800 em porta COM.
//
// Por que separado do sender de texto (src/serial-print.js): o sender de texto
// fatia em blocos de 32 bytes com atraso entre eles. Isso funciona para TEXTO,
// mas QUEBRA o raster: GS v 0 coloca a impressora num estado de recepção de
// comprimento fixo (widthBytes*height bytes). Fatias de 32 bytes (não múltiplas
// de widthBytes) cortam no meio da linha e os atrasos entre blocos fazem o
// receptor de raster expirar/dessincronizar — a impressora volta pro modo texto
// e cospe o restante (0xFF) como "ÿ".
//
// Solução: escrever o buffer inteiro em UMA escrita contígua, sem atrasos.
// NÃO altera o sender de texto; é exclusivo para imagem.

const fs = require('fs')

const BAUD_RATE = 9600
const OPEN_RETRIES = 3
const OPEN_BACKOFF_MS = 500
const POST_CLOSE_DELAY_MS = 300

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const isLockError = (e) => e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')
const devicePath = (name) => `\\\\.\\${name.trim().toUpperCase()}`

// serialport (preferido): escreve o buffer COMPLETO de uma vez, drena, fecha.
async function viaSerialport(comName, buffer) {
  let SerialPort
  try { ({ SerialPort } = require('serialport')) } catch { return false }

  const port = new SerialPort({ path: comName.trim().toUpperCase(), baudRate: BAUD_RATE, autoOpen: false })
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())))
      break
    } catch (e) {
      if (isLockError(e) && attempt < OPEN_RETRIES) { await delay(OPEN_BACKOFF_MS); continue }
      throw e
    }
  }
  try {
    await new Promise((res, rej) => port.write(buffer, (e) => (e ? rej(e) : res())))   // 1 escrita contígua
    await new Promise((res, rej) => port.drain((e) => (e ? rej(e) : res())))
  } finally {
    await new Promise((res) => (port.isOpen ? port.close(() => res()) : res()))
  }
  return true
}

// Fallback device \\.\COMx: writeSync do buffer inteiro (loop só p/ escrita
// parcial do SO), um único fsync no fim, SEM atraso entre pedaços.
async function viaDevice(comName, buffer) {
  let fd
  for (let attempt = 1; ; attempt++) {
    try { fd = fs.openSync(devicePath(comName), 'r+'); break }
    catch (e) {
      if (isLockError(e) && attempt < OPEN_RETRIES) { await delay(OPEN_BACKOFF_MS); continue }
      throw e
    }
  }
  try {
    let written = 0
    while (written < buffer.length) {
      written += fs.writeSync(fd, buffer, written, buffer.length - written)
    }
    fs.fsyncSync(fd)
  } finally {
    try { fs.closeSync(fd) } catch { /* já fechado */ }
  }
}

// Envia um bloco raster cru, contíguo. widthBytes só para log/validação.
async function sendRaster(comName, buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('sendRaster: buffer nao e Buffer')
  const { widthBytes } = opts
  const head24 = [...buffer.subarray(0, 24)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  console.log(`[raster-send] ${comName} | bytes: ${buffer.length} | modo: escrita-unica-contigua${widthBytes ? ` | widthBytes=${widthBytes}` : ''}`)
  console.log('[raster-send] primeiros 24 bytes:', head24)
  try {
    const ok = await viaSerialport(comName.trim(), buffer)
    console.log('[raster-send] via:', ok ? 'serialport (write unico)' : 'device \\\\.\\COM (writeSync unico)')
    if (!ok) await viaDevice(comName.trim(), buffer)
  } finally {
    await delay(POST_CLOSE_DELAY_MS)
  }
}

module.exports = { sendRaster }
