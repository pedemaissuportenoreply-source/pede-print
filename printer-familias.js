'use strict'

// Famílias de impressora: o que muda NO CUPOM por fabricante. O catálogo
// (printer-profiles.js) continua dono de corte/codepage/colunas por MODELO; aqui
// fica o comportamento de layout que o modelo não descreve.
//
// SÓ a família Daruma altera bytes. Genérica/Elgin/Epson/Bematech usam o caminho
// de sempre (byte-a-byte igual) — a tabela documenta o que cada uma suporta.
//
// Daruma (DR700/DR800/DR800H) no modo padrão dela:
//   • QR do motoboy não sai (nem GS ( k nem raster GS v 0): qrMotoboy=false,
//     o cupom traz "Motoboy: digite o número" + número do pedido.
//   • Corte GS V m n (função B, m=65/66 — o que o catálogo manda) é ignorado.
//     Aceita GS V 1 (função A, parcial, sem avanço) e ESC m (corte nativo
//     Daruma); como a função A não avança, vai FEED de 6 linhas antes.
//   • Tamanho duplo por ESC ! (0x10/0x30) não volta com ESC @: as linhas
//     seguintes herdavam a largura dupla — separador com outra largura, coluna
//     da direita deslocada, texto longo cortado. Daruma sai SEM tamanho duplo
//     (destaque por negrito) e com toda linha dentro das colunas do perfil.
const FAMILIAS = {
  generica: {
    nome: 'Genérica ESC/POS', qr: 'nativo', qrMotoboy: true, tamanhoDuplo: true, reverso: true,
    corte: null /* do perfil */, feedAntesCorte: 4,
    colunas: { 80: { A: 48, B: 64 }, 58: { A: 32, B: 42 } },
  },
  epson: {
    nome: 'Epson', qr: 'nativo', qrMotoboy: true, tamanhoDuplo: true, reverso: true,
    corte: null, feedAntesCorte: 4,
    colunas: { 80: { A: 48, B: 64 }, 58: { A: 32, B: 42 } },
  },
  elgin: {
    nome: 'Elgin', qr: 'nativo', qrMotoboy: true, tamanhoDuplo: true, reverso: true,
    corte: null, feedAntesCorte: 4,
    colunas: { 80: { A: 48, B: 64 }, 58: { A: 32, B: 42 } },
  },
  bematech: {
    nome: 'Bematech', qr: 'nativo', qrMotoboy: true, tamanhoDuplo: true, reverso: true,
    corte: null, feedAntesCorte: 4,
    colunas: { 80: { A: 48, B: 64 }, 58: { A: 32, B: 42 } },
  },
  daruma: {
    nome: 'Daruma', qr: 'nenhum', qrMotoboy: false, tamanhoDuplo: false, reverso: false,
    corte: [0x1d, 0x56, 0x01, 0x1b, 0x6d], // GS V 1 + ESC m — sem byte nulo
    feedAntesCorte: 6,
    colunas: { 80: { A: 48 }, 58: { A: 32 } },
  },
}

const RE_DARUMA_NOME = /daruma|\bdr[\s-]?(700|800)/i

/** Nome do Windows/porta/fabricante indica Daruma? (única auto-detecção por nome) */
function nomeEhDaruma(nome) {
  return RE_DARUMA_NOME.test(String(nome || ''))
}

/**
 * Família do alvo. Perfil EXPLÍCITO (escolhido/roteado) manda pela marca; sem
 * perfil explícito, o nome da impressora só promove a Daruma — qualquer outra
 * fica na Genérica (saída de sempre).
 */
function familiaDe(profile, printerName, { explicito = false } = {}) {
  const marca = String((profile && (profile.brand || profile.name)) || '').toLowerCase()
  if (/daruma/.test(marca)) return 'daruma'
  if (!explicito && nomeEhDaruma(printerName)) return 'daruma'
  if (explicito) {
    if (/epson/.test(marca)) return 'epson'
    if (/elgin/.test(marca)) return 'elgin'
    if (/bematech/.test(marca)) return 'bematech'
  }
  return 'generica'
}

module.exports = { FAMILIAS, familiaDe, nomeEhDaruma }
