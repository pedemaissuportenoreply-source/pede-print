'use strict'

// Autenticação do agente. Dois caminhos:
//   1. PAREAMENTO POR CÓDIGO (principal): código de 6 dígitos do painel ->
//      POST /pede-print/pareamento/resgatar -> AgenteToken opaco (`pa_…`).
//   2. Legado: email+senha do Pede+ -> access token (JWT) ->
//      POST /print-agent/provision -> apiKey do agente.
//
// A apiKey é o que importa: o socket continua conectando por apiKey, porque é
// isso que faz o gateway marcar isPrintAgent (realtime.gateway.ts:56) e ligar a
// fila receipt:print/print:ack. O JWT é usado SÓ para provisionar e é descartado
// depois — nada aqui altera socket.js.
//
// 2FA: POST /auth/login pode responder { requiresOtp, tempToken, email } em vez
// dos tokens (auth.service.ts:218). O fluxo devolve esse estado pro assistente,
// que pede o código e chama verifyOtp() para completar.

const { restBase } = require('./printer-profiles')

const TIMEOUT_MS = 15_000

async function _post(base, path, body, headers) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    })
    const contentType = String(res.headers.get('content-type') || '')
    const raw = await res.text().catch(() => '')
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { /* não-JSON: ver isHtml abaixo */ }
    // Um 200 com HTML significa que a URL não é o backend (caiu no SPA, num proxy
    // ou num portal de rede). Sem isto, o corpo vira `null` e o erro sai como
    // "sem token", escondendo a causa real.
    const isHtml = data === null && (/text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw))
    return { status: res.status, ok: res.ok, data, contentType, isHtml }
  } finally {
    clearTimeout(timer)
  }
}

// Erro para respostas que não são JSON do backend (HTML do SPA, proxy, etc.).
const WRONG_HOST_MSG =
  'O endereço configurado não é o servidor do Pede+ (respondeu HTML em vez de dados). '
  + 'Verifique a URL em Configurações avançadas.'

// Mensagem amigável a partir do status/corpo do backend. SUBSCRIPTION_EXPIRED
// chega como 403/402 (PlanoAtivoGuard) — nunca 401 — e merece texto próprio.
function _friendlyError(status, data) {
  const raw = data && (data.message || data.error)
  const msg = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
  if (status === 401) return 'E-mail ou senha incorretos.'
  if (status === 402 || status === 403) {
    if (/SUBSCRIPTION_EXPIRED|plano|assinatura/i.test(msg)) {
      return 'A assinatura do restaurante está vencida. Regularize no painel para usar a impressão.'
    }
    return msg || 'Acesso não permitido para esta conta.'
  }
  if (status === 429) return 'Muitas tentativas. Aguarde um instante e tente de novo.'
  if (status >= 500) return 'O servidor do Pede+ está indisponível. Tente novamente em instantes.'
  return msg || `Falha na conexão (HTTP ${status}).`
}

function _netError(err) {
  if (err && err.name === 'AbortError') return 'Tempo esgotado ao falar com o servidor.'
  return `Não foi possível conectar ao servidor: ${(err && err.message) || err}`
}

// ── Pareamento por CÓDIGO (caminho principal) ────────────────────────────────
//
// O admin gera um código de 6 dígitos no painel (Configurações → Impressoras) e
// digita aqui. O backend troca o código por um AgenteToken OPACO (prefixo `pa_`)
// com escopo só de impressão. Isto existe porque conta criada via Google não tem
// senha — o login por e-mail/senha simplesmente não funciona nessas contas.
//
// O token é guardado NO MESMO campo `apiKey` da config: o backend decide pelo
// prefixo quem valida (AgenteToken x apiKey legada), então socket.js, o catálogo
// de perfis e os setores continuam exatamente como estavam.
async function pairWithCode(serverUrl, codigo, dispositivo) {
  const base = restBase(serverUrl)
  if (!base) return { ok: false, message: 'URL do servidor inválida.' }
  const code = String(codigo ?? '').replace(/\D/g, '')
  if (code.length !== 6) return { ok: false, message: 'O código tem 6 dígitos.' }

  let r
  try {
    r = await _post(base, '/pede-print/pareamento/resgatar', {
      codigo: code,
      dispositivo: String(dispositivo || 'Computador').slice(0, 80),
    })
  } catch (e) { return { ok: false, message: _netError(e) } }

  if (r.isHtml) return { ok: false, message: WRONG_HOST_MSG }
  if (!r.ok || !r.data || !r.data.token) {
    if (r.status === 401 || r.status === 400) {
      const raw = r.data && (r.data.message || r.data.error)
      const msg = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
      return { ok: false, retry: true, message: msg || 'Código inválido ou expirado. Gere um novo no painel.' }
    }
    if (r.ok) return { ok: false, message: 'O servidor não devolveu o token do agente.' }
    return { ok: false, message: _friendlyError(r.status, r.data) }
  }

  return {
    ok: true,
    apiKey: r.data.token,
    apiKeyId: r.data.agenteId ?? null,
    tenant: r.data.tenant ?? null,
    estabelecimento: r.data.estabelecimento ?? (r.data.tenant && r.data.tenant.nome) ?? null,
  }
}

