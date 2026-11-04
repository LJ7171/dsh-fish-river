/**
 * channels/host.js —— 渠道层的装配工
 *
 * 它只做四件事：看配置决定开哪几个渠道 → 造适配器 → 接上路由器 → 起停。
 * 判断（该不该回、能不能说）全在 gate.js 与 router.js 里，这里不做决定。
 *
 * 为什么单独一层：`index.js` 已经够长了，而且渠道是**可全关**的功能——
 * 关掉之后应该连 people.json / journal.json 都不碰。把这段放在 boot 里
 * 会让「没开渠道的人」也付出初始化的代价，出问题时也更难切。
 */

import { readEvents } from '../store.js'
import { deriveSelf } from '../derive.js'
import { loadConfig } from '../settings.js'
import { createPeople } from '../people.js'
import { createJournal } from '../journal.js'
import { createWorldbook } from '../worldbook.js'
import { createRouter } from './router.js'

/**
 * 动态载入一个适配器。**缺文件不算错误**：这是「可选装」的实现方式——
 * 主包不带抖音，装了子包才 import 得到。
 */
async function loadAdapter(name, opts) {
  const one = async (spec) => {
    try {
      const mod = await import(spec)
      const make = mod.create ?? mod.default
      if (typeof make !== 'function') return { ok: false, why: `${spec} 没有导出 create()` }
      return { ok: true, adapter: make(opts) }
    } catch (err) {
      const code = String(err?.code ?? '')
      if (code === 'ERR_MODULE_NOT_FOUND') return { ok: false, missing: true, why: `没有装 ${name} 渠道` }
      return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
    }
  }
  const local = await one(`./${name}.js`)
  if (local.ok || !local.missing) return local
  // 子包通道：主包不带抖音，装了 `dsh-fish-river-douyin` 才 import 得到。
  // 这就是「可选装」的实现方式——不是靠配置开关，是靠包装不装。
  if (name === 'douyin') return one('dsh-fish-river-douyin')
  return local
}

/**
 * @param {object} p
 * @param {object} p.ctx 宿主 ctx
 * @param {string} p.root 她的家
 * @param {object} p.config 当前配置
 * @param {(…a:any)=>void} [p.log]
 * @param {{tenant?:object, home?:object}} [p.tenancy]
 * @param {(msg:object)=>Promise<object>} [p.onInbound] 测试钩子
 */
