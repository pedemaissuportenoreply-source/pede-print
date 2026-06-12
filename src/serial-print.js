// Envio confiável de jobs ESC/POS para impressoras em porta serial virtual (COM).
//
// Motivo: a Daruma DR800 em porta USB virtual (COM7) através do printDirect RAW
// recebe o buffer de uma vez; o buffer interno da impressora começa a processar
// antes de todos os bytes chegarem e descarta o início (cabeçalho + itens),
// imprimindo apenas as últimas linhas.
//
// Solução: escrever diretamente na porta COM em blocos pequenos (32 bytes) com
// um pequeno atraso (50ms) entre cada bloco, dando tempo para a impressora
// drenar o buffer. ESC @ permanece no início do buffer; NÃO enviamos null bytes.

const fs = require('fs');

const CHUNK_SIZE = 32;
const CHUNK_DELAY_MS = 50;
const BAUD_RATE = 9600;
const OPEN_RETRIES = 3;
const OPEN_BACKOFF_MS = 500;
const POST_CLOSE_DELAY_MS = 300; // dá tempo do Windows liberar o handle da COM

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockError(err) {
  const code = err && err.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function isComPort(name) {
  return typeof name === 'string' && /^COM\d+$/i.test(name.trim());
}

// Normaliza para o caminho de device do Windows. COM10+ exige o prefixo \\.\,
// e ele também é válido para COM1-9, então usamos sempre.
function devicePath(name) {
  return `\\\\.\\${name.trim().toUpperCase()}`;
}

// Caminho preferido: pacote 'serialport' (configura baud rate corretamente).
// Carregado sob demanda para não quebrar o app caso o módulo nativo não exista.
async function sendViaSerialport(comName, buffer) {
  let SerialPort;
  try {
    ({ SerialPort } = require('serialport'));
  } catch (e) {
    return false; // módulo indisponível -> usa fallback
  }

  const port = new SerialPort({
    path: comName.trim().toUpperCase(),
    baudRate: BAUD_RATE,
    autoOpen: false,
  });

  // Abre com retry em EPERM/EBUSY (porta ainda travada do job anterior)
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        port.open((err) => (err ? reject(err) : resolve()));
      });
      break;
    } catch (err) {
      if (isLockError(err) && attempt < OPEN_RETRIES) {
        await delay(OPEN_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }

  try {
    for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
      const chunk = buffer.subarray(i, i + CHUNK_SIZE);
      await new Promise((resolve, reject) => {
        port.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
      await new Promise((resolve, reject) => {
        port.drain((err) => (err ? reject(err) : resolve()));
      });
      await delay(CHUNK_DELAY_MS);
    }
  } finally {
    // Garante fechamento completo do handle antes de resolver
    await new Promise((resolve) => {
      if (!port.isOpen) return resolve();
      port.close(() => resolve());
    });
  }

  return true;
}

// Fallback sem dependência nativa: escreve direto no device \\.\COMx.
// Para portas USB CDC virtuais (como a DR800) o baud rate é ignorado, então
// a escrita direta em blocos pequenos com atraso resolve a perda de início.
async function sendViaDevice(comName, buffer) {
  let fd;
  for (let attempt = 1; ; attempt++) {
    try {
      fd = fs.openSync(devicePath(comName), 'r+');
      break;
    } catch (err) {
      if (isLockError(err) && attempt < OPEN_RETRIES) {
        await delay(OPEN_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
  try {
    for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
      const chunk = buffer.subarray(i, i + CHUNK_SIZE);
      let written = 0;
      while (written < chunk.length) {
        written += fs.writeSync(fd, chunk, written, chunk.length - written);
      }
      fs.fsyncSync(fd);
      await delay(CHUNK_DELAY_MS);
    }
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* já fechado */ }
  }
}

// Executa o job: serialport (preferido) ou device direto. Fecha sempre antes
// de resolver e dá um respiro pro Windows liberar o handle.
async function _runJob(comName, buffer) {
  try {
    const ok = await sendViaSerialport(comName, buffer);
    if (!ok) await sendViaDevice(comName, buffer);
  } finally {
    await delay(POST_CLOSE_DELAY_MS);
  }
}

// Fila: garante que apenas um job abra a COM por vez (mutex via promise chain).
let _queue = Promise.resolve();

// Envia o buffer para uma porta COM de forma confiável (serializado + chunked).
function sendToComPort(comName, buffer) {
  const job = _queue.then(() => _runJob(comName, buffer));
  // Mantém a cadeia viva mesmo se este job falhar, sem propagar o erro adiante.
  _queue = job.catch(() => {});
  return job;
}

module.exports = { isComPort, sendToComPort };
