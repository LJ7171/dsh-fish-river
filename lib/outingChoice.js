/**
 * outingChoice.js —— `choose_outing`
 *
 * 2026-11-06（用户要求）：作息掷骰不再替她决定走哪几路。
 * 到点只问她一句「出去逛逛」；她把想走的路写进来，才真的抓、才扣次数。
 * 不选 / 选空 = 这次不逛，一个请求都不发，也不占当天配额。
 *
 * 为什么工具本身不知道去哪抓：抓取要用调度器手里那份 client / 子包 / 风控状态，
 * 所以调度器启动时用 `setOutingExecutor()` 注册一个执行器；这个文件只负责
 * 工具面、醒来回合的判断和回执。
 *
 * 两条边界：
 *   - 只在她自己的醒来回合里可用（`wakeTurn`，和 send_message 同一条时间窗）；
 *   - 不告诉她今天还剩几次、也不提阶段——选到没次数的路，只会回一句“今天不去了”。
 */

import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { rootDir } from './store.js'
import { currentWakeTurn } from './wakeTurn.js'

let executor = null

/** 调度器启动时注册：async ({ root, channels, wakeTurn }) => { ok, text, note } */
export function setOutingExecutor(fn) {
  executor = typeof fn === 'function' ? fn : null
}

export function getOutingExecutor() {
  return executor
}

export function resetOutingForTests() {
  executor = null
}

export const OUTING_CHANNELS = Object.freeze(['bili', 'zhihu', 'tieba'])

export function registerChooseOuting(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }

  return ctx.tools.register(
    defineTool({
      name: 'choose_outing',
      description:
        '出去逛逛。把想走的几路写进 channels：bili（B 站）、zhihu（知乎）、tieba（贴吧）。' +
        '可以选多路，也可以一个都不选。不选就是这次不逛，不会占次数。' +
        '只在你自己的醒来回合里能用；回来的是那几路此刻看到的东西。',
      parameters: {
        type: 'object',
        properties: {
          channels: {
            type: 'array',
            items: { type: 'string', enum: OUTING_CHANNELS },
            description: '想走的路；空数组 = 这次不逛。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没出门：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancy, exec, 'choose_outing')
        if (!who.ok) return { ok: false, text: '', note: who.note }

        const turn = currentWakeTurn()
        if (!turn) return { ok: false, text: '', note: '这不是你自己醒着的时候。' }
        if (!executor) return { ok: false, text: '', note: '现在出不去。' }

        const picked = Array.isArray(args?.channels) ? args.channels : []
        const channels = [...new Set(picked.map((x) => String(x ?? '').trim()))].filter((x) => OUTING_CHANNELS.includes(x))
        if (!channels.length) return { ok: false, text: '', note: '这次不逛。' }
        return executor({ root, channels, wakeTurn: turn })
      },
    }),
  )
}

export default { registerChooseOuting, setOutingExecutor, getOutingExecutor, OUTING_CHANNELS }
