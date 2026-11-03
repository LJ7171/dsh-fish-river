/**
 * channels-host.test.mjs —— 渠道宿主只做两件事：把配置递给适配器、把进程拉起来。
 *
 * 2026-11-03 真机踩到过一次：`host.js` 把渠道配置摊平传（`{...chan.qq, root, log}`），
 * 而适配器按约定读 `opts.config`，于是 QQ 的令牌根本没进 URL——表现成「连接出错」，
 * 日志里却只有一行「渠道已起」，看起来像桥的问题。这条用例盯的就是那个接缝。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startChannels } from '../lib/channels/host.js'

class FakeWS {
  static urls = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    FakeWS.urls.push(url)
  }

  send() {}

  close() {}
}

test('host：渠道配置以 opts.config 递到适配器手里（QQ 的令牌才进得了 URL）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-host-'))
  const prev = globalThis.WebSocket
  globalThis.WebSocket = FakeWS
  FakeWS.urls = []
  try {
    const h = startChannels({
      ctx: { on: () => () => {} },
      root,
      config: {
        channels: {
          qq: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', accessToken: 'tok-abc', ownerId: '' },
        },
      },
      log: () => {},
    })
    const boot = await h.ready
    assert.equal(boot.ok, true, JSON.stringify(boot))
    assert.equal(FakeWS.urls.length, 1, '应当只连一次')
    // 令牌必须出现在 query 里：这是 OneBot 11 正向 WS 唯一认的鉴权方式
    assert.match(FakeWS.urls[0], /access_token=tok-abc/)
    assert.match(FakeWS.urls[0], /^ws:\/\/127\.0\.0\.1:3001\//)
    await h.dispose()
  } finally {
    globalThis.WebSocket = prev
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('host：一个渠道都没开时，不建目录、不连网', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-host-'))
  const prev = globalThis.WebSocket
  globalThis.WebSocket = FakeWS
  FakeWS.urls = []
  try {
    const h = startChannels({
      ctx: { on: () => () => {} },
      root,
      config: { channels: { qq: { enabled: false }, bili: { enabled: false }, douyin: { enabled: false } } },
      log: () => {},
    })
    const boot = await h.ready
    assert.equal(boot.why, 'no-channel')
    assert.equal(FakeWS.urls.length, 0)
    const files = await fs.readdir(root)
    assert.deepEqual(files.filter((f) => f.endsWith('.json')), [])
    await h.dispose()
  } finally {
    globalThis.WebSocket = prev
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('渠道层把 adapters 露出来：刷站要借它的登录态', async () => {
  const { startChannels } = await import('../lib/channels/host.js')
  const r = startChannels({ ctx: { on() { return () => {} } }, root: 'C:/no-such-root', config: { channels: {} }, log: () => {} })
  assert.equal(typeof r.adapters, 'object')
  assert.equal(typeof r.adapters.get, 'function')
  await r.dispose?.().catch?.(() => {})
})
