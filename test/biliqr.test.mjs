import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createQr, pollQr, qrSvg, cookieFromSetCookie, cookieFromUrl, pickCookie, POLL_STATUS, QR_TTL_MS,
} from '../lib/biliqr.js'

/** 假 fetch：按 URL 分流，返回 B 站那两种响应之一。 */
function fakeFetch({ generate, poll, setCookie = [], status = 200 } = {}) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    const body = String(url).includes('/qrcode/poll') ? poll : generate
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { getSetCookie: () => setCookie },
      text: async () => JSON.stringify(body ?? {}),
    }
  }
  impl.calls = calls
  return impl
}

const GEN_OK = { code: 0, data: { url: 'https://passport.bilibili.com/h5-app/passport/login?qrcode_key=abc', qrcode_key: 'abc' } }
const POLL_WAIT = { code: 0, data: { code: 86101, message: '未扫码' } }
const POLL_SCANNED = { code: 0, data: { code: 86090, message: '已扫码未确认' } }
const POLL_EXPIRED = { code: 0, data: { code: 86038, message: '二维码已失效' } }

test('createQr 拿到 key / url / svg', async () => {
  const f = fakeFetch({ generate: GEN_OK })
  const r = await createQr({ fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.key, 'abc')
  assert.match(r.url, /qrcode_key=abc/)
  assert.match(r.svg, /^<svg/)
  assert.equal(r.expiresIn, QR_TTL_MS)
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0], /passport\.bilibili\.com/)
})

test('createQr 遇到 B 站报错不抛', async () => {
  const f = fakeFetch({ generate: { code: -400, message: '请求错误' } })
  const r = await createQr({ fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.why, /请求错误/)
})

test('createQr 遇到网络异常不抛', async () => {
  const r = await createQr({ fetchImpl: async () => { throw new Error('ECONNRESET') } })
  assert.equal(r.ok, false)
  assert.match(r.why, /连不上/)
})

test('pollQr 三种未完成状态', async () => {
  for (const [body, want] of [[POLL_WAIT, 'waiting'], [POLL_SCANNED, 'scanned'], [POLL_EXPIRED, 'expired']]) {
    const r = await pollQr('abc', { fetchImpl: fakeFetch({ poll: body }) })
    assert.equal(r.ok, true)
    assert.equal(r.status, want)
    assert.equal(r.cookie, undefined)
  }
  assert.equal(POLL_STATUS[0], 'ok')
})

test('pollQr 成功时从 Set-Cookie 拼出凭据并只留认识的键', async () => {
  const setCookie = [
    'SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; HttpOnly',
    'bili_jct=csrf123; Path=/',
    'DedeUserID=42; Path=/',
    'buvid3=noise; Path=/',
  ]
  const f = fakeFetch({ poll: { code: 0, data: { code: 0, url: 'https://x/?SESSDATA=zzz' } }, setCookie })
  const r = await pollQr('abc', { fetchImpl: f })
  assert.equal(r.status, 'ok')
  assert.equal(r.cookie, 'SESSDATA=abc%2C123; bili_jct=csrf123; DedeUserID=42')
  assert.doesNotMatch(r.cookie, /buvid3/)
})

test('pollQr 没有 Set-Cookie 时从 data.url 兜底', async () => {
  const url = 'https://passport.biligame.com/crossDomain?SESSDATA=s1&bili_jct=j1&DedeUserID=7'
  const r = await pollQr('abc', { fetchImpl: fakeFetch({ poll: { code: 0, data: { code: 0, url } } }) })
  assert.equal(r.status, 'ok')
  assert.equal(r.cookie, 'SESSDATA=s1; bili_jct=j1; DedeUserID=7')
})

test('pollQr 成功但两个来源都没有凭据时报错', async () => {
  const r = await pollQr('abc', { fetchImpl: fakeFetch({ poll: { code: 0, data: { code: 0 } } }) })
  assert.equal(r.ok, false)
  assert.match(r.why, /没拿到 cookie/)
})

test('pollQr 没有 key 时直接报错，不发请求', async () => {
  const f = fakeFetch({ poll: POLL_WAIT })
  const r = await pollQr('', { fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(f.calls.length, 0)
})

test('cookieFromSetCookie / cookieFromUrl / pickCookie 的边角', () => {
  assert.equal(cookieFromSetCookie([]), '')
  assert.equal(cookieFromSetCookie(['bad', '=x', 'ok=1; Path=/']), 'ok=1')
  // 同名后者覆盖前者（B 站会先发空值再发真值）
  assert.equal(cookieFromSetCookie(['a=1; Path=/', 'a=2; Path=/']), 'a=2')
  assert.equal(cookieFromUrl('not a url'), '')
  assert.equal(pickCookie('SESSDATA=x; foo=1'), 'SESSDATA=x')
})

test('qrSvg 给出可内联的 svg', () => {
  const svg = qrSvg('https://example.com/x')
  assert.match(svg, /^<svg/)
  assert.ok(svg.length > 200)
})