// "Trocar conta": revoga o AgenteToken no servidor (ele autentica com o próprio
// token). Best-effort — a limpeza LOCAL acontece de todo jeito.
async function revokeAgentToken(serverUrl, token) {
  const base = restBase(serverUrl)
  if (!base || !token) return { ok: false }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/pede-print/pareamento/meu`, {
      method: 'DELETE',
      headers: { 'x-agent-token': String(token) },
      signal: ctrl.signal,
    })
    return { ok: res.ok }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

// Troca o access token por uma apiKey de agente + dados do tenant.
async function provision(serverUrl, accessToken) {
  const base = restBase(serverUrl)
  const r = await _post(base, '/print-agent/provision', {}, { authorization: `Bearer ${accessToken}` })
  if (r.isHtml) return { ok: false, message: WRONG_HOST_MSG }
  if (!r.ok || !r.data || !r.data.apiKey) {
    if (r.ok) return { ok: false, message: 'O servidor não devolveu a chave da impressora.' }
    return { ok: false, message: _friendlyError(r.status, r.data) }
  }
  return { ok: true, apiKey: r.data.apiKey, apiKeyId: r.data.apiKeyId ?? null, tenant: r.data.tenant ?? null }
}

// Resultado comum de login/verifyOtp: provisiona quando já há accessToken.
// O contrato é { user, tenant, accessToken } no TOPO — o refreshToken é removido do
// corpo pelo AuthCookieInterceptor (vira cookie HttpOnly), então não vem aqui.
async function _afterTokens(serverUrl, data) {
  const accessToken = data && data.accessToken
  if (!accessToken) {
    // Diz QUAIS campos vieram: se o shape mudar no backend, o erro aponta o culpado
    // em vez de repetir "sem token".
    const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : 'nenhum'
    return { ok: false, message: `O servidor respondeu sem token de acesso (campos: ${keys}).` }
  }
  const prov = await provision(serverUrl, accessToken)
  if (!prov.ok) return prov
  // Nome do usuário só para a UI dizer "conectado como…". O JWT é descartado.
  return {
    ok: true,
    apiKey: prov.apiKey,
    apiKeyId: prov.apiKeyId,
    tenant: prov.tenant || (data.tenant ? { id: data.tenant.id, nome: data.tenant.nome } : null),
    userEmail: (data.user && data.user.email) || null,
  }
}

// Passo 1: email + senha.
//   sucesso        -> { ok:true, apiKey, tenant, userEmail }
//   2FA necessário -> { ok:false, requiresOtp:true, tempToken, email }
//   erro           -> { ok:false, message }
//
// `fingerprint` é o id estável desta instalação. Mandá-lo é o que ATIVA o 2FA no
// backend: o gate é `if (fingerprint && !bypassOtp)` (auth.service.ts:198) — sem o
// header, o servidor nem consulta dispositivoConfiavel e devolve token direto,
// pulando o 2FA de quem o tem ativo. Com ele, a 1ª entrada nesta máquina pede
// código e o verify-otp registra o dispositivo por 30 dias.
async function login(serverUrl, email, password, fingerprint) {
  const base = restBase(serverUrl)
  if (!base) return { ok: false, message: 'URL do servidor inválida.' }
  const mail = String(email ?? '').trim()
  if (!mail) return { ok: false, message: 'Informe o e-mail.' }
  if (!password) return { ok: false, message: 'Informe a senha.' }

  // Corpo EXATO do LoginDto (email + senha). O ValidationPipe global roda com
  // forbidNonWhitelisted: true — qualquer campo extra viraria 400.
  let r
  try {
    r = await _post(
      base,
      '/auth/login',
      { email: mail, senha: String(password) },
      fingerprint ? { 'x-device-fingerprint': String(fingerprint) } : undefined,
    )
  } catch (e) { return { ok: false, message: _netError(e) } }

  if (r.isHtml) return { ok: false, message: WRONG_HOST_MSG }
  if (!r.ok) return { ok: false, message: _friendlyError(r.status, r.data) }

  // 2FA ligado: o backend devolve tempToken em vez dos tokens.
  if (r.data && r.data.requiresOtp === true) {
    return {
      ok: false,
      requiresOtp: true,
      tempToken: r.data.tempToken,
      email: r.data.email || mail,
      message: `Enviamos um código para ${r.data.email || mail}.`,
    }
  }

  try { return await _afterTokens(serverUrl, r.data) }
  catch (e) { return { ok: false, message: _netError(e) } }
}

// Passo 2 (só quando requiresOtp): código do e-mail + tempToken.
// `fingerprint` é OBRIGATÓRIO no VerifyOtpDto — quem chama passa o id estável
// desta instalação (ver deviceFingerprint() em main.js).
async function verifyOtp(serverUrl, tempToken, code, fingerprint) {
  const base = restBase(serverUrl)
  if (!base) return { ok: false, message: 'URL do servidor inválida.' }
  const otp = String(code ?? '').replace(/\D/g, '')
  if (!otp) return { ok: false, message: 'Digite o código recebido por e-mail.' }
  if (!tempToken) return { ok: false, message: 'Sessão de verificação expirada. Entre novamente.' }

  // Corpo EXATO do VerifyOtpDto: tempToken + code + fingerprint (todos required).
  let r
  try { r = await _post(base, '/auth/verify-otp', { tempToken, code: otp, fingerprint: String(fingerprint || 'pede-print') }) }
  catch (e) { return { ok: false, message: _netError(e) } }

  if (r.isHtml) return { ok: false, message: WRONG_HOST_MSG }
  if (!r.ok) {
    if (r.status === 401 || r.status === 400) {
      // O backend já manda texto útil aqui ("Código inválido. N tentativa(s)
      // restante(s)." / "Muitas tentativas..."): preferir o dele ao genérico.
      const raw = r.data && (r.data.message || r.data.error)
      const msg = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
      return { ok: false, retryOtp: true, message: msg || 'Código inválido ou expirado. Confira e tente de novo.' }
    }
    return { ok: false, message: _friendlyError(r.status, r.data) }
  }
  try { return await _afterTokens(serverUrl, r.data) }
  catch (e) { return { ok: false, message: _netError(e) } }
}

// Reenvia o código do 2FA. Devolve o tempToken novo quando o backend rotaciona.
async function resendOtp(serverUrl, tempToken) {
  const base = restBase(serverUrl)
  try {
    const r = await _post(base, '/auth/resend-otp', { tempToken })
    if (r.isHtml) return { ok: false, message: WRONG_HOST_MSG }
    if (!r.ok) {
      // 400 aqui é "Limite de reenvios atingido" — mensagem do backend é a útil.
      const raw = r.data && (r.data.message || r.data.error)
      const msg = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
      return { ok: false, message: msg || _friendlyError(r.status, r.data) }
    }
    return { ok: true, tempToken: (r.data && r.data.tempToken) || tempToken, message: 'Novo código enviado.' }
  } catch (e) {
    return { ok: false, message: _netError(e) }
  }
}

// "Sair": pede ao backend para revogar as chaves de agente do tenant. Best-effort
// — a limpeza LOCAL da chave acontece de todo jeito (quem chama não depende disto).
async function revokeRemote(serverUrl, apiKey) {
  const base = restBase(serverUrl)
  if (!base || !apiKey) return { ok: false }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/print-agent/provision`, {
      method: 'DELETE',
      headers: { 'x-api-key': String(apiKey) },
      signal: ctrl.signal,
    })
    return { ok: res.ok }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { login, verifyOtp, resendOtp, provision, revokeRemote, pairWithCode, revokeAgentToken }
