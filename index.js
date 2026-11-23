/**
 * dsh-plugin-quota-watch — Host half.
 *
 * Polls the official Codex usage endpoint (chatgpt.com backend, OAuth token
 * from auth.json) and the official DeepSeek balance endpoint, keeps the
 * latest snapshot in memory, and serves it to the page under
 * /api/quota-watch/overview. Only loopback requests and paired devices may
 * read it; secret values never leave this process.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import os from 'node:os'
import path from 'node:path'

export const name = 'quota-watch'
export const inject = ['webServer', 'credentials']

const API_PREFIX = '/api/quota-watch'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage'
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const REQUEST_TIMEOUT_MS = 15000
const MIN_POLL_SEC = 15
const MAX_POLL_SEC = 600
const DEFAULT_POLL_SEC = 60

/* ---------- small helpers ---------- */
function toNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}
function clampPollSec(value) {
  const n = toNumber(value, DEFAULT_POLL_SEC)
  return Math.min(MAX_POLL_SEC, Math.max(MIN_POLL_SEC, n))
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
function round2(n) {
  return Math.round(n * 100) / 100
}
function localDayKey() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------- DeepSeek 当日花费基线（本机观测，官方无当日消费接口） ---------- */
const SPEND_STATE_FILE = path.join(os.homedir(), '.dsh', 'quota-watch-state.json')

async function readSpendState() {
  try {
    const raw = await readFile(SPEND_STATE_FILE, 'utf8')
    const d = JSON.parse(raw)
    const days = d && d.days && typeof d.days === 'object' ? d.days : {}
    return {
      day: typeof d.day === 'string' ? d.day : null,
      lastBalance: typeof d.lastBalance === 'number' ? d.lastBalance : null,
      accrued: typeof d.accrued === 'number' && Number.isFinite(d.accrued) ? d.accrued : 0,
      days,
    }
  } catch {
    return { day: null, lastBalance: null, accrued: 0, days: {} }
  }
}

async function writeSpendState(state) {
  await mkdir(path.dirname(SPEND_STATE_FILE), { recursive: true })
  const temp = `${SPEND_STATE_FILE}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(state), 'utf8')
    await rename(temp, SPEND_STATE_FILE)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/* ---------- 出站请求 ----------
 * 不用全局 fetch：DSH Host 用 undici 代理包装过 global fetch，
 * 对部分外站连接会偶发 "fetch failed"。
 * 实测（本机 Clash TUN）chatgpt.com 的 IPv4 假 IP 路径会周期性 TLS 重置，
 * IPv6 路径稳定 → 优先 IPv6，失败回退 IPv4。 */
function requestFamily(urlString, headers, family) {
  const url = new URL(urlString)
  const lib = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = lib(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': 'dsh-plugin-quota-watch/1.0',
        ...headers,
      },
      timeout: REQUEST_TIMEOUT_MS,
      ...(family ? { family } : {}),
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        let json = null
        if (body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8'))
          } catch {
            json = null
          }
        }
        resolve({ status: res.statusCode || 0, ok: res.statusCode >= 200 && res.statusCode < 300, json })
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end()
  })
}

async function requestOnce(urlString, headers) {
  let lastError
  for (const family of [6, 4]) {
    try {
      return await requestFamily(urlString, headers, family)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function requestJson(url, headers) {
  let lastError
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await requestOnce(url, headers)
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  throw lastError
}

/* ---------- trust fence: loopback or paired device ---------- */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}
function isProxiedRequest(req) {
  return req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined
}
function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) return false
  if (isProxiedRequest(req)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
function pairedAllowed(ctx, req) {
  try {
    const pairing = ctx.get('remoteWebUiPairing', false)
    if (pairing && typeof pairing.isPairedDevice === 'function') return pairing.isPairedDevice(req) === true
  } catch {
    /* not paired */
  }
  return false
}

/* ---------- Codex ---------- */
function authCandidates(config) {
  const list = []
  if (typeof config.codexAuthPath === 'string' && config.codexAuthPath.trim()) list.push(config.codexAuthPath.trim())
  if (process.env.CODEX_HOME) list.push(path.join(process.env.CODEX_HOME, 'auth.json'))
  list.push(path.join(os.homedir(), '.codex', 'auth.json'))
  list.push(path.join(process.cwd(), '.codex-home', 'auth.json'))
  return list
}

async function readCodexToken(config) {
  for (const file of authCandidates(config)) {
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      const token = parsed && parsed.tokens && parsed.tokens.access_token
      if (typeof token === 'string' && token) return { token, file }
    } catch {
      /* try next candidate */
    }
  }
  return null
}

function parseWindow(window) {
  if (!window || typeof window !== 'object') return null
  return {
    usedPercent: typeof window.used_percent === 'number' ? window.used_percent : null,
    resetAt: typeof window.reset_at === 'number' ? window.reset_at : null,
    resetAfterSeconds: typeof window.reset_after_seconds === 'number' ? window.reset_after_seconds : null,
  }
}

async function fetchCodexUsage(token) {
  let result
  try {
    result = await requestJson(CODEX_USAGE_URL, { authorization: `Bearer ${token}` })
  } catch (error) {
    throw new Error(`无法连接 Codex 额度接口（${errorText(error)}）`)
  }
  if (result.status === 401) throw new Error('Codex 凭据过期：请在终端重新登录（codex login）后运行 cx auth')
  if (!result.ok || result.json === null) throw new Error(`Codex 额度接口返回 HTTP ${result.status}（或响应非 JSON）`)
  const data = result.json
  const rl = data && data.rate_limit
  if (!rl || typeof rl !== 'object') throw new Error('Codex 额度接口返回格式异常（缺少 rate_limit）')
  return {
    allowed: rl.allowed !== false,
    limitReached: rl.limit_reached === true,
    window: parseWindow(rl.primary_window),
    week: parseWindow(rl.secondary_window),
  }
}

/* ---------- DeepSeek ---------- */
// Same grammar the shipped @deepseek-ai/dsh-credentials package accepts for a
// CredentialRef: a POSIX shell identifier. Its credentialRef() is a
// compile-time-only brand, so the plain string resolves identically at runtime.
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
function credentialRefName(value) {
  return REF_PATTERN.test(value) ? value : null
}

async function resolveDeepseekKey(ctx, config) {
  if (typeof config.deepseekApiKey === 'string' && config.deepseekApiKey.trim()) return config.deepseekApiKey.trim()
  const envName = typeof config.deepseekApiKeyEnv === 'string' && config.deepseekApiKeyEnv.trim()
    ? config.deepseekApiKeyEnv.trim()
    : 'DEEPSEEK_API_KEY'
  const ref = credentialRefName(envName)
  if (ref) {
    try {
      const hit = await ctx.credentials.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value) return hit.value
    } catch {
      /* fall through */
    }
  }
  if (process.env[envName]) return process.env[envName]
  return null
}

function parseMoney(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

async function fetchDeepseekBalance(key) {
  let result
  try {
    result = await requestJson(DEEPSEEK_BALANCE_URL, { authorization: `Bearer ${key}` })
  } catch (error) {
    throw new Error(`无法连接 DeepSeek 余额接口（${errorText(error)}）`)
  }
  if (result.status === 401) throw new Error('DeepSeek API key 无效（401）')
  if (!result.ok || result.json === null) throw new Error(`DeepSeek 余额接口返回 HTTP ${result.status}（或响应非 JSON）`)
  const data = result.json
  const infos = data && Array.isArray(data.balance_infos) ? data.balance_infos : []
  const first = infos[0]
  return {
    isAvailable: Boolean(data && data.is_available === true),
    currency: first && typeof first.currency === 'string' ? first.currency : null,
    totalBalance: first ? parseMoney(first.total_balance) : null,
    grantedBalance: first ? parseMoney(first.granted_balance) : null,
    toppedUpBalance: first ? parseMoney(first.topped_up_balance) : null,
  }
}

/* ---------- plugin ---------- */
export function apply(ctx, config = {}) {
  const pollSec = clampPollSec(config.pollIntervalSec)
  const snapshot = { codex: null, deepseek: null }
  /** 最近一次成功的数据：拉取失败时继续展示，避免界面闪成「识别不到」。 */
  const lastGood = { codex: null, deepseek: null }
  let spend = { day: null, lastBalance: null, accrued: 0, days: {} }
  let spendLoaded = false
  let spendWriteWarned = false

  async function ensureSpendState() {
    if (!spendLoaded) {
      spend = await readSpendState()
      spendLoaded = true
    }
  }

  async function refreshCodex() {
    try {
      const auth = await readCodexToken(config)
      if (!auth) throw new Error('未找到 Codex 登录凭据（auth.json）')
      const data = await fetchCodexUsage(auth.token)
      lastGood.codex = { ok: true, ...data, stale: false, updatedAt: Date.now() }
      snapshot.codex = lastGood.codex
    } catch (error) {
      snapshot.codex = lastGood.codex
        ? { ...lastGood.codex, stale: true, error: errorText(error) }
        : { ok: false, error: errorText(error), updatedAt: Date.now() }
    }
  }

  async function refreshDeepseek() {
    try {
      const key = await resolveDeepseekKey(ctx, config)
      if (!key) throw new Error('未找到 DeepSeek API key（检查 DEEPSEEK_API_KEY）')
      const data = await fetchDeepseekBalance(key)
      let spendToday = null
      let spendDays = []
      if (typeof data.totalBalance === 'number' && Number.isFinite(data.totalBalance)) {
        await ensureSpendState()
        const today = localDayKey()
        if (spend.day !== today) {
          // 跨天（或首次运行）：结算上一天，今天以当前余额为新基线
          if (spend.day) spend.days[spend.day] = { spent: round2(spend.accrued), end: spend.lastBalance }
          spend = { day: today, lastBalance: data.totalBalance, accrued: 0, days: spend.days || {} }
        } else if (typeof spend.lastBalance === 'number' && data.totalBalance < spend.lastBalance) {
          // 余额下降 = 消费；上涨（充值）不累计，且基线自动上移
          spend.accrued = round2(spend.accrued + (spend.lastBalance - data.totalBalance))
        }
        const entry = spend.days[today] || { spent: 0, start: data.totalBalance, end: data.totalBalance }
        entry.spent = round2(spend.accrued)
        entry.end = data.totalBalance
        if (typeof entry.start !== 'number') entry.start = data.totalBalance
        spend.days[today] = entry
        spend.lastBalance = data.totalBalance
        // 只保留最近 90 天
        const dayKeys = Object.keys(spend.days).sort()
        while (dayKeys.length > 90) delete spend.days[dayKeys.shift()]
        await writeSpendState(spend).catch((error) => {
          if (!spendWriteWarned) {
            spendWriteWarned = true
            console.warn('[quota-watch] spend state write failed:', errorText(error))
          }
        })
        spendToday = round2(spend.accrued)
        spendDays = Object.entries(spend.days)
          .filter(([, day]) => day && typeof day.spent === 'number')
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .slice(0, 7)
          .map(([date, day]) => ({ date, spent: round2(day.spent) }))
      }
      lastGood.deepseek = { ok: true, ...data, spendToday, spendDays, stale: false, updatedAt: Date.now() }
      snapshot.deepseek = lastGood.deepseek
    } catch (error) {
      snapshot.deepseek = lastGood.deepseek
        ? { ...lastGood.deepseek, stale: true, error: errorText(error) }
        : { ok: false, error: errorText(error), updatedAt: Date.now() }
    }
  }

  let refreshPromise = null

  function refreshAll() {
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      await Promise.allSettled([refreshCodex(), refreshDeepseek()])
    })().finally(() => {
      refreshPromise = null
    })
    return refreshPromise
  }

  /** 手动刷新：若已有轮询在跑，等它结束后再强制拉一次，保证点击一定拿到最新数据。 */
  async function refreshNow() {
    if (refreshPromise) await refreshPromise
    return refreshAll()
  }

  const overview = () => ({
    ok: true,
    now: Date.now(),
    pollIntervalSec: pollSec,
    codex: snapshot.codex || { ok: false, error: '尚未获取', updatedAt: null },
    deepseek: snapshot.deepseek || { ok: false, error: '尚未获取', updatedAt: null },
  })

  const writeJson = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer', ...headers })
    res.end(JSON.stringify(body))
  }

  const guard = (req, res) => {
    if (!isLoopbackRequest(req) && !pairedAllowed(ctx, req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return false
    }
    return true
  }

  const disposeOverview = ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/overview`,
    handler(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      writeJson(res, 200, overview(), { 'cache-control': 'no-store' })
    },
  })

  const disposeRefresh = ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/refresh`,
    handler(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      refreshNow().then(() => writeJson(res, 200, overview(), { 'cache-control': 'no-store' }))
    },
  })

  ctx.effect(() => {
    refreshAll()
    const timer = setInterval(refreshAll, pollSec * 1000)
    return () => {
      clearInterval(timer)
      disposeOverview()
      disposeRefresh()
    }
  }, 'quota-watch: poll loop')
}
