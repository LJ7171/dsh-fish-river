/**
 * reply-scan.test.mjs —— 「立刻扫回复」（0.1.148）的回归
 *
 * 守这些事：
 *   1. 三个平台都能手动扫，扫到的进各自的盒子（与定时扫共用同一条攒盒路）。
 *   2. 绕过间隔：刚扫完立刻再点，仍真的打接口。
 *   3. 手动扫与定时扫是同一条路，只是「窗口」和「间隔」都跳过（人工点了就扫，睡着也扫）；
 *      没开评论不开工、回执都说清。
 *   4. 不叫醒、不代回、不占掷骰：睡眠台账一动不动。
 *   5. 成功后回写 lastScanAt / 内存时钟，下一次定时扫从现在重新计时。
 *   6. 没登录 / 没装子包 / 号没放行 / 风控冷却，回执都说得清。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { normalizeConfig, dateKey, loadConfig } from '../lib/core/settings.js'
import { appendEvent, readEvents, writeConfig } from '../lib/core/store.js'
import { sleepPath, writeSleep, readSleep } from '../lib/life/schedule/sleep.js'
import { startScheduler } from '../lib/life/schedule/scheduler.js'
import { readReplyBox } from '../lib/life/replybox.js'
import { registerObserve } from '../lib/ui/observe.js'
import { formatZhihuComment, formatTiebaComment } from '../lib/core/acts.js'
import { saveCookie as saveZhihuCookie } from '../packages/dsh-fish-river-zhihu/auth.js'
import { writeAuth as writeTiebaAuth } from '../lib/platforms/tieba/client.js'
import { noteRisk } from '../lib/platforms/bili/risk.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-replyscan-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function meta(root, text) {
  await appendEvent({ type: 'meta', text }, { day: 0, stage: 1, source: 'system' }, root)
}

async function ready(root, patch) {
  await writeConfig(normalizeConfig(patch), root)
}

function herCtx() {
  // 手动扫不碰会话：ctx 里没有 sessionController，谁也别想把「叫醒」混进来。
  return { on: () => {} }
}

function biliClient() {
  const calls = []
  return {
    calls,
    async view(bvid) {
      calls.push(['view', bvid])
      return { ok: true, data: { aid: 9 } }
    },
    async subReplies(aid, rootRpid) {
      calls.push(['sub', aid, rootRpid])
      return {
        ok: true,
        data: [
          { rpid: 9001, mid: 42, user: '路人甲', text: '回你啦', ctime: 5 },
          { rpid: 9002, mid: 42, user: '路人甲', text: '又回一条', ctime: 6 },
        ],
      }
    },
  }
}

test('B 站手动扫：扫到进盒子，立刻再扫仍打接口（绕过间隔），定时扫不跟着再来一遍', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, { comment: { enabled: true, scanEveryMin: 720 } })
    await meta(root, `comment:${dk} BV1abc 101 {"text":"我说过一句","slot":"a"}`)
    const client = biliClient()
    const accounts = [{ id: 'a', cookie: 'SESSDATA=x', allowed: true }]
    const s = startScheduler(herCtx(), { root, log: () => {}, sessionId: 's-main' })
    try {
      const r1 = await s.manualScanReplies('bili', { bili: { client, accounts } })
      assert.equal(r1.ok, true, r1.why)
      assert.equal(r1.total, 2)
      assert.equal(r1.added, 2)
      const box = await readReplyBox(root)
      assert.deepEqual(box.items.map((x) => x.rpid), [9001, 9002], '扫到的进默认盒子')

      // 事件流一行不多（扫不写事件），睡眠台账也没被碰（没叫醒、不占掷骰）
      const { events } = await readEvents(root)
      assert.equal(events.length, 1)
      assert.equal(await readSleep(root), null)

      // 刚扫完立刻再点：不看间隔，仍真打接口；同一条回复不重复进盒
      const callsAfterFirst = client.calls.length
      const r2 = await s.manualScanReplies('bili', { bili: { client, accounts } })
      assert.equal(r2.ok, true, r2.why)
      assert.equal(r2.total, 2)
      assert.equal(r2.added, 0)
      assert.ok(client.calls.length > callsAfterFirst, '第二次也要真的打接口')

      // 内存时钟已拨到刚才：这一拍 tick 里的定时扫不该再打一遍
      const before = client.calls.length
      await s.tick()
      assert.equal(client.calls.length, before, '定时扫看到新时钟，不再打一遍')
      const box2 = await readReplyBox(root)
      assert.equal(box2.items.length, 2)
    } finally {
      s.dispose()
    }
  })
})

test('知乎/贴吧手动扫：睡着也真扫（人工点了就扫），lastScanAt 照写', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, { zhihu: { comment: { enabled: true } }, tieba: { comment: { enabled: true } } })
    await writeSleep(root, { mode: 'asleep' })
    await meta(root, formatZhihuComment(dk, 'ans1', 'rootc', '我说过', { slot: 'a', owner: 'her', name: '戴菲钰' }))
    await meta(root, formatTiebaComment(dk, 'tid1', 'pid1', '我说过', '吧', { slot: 'a', owner: 'her', name: '戴菲钰' }))
    let zHits = 0
    let tHits = 0
    const zApi = { async fetchChildComments() { zHits += 1; return { ok: true, comments: [] } } }
    const tApi = { async floor() { tHits += 1; return { ok: true, replies: [] } } }
    const s = startScheduler(herCtx(), { root, log: () => {}, sessionId: 's-main' })
    try {
      const z = await s.manualScanReplies('zhihu', { zhihu: { api: zApi, cookie: 'z', selfId: 'me' } })
      assert.equal(z.ok, true, z.why)
      assert.equal(zHits, 1, '手动扫不因睡着而跳')
      const t = await s.manualScanReplies('tieba', { tieba: { api: tApi, cookie: 'BDUSS=x' } })
      assert.equal(t.ok, true, t.why)
      assert.equal(tHits, 1)
      const { config } = await loadConfig(root)
      assert.ok(Number(config.zhihu.comment.lastScanAt) > 0, '扫过就回写 lastScanAt')
      assert.ok(Number(config.tieba.comment.lastScanAt) > 0)
      assert.equal((await readSleep(root))?.mode, 'asleep', '扫不会叫醒她，睡眠台账不动')
    } finally {
      s.dispose()
    }
  })
})

test('知乎手动扫（醒着）：真扫、进盒子、lastScanAt 写回去，下一次定时扫重新计时', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    // 「有人回复时让她回一句」只管她能不能回，管不着扫：关着也照扫。
    await ready(root, { zhihu: { comment: { enabled: true, replyToReplies: false } } })
    await writeSleep(root, { mode: 'dice_awake' })
    await meta(root, formatZhihuComment(dk, 'ans1', 'rootc', '我说过', { slot: 'a', owner: 'her', name: '戴菲钰' }))
    let hits = 0
    const api = {
      async fetchChildComments() {
        hits += 1
        return { ok: true, comments: [{ id: 'r1', authorId: 'other', author: '路人', text: '回你一句', created: 100 }] }
      },
    }
    const s = startScheduler(herCtx(), { root, log: () => {}, sessionId: 's-main' })
    try {
      const r = await s.manualScanReplies('zhihu', { zhihu: { api, cookie: 'z', selfId: 'me' } })
      assert.equal(r.ok, true, r.why)
      assert.equal(hits, 1, '醒着就真的发请求')
      assert.equal(r.added, 1)
      const box = await readReplyBox(root, { file: 'zhihu-reply-box.json' })
      assert.deepEqual(box.items.map((x) => x.rpid), ['r1'])
      const { config } = await loadConfig(root)
      const stamped = config.zhihu.comment.lastScanAt
      assert.ok(Number(stamped) > 0, 'lastScanAt 要写回去（定时扫从现在重新计时）')
      // 重新计时：紧接着的这一拍，定时扫看到新时间戳就不再扫、也不再写
      await s.tick()
      const { config: again } = await loadConfig(root)
      assert.equal(again.zhihu.comment.lastScanAt, stamped, '定时扫从手动扫那一刻重新计时')
      assert.equal((await readSleep(root))?.mode, 'dice_awake')
    } finally {
      s.dispose()
    }
  })
})

test('贴吧手动扫（醒着）：真扫、进盒子、lastScanAt 写回去', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, { tieba: { comment: { enabled: true } } })
    await writeSleep(root, { mode: 'dice_awake' })
    await meta(root, formatTiebaComment(dk, 'tid1', 'pid1', '我说过', '吧', { slot: 'a', owner: 'her', name: '戴菲钰' }))
    const api = {
      async floor() {
        return { ok: true, replies: [{ id: 'r9', authorId: 'someone', author: '路人', text: '跟一句', time: 7 }] }
      },
    }
    const s = startScheduler(herCtx(), { root, log: () => {}, sessionId: 's-main' })
    try {
      const r = await s.manualScanReplies('tieba', { tieba: { api, cookie: 'BDUSS=x' } })
      assert.equal(r.ok, true, r.why)
      assert.equal(r.added, 1)
      const box = await readReplyBox(root, { file: 'tieba-reply-box.json' })
      assert.deepEqual(box.items.map((x) => x.rpid), ['r9'])
      const { config } = await loadConfig(root)
      assert.ok(Number(config.tieba.comment.lastScanAt) > 0, 'lastScanAt 要写回去')
      assert.equal((await readSleep(root))?.mode, 'dice_awake')
    } finally {
      s.dispose()
    }
  })
})

test('「允许在知乎评论」关着：手动扫不开工，回执说清，与定时扫同一道门', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await ready(root, { zhihu: { comment: { enabled: false } } })
    await writeSleep(root, { mode: 'dice_awake' })
    await meta(root, formatZhihuComment(dk, 'ans1', 'rootc', '我说过', { slot: 'a', owner: 'her', name: '戴菲钰' }))
    let hits = 0
    const api = {
      async fetchChildComments() {
        hits += 1
        return { ok: true, comments: [] }
      },
    }
    const s = startScheduler(herCtx(), { root, log: () => {}, sessionId: 's-main' })
    try {
      const r = await s.manualScanReplies('zhihu', { zhihu: { api, cookie: 'z', selfId: 'me' } })
      assert.equal(r.ok, false)
      assert.equal(r.why, 'disabled')
      assert.equal(hits, 0, '没开评论就不打请求')
      assert.equal((await readReplyBox(root, { file: 'zhihu-reply-box.json' })).items.length, 0)
    } finally {
      s.dispose()
    }
  })
})

test('同一个平台同时在扫，后到的让路', async () => {
  await withRoot(async (root) => {
    await ready(root, { zhihu: { comment: { enabled: true } } })
    let release
    const gate = new Promise((r) => { release = r })
    const api = {
      async fetchChildComments() {
        await gate
        return { ok: true, comments: [] }
      },
    }
    const s = startScheduler(herCtx(), { root, log: () => {}, sessionId: 's-main' })
    try {
      const first = s.manualScanReplies('zhihu', { zhihu: { api, cookie: 'z' } })
      const second = await s.manualScanReplies('zhihu', { zhihu: { api, cookie: 'z' } })
      assert.equal(second.ok, false)
      assert.equal(second.why, 'busy')
      release()
      const r1 = await first
      assert.equal(r1.ok, true, r1.why)
    } finally {
      release()
      s.dispose()
    }
  })
})

test('定时扫仍走同一条路：知乎到点会扫（没登录就空手），并把 lastScanAt 写回去', async () => {
  await withRoot(async (root) => {
    await ready(root, { zhihu: { comment: { enabled: true, scanEveryMin: 5 } } })
    const s = startScheduler(herCtx(), { root, log: () => {}, sessionId: 's-main' })
    try {
      await s.tick()
      const { config } = await loadConfig(root)
      assert.ok(Number(config.zhihu.comment.lastScanAt) > 0, '到点的定时扫要写 lastScanAt')
      // 间隔没到：第二拍不再写
      const first = config.zhihu.comment.lastScanAt
      await s.tick()
      const { config: again } = await loadConfig(root)
      assert.equal(again.zhihu.comment.lastScanAt, first, '间隔没到就不再扫')
    } finally {
      s.dispose()
    }
  })
})

// ---- 设置页路由 ----

function routeCtx() {
  const routes = []
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  const ctx = {
    get: (k) => (k === 'connection' ? { requestRejection: () => null } : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
  }
  return { ctx, routes }
}

async function postRoute(routes, path, body) {
  const route = routes.find((r) => String(r.path ?? '').endsWith(path))
  assert.ok(route, `${path} 路由要注册上`)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Object.assign(Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []), {
    method: 'POST',
    headers: payload ? { 'content-type': 'application/json' } : {},
  })
  let status = 0
  let text = ''
  const res = {
    writableEnded: false,
    writeHead(code) { status = code },
    end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
  }
  await route.handler(req, res)
  return { status, json: text ? JSON.parse(text) : null }
}

test('/reply-scan：平台参数认三个，别的拒掉；GET 不放行', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = routeCtx()
    registerObserve(ctx, { root })
    const bad = await postRoute(routes, '/reply-scan', { platform: 'douyin' })
    assert.equal(bad.status, 400)
    const route = routes.find((r) => String(r.path ?? '').endsWith('/reply-scan'))
    const req = Object.assign(Readable.from([]), { method: 'GET', headers: {} })
    let status = 0
    const res = { writableEnded: false, writeHead(code) { status = code }, end() { res.writableEnded = true } }
    await route.handler(req, res)
    assert.equal(status, 405)
  })
})

test('/reply-scan：扫成功带回条数；关着说清楚', async () => {
  await withRoot(async (root) => {
    await ready(root, { comment: { enabled: true } })
    const seen = []
    const sched = { manualScanReplies: async (name) => { seen.push(name); return { ok: true, total: 3, added: 2 } } }
    const { ctx, routes } = routeCtx()
    registerObserve(ctx, { root, getScheduler: () => sched })
    const r = await postRoute(routes, '/reply-scan', { platform: 'bili' })
    assert.equal(r.status, 200)
    assert.deepEqual(seen, ['bili'], '平台参数要传给调度器')
    assert.equal(r.json.ok, true)
    assert.equal(r.json.added, 2)
    assert.equal(r.json.total, 3)

    const disabled = routeCtx()
    registerObserve(disabled.ctx, { root, getScheduler: () => ({ manualScanReplies: async () => ({ ok: false, why: 'disabled' }) }) })
    const r2 = await postRoute(disabled.routes, '/reply-scan', { platform: 'bili' })
    assert.equal(r2.json.ok, false)
    assert.equal(r2.json.reason, 'disabled', JSON.stringify(r2.json))

  })
})

test('/reply-scan：没登录、号没放行、没装子包，都先说清再动手', async () => {
  await withRoot(async (root) => {
    let called = 0
    const sched = { manualScanReplies: async () => { called += 1; return { ok: true, added: 0, total: 0 } } }
    const { ctx, routes } = routeCtx()
    registerObserve(ctx, { root, getScheduler: () => sched })

    const zhihu = await postRoute(routes, '/reply-scan', { platform: 'zhihu' })
    assert.equal(zhihu.json.ok, false)
    assert.equal(zhihu.json.reason, 'no-login', JSON.stringify(zhihu.json))
    assert.equal(called, 0, '没登录就不该去扫')

    await saveZhihuCookie(root, { cookie: 'z=1', allowed: false })
    const zhihu2 = await postRoute(routes, '/reply-scan', { platform: 'zhihu' })
    assert.equal(zhihu2.json.reason, 'not-allowed', JSON.stringify(zhihu2.json))
    assert.equal(called, 0)

    const tieba = await postRoute(routes, '/reply-scan', { platform: 'tieba' })
    assert.equal(tieba.json.reason, 'no-login', JSON.stringify(tieba.json))
    assert.equal(called, 0)

    await writeTiebaAuth(root, { cookie: 'BDUSS=x', allowed: false })
    const tieba2 = await postRoute(routes, '/reply-scan', { platform: 'tieba' })
    assert.equal(tieba2.json.reason, 'not-allowed', JSON.stringify(tieba2.json))
    assert.equal(called, 0)
  })
})

test('/reply-scan：风控冷却里的 B 站先说等，不去打接口', async () => {
  await withRoot(async (root) => {
    noteRisk(root, -412)
    let called = 0
    const { ctx, routes } = routeCtx()
    registerObserve(ctx, { root, getScheduler: () => ({ manualScanReplies: async () => { called += 1; return { ok: true } } }) })
    const risked = await postRoute(routes, '/reply-scan', { platform: 'bili' })
    assert.equal(risked.json.ok, false)
    assert.equal(risked.json.reason, 'risk')
    assert.ok(Number(risked.json.detail) >= 1, '回执要带上还剩几分钟')
    assert.equal(called, 0, '冷却里不去打接口')
  })
})

test('/reply-scan：后台没起、正在扫、扫出错，回执都分得清', async () => {
  await withRoot(async (root) => {
    const noSched = routeCtx()
    registerObserve(noSched.ctx, { root })
    const a = await postRoute(noSched.routes, '/reply-scan', { platform: 'bili' })
    assert.equal(a.json.ok, false)
    assert.equal(a.json.reason, 'no-scheduler')

    const busy = routeCtx()
    registerObserve(busy.ctx, { root, getScheduler: () => ({ manualScanReplies: async () => ({ ok: false, why: 'busy' }) }) })
    const b = await postRoute(busy.routes, '/reply-scan', { platform: 'bili' })
    assert.equal(b.json.reason, 'busy')

    const err = routeCtx()
    registerObserve(err.ctx, { root, getScheduler: () => ({ manualScanReplies: async () => ({ ok: false, why: '网络断了' }) }) })
    const c = await postRoute(err.routes, '/reply-scan', { platform: 'bili' })
    assert.equal(c.json.reason, 'error')
    assert.equal(c.json.detail, '网络断了')
  })
})

test('/reply-scan 接真调度器：没评论可扫时也是一条诚实回执', async () => {
  await withRoot(async (root) => {
    await ready(root, { comment: { enabled: true } })
    const s = startScheduler(herCtx(), { root, log: () => {}, sessionId: 's-main' })
    try {
      const { ctx, routes } = routeCtx()
      registerObserve(ctx, { root, getScheduler: () => s })
      const r = await postRoute(routes, '/reply-scan', { platform: 'bili' })
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, true, JSON.stringify(r.json))
      assert.equal(r.json.total, 0)
      assert.equal(r.json.added, 0)
    } finally {
      s.dispose()
    }
  })
})