export function startChannels({ ctx, root, config, log = () => {}, tenancy = {}, onInbound = null }) {
  let router = null
  let disposed = false
  const adapters = new Map()
  const notes = []
  const started = []

  const say = (m) => {
    try { log(m) } catch { /* 日志不能带走启动 */ }
  }

  /** 她这条会话是哪条：渠道里说的话要落回**同一个**她。 */
  async function herSession() {
    return String(tenancy?.home?.sessionId ?? '')
  }

  async function stateOf() {
    const { events } = await readEvents(root)
    const model = deriveSelf(events, { growthDays: config?.growthDays })
    return { sessionId: await herSession(), stage: model.stage, day: model.day }
  }

  /**
   * 社会层开闸后，她在外面见过的做法。
   * 每次现算：开闸是事件，可能就在这一轮之前发生——缓存会在最该生效的时候不生效。
   */
  async function socialBeliefs() {
    const { events } = await readEvents(root)
    const model = deriveSelf(events, { growthDays: config?.growthDays })
    return model.influence?.social?.beliefs ?? []
  }

  async function boot() {
    const chan = config?.channels ?? {}
    const wanted = ['qq', 'bili', 'douyin', 'weixin'].filter((n) => chan?.[n]?.enabled === true)
    if (!wanted.length) {
      say('[dsh-fish-river] 渠道全关：她不接任何外部消息')
      return { ok: true, why: 'no-channel' }
    }

    const people = createPeople(root)
    const journal = createJournal(root)

    /**
     * 哪个 id 算「他本人」。渠道适配器不认识主人，只如实给出对方的 id。
     * 2026-11-02：改成每来一条消息现读配置——原来只在启动时算一次，
     * 用户在设置页填了自己的 uid 之后必须重启才生效，实测踩到（m02782）。
     */
    const ownerIdsFrom = (c) => {
      const out = {}
      for (const n of ['qq', 'bili', 'douyin', 'weixin']) {
        const id = String(c?.[n]?.ownerId ?? '').trim()
        if (id !== '') out[n] = id
      }
      return out
    }

    for (const name of wanted) {
      // 适配器的约定是 opts.config（见 lib/channels/README.md）；这里同时把扁平字段铺一层，
      // 免得少传一个内层键就静默连不上（QQ 渠道 2026-11-03 实测踩到：token 没传进去，
      // 表现成「连接出错」，日志却只有一行「渠道已起」）。
      const flat = { ...chan[name] }
      // 适配器按 (level, message) 记日志（见 lib/channels/README.md）；消息里通常已经带了
      // `[qq]` 这类前缀，别再叠一层变成 `[qq] [qq] …`。
      const opts = {
        ...flat,
        config: flat,
        root,
        log: (a, b) => {
          const text = String(b === undefined ? a : b)
          say(text.startsWith(`[${name}]`) ? text : `[${name}] ${text}`)
        },
      }
      const r = await loadAdapter(name, opts)
      if (!r.ok) {
        notes.push({ name, ok: false, why: r.why })
        say(`[dsh-fish-river] 渠道 ${name} 没起来：${r.why}`)
        continue
      }
      adapters.set(name, r.adapter)
      notes.push({ name, ok: true, why: '' })
    }
    if (!adapters.size) return { ok: false, why: notes.map((n) => `${n.name}: ${n.why}`).join('；') }

    router = createRouter({
      ctx,
      root,
      journal,
      people,
      adapters,
      worldbook: createWorldbook(root),
      socialBeliefs,
      ownerIds: async () => ownerIdsFrom((await loadConfig(root).catch(() => null))?.config?.channels),
      log: (m) => say(`[router] ${m}`),
      getConfig: async () => (await loadConfig(root)).config,
      getState: async () => stateOf(),
    })

    if (typeof onInbound === 'function') router.onInbound = onInbound
    const results = await router.start()
    started.push(...(Array.isArray(results) ? results : []))
    say(`[dsh-fish-river] 渠道已起：${[...adapters.keys()].join(' / ')}`)
    return { ok: true, why: '', results }
  }

  const ready = boot().catch((err) => {
    say(`[dsh-fish-river] 渠道启动失败：${String(err?.message ?? err).slice(0, 200)}`)
    return { ok: false, why: String(err?.message ?? err) }
  })

  return {
    get ready() { return ready },
    /** 刷站要借登录态：调度器与 /wake 都从这里拿 feed（不要再从闭包里猜）。 */
    get adapters() { return adapters },
    /** 给观测台看的实时状态：只有事实，没有"健康"这种断言。 */
    async status() {
      await ready
      const list = []
      for (const [name, a] of adapters) {
        let s = {}
        try { s = a.status?.() ?? {} } catch (err) { s = { ok: false, why: String(err?.message ?? err) } }
        list.push({ name, ...s })
      }
      return { ok: adapters.size > 0 && !disposed, channels: list, notes, started }
    },
    /** 测试与观测台用：把一条消息直接塞进来。 */
    async inject(msg) {
      await ready
      return router ? router.handle(msg) : { sent: false, why: 'no-router' }
    },
    /** 代发：她不说的时候，主人以自己的名义回一句（只在开了渠道时可用）。 */
    async sendAs(msg) {
      await ready
      return router?.sendAs ? router.sendAs(msg) : { ok: false, why: 'no-router' }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try { await router?.stop?.() } catch { /* 停的时候不许抛 */ }
      for (const [, a] of adapters) {
        try { await a.stop?.() } catch { /* 同上 */ }
      }
      adapters.clear()
    },
  }
}

/**
 * 「刷抖音」用渠道里已经跑着的那个浏览器。
 *
 * 为什么要单独 export：定时唤醒的 deps 与手动 /wake 的 deps 是两份，
 * 以前只把 douyinFeed 塞给了 startScheduler，于是点「让她去刷」那一轮
 * 抖音这条线是空的（2026-11-03 真机踩到：she 只刷了 B 站）。
 */
export function douyinFeedOf(channels) {
  return async ({ limit } = {}) => {
    const a = channels?.adapters?.get?.('douyin')
    if (!a || typeof a.feed !== 'function') return { ok: false, why: '抖音渠道没开' }
    return a.feed({ count: limit })
  }
}
