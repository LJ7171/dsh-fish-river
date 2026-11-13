/**
 * zhihu-qr.test.mjs —— 扫码确认的响应形状（2026-11-13）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pollQr } from '../packages/dsh-fish-river-zhihu/auth.js'

function res(body, status = 200) {
  return {
    status,
    headers: { getSetCookie: () => [], get: () => '' },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

test('知乎 scan_info 用 user_id + body cookie 确认', async () => {
  const r = await pollQr({
    token: 't',
    jar: { _xsrf: 'x' },
    fetchImpl: async () => res({ user_id: 42, cookies: 'z_c0=z; _xsrf=x' }),
  })
  assert.equal(r.status, 'confirmed')
  assert.match(r.cookie, /z_c0=z/)
})

test('知乎 scan_info 的 status 0 / 1 仍算等待', async () => {
  for (const status of [0, 1]) {
    const r = await pollQr({ token: 't', jar: {}, fetchImpl: async () => res({ status }) })
    assert.equal(r.status, 'wait')
  }
})

test('知乎 scan_info 的 z_c0 字段也能确认', async () => {
  const r = await pollQr({ token: 't', jar: {}, fetchImpl: async () => res({ z_c0: 'z2', status: 2 }) })
  assert.equal(r.status, 'confirmed')
  assert.match(r.cookie, /z_c0=z2/)
})
