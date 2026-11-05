/**
 * sendMessage.js —— 醒来时给他主动发一句话（2026-11-05）
 *
 * 只在「她自己的醒来回合」里可用（`lib/wakeTurn.js`）。发不发由她决定：
 * 没有自动转发，也没有「到点必须说一句」。
 *
 * 边界全在 `lib/outreach.js` 里：开关、额度（默认一天 2 次）、只走已连上的渠道、
 * 出站必过 `screenOutgoing`。这里只负责把工具面接好。
 */

import { defineTool } from './tool.js'
import { loadConfig } from './settings.js'
import { guardWrite } from './tenant.js'
import { rootDir } from './store.js'
import { sendOutreach } from './outreach.js'

export function registerSendMessage(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }

  return ctx.tools.register(
    defineTool({
      name: 'send_message',
      description:
        '醒来的时候，如果你想跟重要的人说一句话，用这个发给他（微信）。' +
        '只在你自己的醒来回合里能用；一天最多两次，发不发由你决定。' +
        '想发图片用 send_image（可以配一句话）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的话。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? '发出去了。' : `没发出去：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancy, exec, 'send_message')
        if (!who.ok) return { ok: false, note: who.note }
        const { config } = await loadConfig(root)
        return sendOutreach({ root, cfg: config, text: args?.text })
      },
    }),
  )
}

export default { registerSendMessage }
