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
 *   - 只在她自己的醒来回合里可用（`wakeTurn`，和 send_to_owner 同一条时间窗）；
 *   - 不告诉她今天还剩几次、也不提阶段——选到没次数的路，只会回一句“今天不去了”。
 */

import { defineTool } from '../../core/tool.js'
import { guardWrite } from '../../house/tenant.js'
import { rootDir } from '../../core/store.js'
import { currentWakeTurn } from '../schedule/wakeTurn.js'

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

export const OUTING_CHANNELS = Object.freeze(['bili', 'douyin', 'zhihu', 'tieba'])

export function registerChooseOuting(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }

  return ctx.tools.register(
    defineTool({
      name: 'choose_outing',
      description:
        '出去走走。把这次想去的地方写进 channels：bili（B 站）、douyin（抖音）、zhihu（知乎）、tieba（贴吧）。' +
        '可以只去一个，也可以去几个；一个都不选，就是这次不出门，不会占次数。' +
        '两个号都在的时候，可以用 account 写 a 或 b；不同平台要分别选，就写 accounts：{ bili: "a", zhihu: "b" }。只有一个号就不用写。' +
        '只在你自己的醒来回合里能用；回来会告诉你这些地方此刻有什么。',
      parameters: {
        type: 'object',
        properties: {
          channels: {
            type: 'array',
            items: { type: 'string', enum: OUTING_CHANNELS },
            description: '想去的地方；空数组 = 这次不出门。',
          },
          account: {
            type: 'string',
            description: '两个号都在的时候写 a 或 b；所有平台共用一个选择。只有一个号就不用写。',
          },
          accounts: {
            type: 'object',
            description: '按平台分别选号；只写想单独指定的平台。',
            properties: {
              bili: { type: 'string' },
              douyin: { type: 'string' },
              zhihu: { type: 'string' },
              tieba: { type: 'string' },
            },
            additionalProperties: false,
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
        const accounts = {}
        const rawAccounts = args?.accounts && typeof args.accounts === 'object' && !Array.isArray(args.accounts) ? args.accounts : {}
        for (const ch of OUTING_CHANNELS) {
          const v = String(rawAccounts[ch] ?? '').trim()
          if (v) accounts[ch] = v
        }
        return executor({
          root,
          channels,
          account: String(args?.account ?? '').trim(),
          accounts,
          wakeTurn: turn,
        })
      },
    }),
  )
}

export default { registerChooseOuting, setOutingExecutor, getOutingExecutor, OUTING_CHANNELS }
