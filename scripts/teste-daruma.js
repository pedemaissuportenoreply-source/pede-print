'use strict'
// Teste de papel do CABEÇALHO na Daruma pela fila do Windows (RAW, sem Electron).
//   node scripts/teste-daruma.js ["Nome da fila"] [--pausa 4000] [--pausa-vias 500] [--so A,B,C,D,E,F,G,H]
// Cada teste é um job separado, terminado no corte Daruma (GS V 1 + ESC m):
//   A) cabeçalho com os bytes do perfil GENÉRICO (ESC @ no meio, como na 1.7.10)
//   B) cabeçalho com os bytes do perfil DARUMA (ESC ! 0 / ESC E 0 / ESC - 0 no meio)
//   C) cabeçalho Daruma SEM os comandos que diferem do genérico
//   D) igual ao B, mas enviado 500 ms depois do corte anterior (tempo da 1.7.13)
//   E) cabeçalho Daruma com os dados REAIS do tenant (config do app, com acentos)
//   F) E sem acentos (ASCII)
//   G) via cozinha real + via cliente real, 2 jobs com --pausa-vias ms (500 = 1.7.13)
//   H) via cliente real completa, sozinha (isola tamanho x sequência)
// Tenant real: %APPDATA%\pede-print\config.json + número/bairro/cidade do dump
// tmp/printer-in-*.json mais recente, quando existir. Nada disso vai pro repositório.
// Entre um teste e outro: --pausa ms (default 4000).
process.env.TZ = 'America/Fortaleza'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const printer = require('../printer')
const profiles = require('../printer-profiles')
const diag = require('../src/diagnostico-daruma')
const { DOCUMENTOS } = require('../test/fixtures/gerar-daruma')

const args = process.argv.slice(2)
const opt = (k, def) => { const i = args.indexOf(k); return i > -1 ? args.splice(i, 2)[1] : def }
const pausa = parseInt(opt('--pausa', '4000'), 10)
const pausaVias = parseInt(opt('--pausa-vias', '500'), 10)
const so = String(opt('--so', 'A,B,C,D,E,F,G,H')).toUpperCase().split(',')
const fila = args[0] || 'Daruma DR800 Spooler (Copiar 1)'

const { RESET_DARUMA, CORTE, rotulo } = diag

function usarPerfilDaruma() {
  const prof = profiles.getCatalog().find((p) => p.name === 'Daruma DR800')
  const log = console.log; console.log = () => {}
  printer.setActiveProfile(prof)
  console.log = log
  printer.setPrintParams({ encoding: prof.encoding, codepage: prof.codepageEscT })
}
function cabecalho(familia) {
  usarPerfilDaruma()
  const log = console.log; console.log = () => {}
  const c = printer.buildReceiptBuffer(DOCUMENTOS.delivery, 48, { familia }).client
  console.log = log
  return diag.ateData(c)
}
function semDiferentes(buf) {
  const partes = []
  let i = 0, j
  while ((j = buf.indexOf(RESET_DARUMA, i)) !== -1) { partes.push(buf.subarray(i, j)); i = j + RESET_DARUMA.length }
  partes.push(buf.subarray(i))
  return Buffer.concat(partes)
}

function tenantReal() {
  let cfg = {}, extra = {}
  try { const c = require(path.join(process.env.APPDATA || '', 'pede-print', 'config.json')); cfg = c.config || c } catch { /* sem app instalado */ }
  try {
    const tmp = path.join(__dirname, '..', 'tmp')
    const dump = fs.readdirSync(tmp).filter((f) => /^printer-in-.*\.json$/.test(f)).map((f) => path.join(tmp, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    if (dump) extra = JSON.parse(fs.readFileSync(dump, 'utf8'))
  } catch { /* sem dump */ }
  return diag.tenantDaConfig(cfg, extra)
}
let _reais = null
const reais = () => {
  if (!_reais) { usarPerfilDaruma(); _reais = diag.montarTestes(printer, tenantReal()) }
  return _reais
}

const TESTES = {
  A: () => Buffer.concat([cabecalho('generica'), rotulo('TESTE A - bytes GENERICO'), CORTE]),
  B: () => Buffer.concat([cabecalho('daruma'), rotulo('TESTE B - bytes DARUMA'), CORTE]),
  C: () => Buffer.concat([semDiferentes(cabecalho('daruma')), rotulo('TESTE C - DARUMA sem ESC ! 0/E 0/- 0'), CORTE]),
  D: () => Buffer.concat([cabecalho('daruma'), rotulo('TESTE D - DARUMA 500ms apos o corte'), CORTE]),
  E: () => reais().E,
  F: () => reais().F,
  H: () => reais().H,
}

// RAW na fila via winspool (o node-printer do app é compilado pro Electron).
const PS = `param($fila, $arq)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class RawPrn {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr h, int l, DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static void Send(string fila, byte[] b) {
    IntPtr h; if (!OpenPrinter(fila, out h, IntPtr.Zero)) throw new Exception("OpenPrinter falhou: " + Marshal.GetLastWin32Error());
    try {
      var di = new DOCINFO { pDocName = "teste-daruma", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("StartDocPrinter falhou: " + Marshal.GetLastWin32Error());
      StartPagePrinter(h); int w; WritePrinter(h, b, b.Length, out w); EndPagePrinter(h); EndDocPrinter(h);
      if (w != b.Length) throw new Exception("WritePrinter: " + w + "/" + b.Length);
    } finally { ClosePrinter(h); }
  }
}
"@
[RawPrn]::Send($fila, [IO.File]::ReadAllBytes($arq))`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teste-daruma-'))
const ps1 = path.join(dir, 'raw.ps1')
fs.writeFileSync(ps1, PS)
function enviar(nome, buf) {
  const arq = path.join(dir, `teste-${nome}.bin`)
  fs.writeFileSync(arq, buf)
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, fila, arq], { stdio: 'inherit' })
  console.log(`[teste-daruma] ${nome}: ${buf.length} bytes -> "${fila}" (${arq})`)
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  let enviados = 0
  for (const k of ['A', 'B', 'C'].filter((x) => so.includes(x))) {
    if (enviados++) await espera(pausa)
    enviar(k, TESTES[k]())
  }
  if (so.includes('D')) {
    if (enviados++) await espera(500)
    enviar('D', TESTES.D())
  }
  for (const k of ['E', 'F', 'H'].filter((x) => so.includes(x))) {
    if (enviados++) await espera(pausa)
    enviar(k, TESTES[k]())
  }
  if (so.includes('G')) {
    if (enviados++) await espera(pausa)
    const [cozinha, cliente] = reais().G
    enviar('G-cozinha', cozinha)
    await espera(pausaVias)
    enviar('G-cliente', cliente)
  }
})().catch((e) => { console.error('[teste-daruma] erro:', e.message || e); process.exit(1) })
