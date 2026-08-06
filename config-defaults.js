'use strict'

// URL do backend: FIXA para o cliente final. O campo de URL saiu do fluxo normal
// de onboarding — quem instala o agente não digita endereço nenhum.
//
// O override existe SÓ para desenvolvimento e fica atrás de um gesto escondido na
// UI (Ctrl+Shift+D ou 5 cliques na versão). Fora dele, `resolveServerUrl()` sempre
// devolve a URL de produção em https — o cliente nunca cai em http por engano.

// Host do BACKEND (REST + Socket.io), não do painel web. `app.pedeplus.com.br`
// serve o SPA e responde HTML em /api/v1/* — apontar pra lá quebra o login.
// Mesma origem que o frontend usa em produção (pedemais-frontend/src/config/api.ts:6).
const PROD_URL = 'https://api.pedeplus.com.br'
const DEV_URL_DEFAULT = 'http://localhost:3000'

// Hosts onde http:// é aceitável (dev local). Qualquer outro host é forçado a https.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

function _isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  if (LOCAL_HOSTS.has(h)) return true
  // Rede local (LAN) — típico de teste em outra máquina do restaurante.
  return /^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)
    || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)
}

// Normaliza uma URL de servidor: tira barras finais e PROMOVE http->https quando
// o host não é local. Devolve null se a entrada não é uma URL utilizável.
function normalizeServerUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  // Esquema explícito diferente de http/https é rejeitado ANTES do prepend: senão
  // 'ftp://x.com' viraria 'https://ftp://x.com' e o host sairia como 'ftp'.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  if (hasScheme && !/^https?:\/\//i.test(text)) return null
  let u
  try {
    u = new URL(hasScheme ? text : 'https://' + text)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  // Nunca deixar um host público em http: promove pra https em silêncio.
  if (u.protocol === 'http:' && !_isLocalHost(u.hostname)) {
    u.protocol = 'https:'
  }
  return u.origin
}

// URL efetiva do backend. `config` é o objeto do electron-store.
// Só respeita o override quando devMode está LIGADO explicitamente e a URL é válida.
function resolveServerUrl(config) {
  if (config && config.devMode === true) {
    const override = normalizeServerUrl(config.devServerUrl)
    if (override) return override
  }
  return PROD_URL
}

// A URL é de produção (ou seja: o cliente está no caminho normal)?
function isProdUrl(config) {
  return resolveServerUrl(config) === PROD_URL
}

module.exports = { PROD_URL, DEV_URL_DEFAULT, normalizeServerUrl, resolveServerUrl, isProdUrl }
