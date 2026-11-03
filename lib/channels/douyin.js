/**
 * 抖音渠道适配器（2026-11-02）
 *
 * 真正的实现在可选子包 `dsh-fish-river-douyin` 里；主包只负责三件事：
 *   · 把配置翻成子包要的形状（浏览器路径、持久化 profile 目录、轮询间隔）；
 *   · 没装子包时**整条路消失**，不报错、不建文件（`loadAdapter` 会先找 `./douyin.js`）；
 *   · 把子包的消息转成渠道层统一的形状。
 *
 * 两条实测结论写在这里，改代码前先看：
 *   1. 收消息走 CDP 的 WebSocket 帧（protobuf 里的裸 UTF-8），**不走 DOM**；
 *   2. 登录态必须留在 `~/.dsh-fish-river/douyin-profile`，子包默认的临时目录每轮都换，
 *      扫码登录一次下一轮就丢。
 */

import path from 'node:path'
import { createSubAdapter } from './sub.js'

/**
 * @param {object} opts
 * @param {string} opts.root        数据目录（`~/.dsh-fish-river`）
 * @param {object} opts.config      整份配置
 * @param {(m: string) => void} [opts.log]
 * @param {Function} [opts.inner]   测试注入：返回子包适配器的工厂
 */
export function create(opts = {}) {
  const { root = '', config = {}, log = () => {}, inner: innerFactory } = opts
  const cfg = config?.channels?.douyin ?? {}
  const listeners = new Set()
  let inner = null
  let lastError = ''

  const emit = (msg) => {
    for (const fn of listeners) {
      try { fn(msg) } catch (err) { log(`douyin listener failed: ${String(err?.message ?? err)}`) }
    }
  }

  return {
    name: 'douyin',

    async start() {
      try {
        const factory = innerFactory ?? (await createSubAdapter())
        if (!factory) return { ok: false, why: '没装抖音子包 dsh-fish-river-douyin' }
        inner = factory({
          browserPath: cfg.browserPath || '',
          profileDir: path.join(root, 'douyin-profile'),
          intervalMs: Number(cfg.intervalMs) > 0 ? Number(cfg.intervalMs) : 15000,
          // 落哪一页交给你：抖音的「推荐 / 精选 / 关注」是首页上的 tab，地址不同、
          // 私信入口都在。空串 = 子包的默认（精选）。
          homeUrl: String(cfg.homeUrl ?? '').trim(),
          log,
        })
        if (!inner) return { ok: false, why: '没装抖音子包 dsh-fish-river-douyin' }
        inner.onMessage?.((m) => emit(m))
        const started = await inner.start()
        if (!started?.ok) lastError = started?.why ?? 'douyin-start-failed'
        return started ?? { ok: true }
      } catch (err) {
        lastError = String(err?.message ?? err).slice(0, 160)
        return { ok: false, why: lastError }
      }
    },

    async stop() {
      try { await inner?.stop?.() } catch { /* ignore */ }
      inner = null
    },

    async send({ conversation = {}, text = '' } = {}) {
      if (!inner) return { ok: false, why: 'not-connected' }
      try {
        return await inner.send({ conversation, text })
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
      }
    },

    onMessage(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /**
     * 借她自己那个浏览器（登录态在里面）读一个网页版只读接口。
     * 只要路径，不要整条 URL：请求由页面自己发出，cookie 才带得上、也不跨域。
     * @param {string} p 形如 `/aweme/v1/web/aweme/detail/?...`
     */
    async api(p) {
      const t = inner?._transport
      if (!t || typeof t.evaluate !== 'function') return { ok: false, why: '这个渠道没有浏览器' }
      const target = String(p ?? '')
      if (!target.startsWith('/')) return { ok: false, why: '只接受站内路径' }
      try {
        const r = await t.evaluate(
          `fetch(${JSON.stringify(target)}, { credentials: 'include' }).then((r) => r.text()).then((t) => t.slice(0, 400000)).catch((e) => 'ERR:' + e.message)`,
        )
        if (!r?.ok) return { ok: false, why: r?.why ?? 'eval-failed' }
        const text = String(r.value ?? '')
        if (!text || text.startsWith('ERR:')) return { ok: false, why: (text || '空响应').slice(0, 120) }
        try { return { ok: true, data: JSON.parse(text) } } catch { return { ok: false, why: '返回的不是 JSON' } }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
      }
    },

    status() {
      const s = inner?.status?.() ?? {}
      return {
        ok: Boolean(s.ok),
        connected: Boolean(s.connected),
        since: Number(s.since) || 0,
        lastError: s.lastError || lastError,
        queued: 0,
        sent: Number(s.sent) || 0,
        received: Number(s.received) || 0,
      }
    },
  }
}

export default { create }
