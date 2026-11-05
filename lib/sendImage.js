/**
 * sendImage.js —— 她主动发一张本机图片（2026-11-05，B 方案）
 *
 * 为什么不是「等她回复里出现 image 块」：DSH 的 assistant 消息只有 text / reasoning，
 * 从来不会带 image 块（本机会话统计：3944 chunk / 2560 reasoning / 376 text / 0 image）。
 * 所以走显式工具：她想发，就自己调一次，目标和能不能发由渠道层判断。
 *
 * 三条边界：
 *   - **只在渠道轮里可用**：她跟自己说话（DSH 会话）时没有「对方」，直接拒绝；
 *   - **只发本机图片**：绝对路径、真实文件、认得出是 png/jpg/gif/webp、≤ 8MB；
 *     不接受 http 链接（那是让渠道去上网，不是她的能力）；
 *   - **只在她够得着的地方**：数据目录或她的工作区，别把系统的任意文件发出去。
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { rootDir } from './store.js'
import { sniffMime } from './media.js'
import { currentChannelTurn, getChannelSender } from './channelTurn.js'

const IMAGE_MAX_BYTES = 8 * 1024 * 1024

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function realOrEmpty(p) {
  try { return await realpath(p) } catch { return '' }
}

/**
 * 发一张图（给工具和测试用）。
 * @returns {Promise<{ok:boolean, note:string}>}
 */
export async function sendImageOnce({ root, herDir = '', path = '', caption = '', now = Date.now() } = {}) {
  const turn = currentChannelTurn(now)
  if (!turn) return { ok: false, note: '现在没有在跟谁说话。' }
  const sender = getChannelSender()
  if (!sender) return { ok: false, note: '现在发不了。' }

  const asked = String(path ?? '').trim()
  if (!asked) return { ok: false, note: '要给一个图片路径。' }
  if (/^https?:\/\//i.test(asked)) return { ok: false, note: '只发本机的图片，网上的链接发不了。' }

  const real = await realOrEmpty(asked)
  if (!real) return { ok: false, note: '这张图找不到。' }
  const st = await stat(real).catch(() => null)
  if (!st?.isFile()) return { ok: false, note: '这不是一个文件。' }
  if (st.size <= 0) return { ok: false, note: '这张图是空的。' }
  if (st.size > IMAGE_MAX_BYTES) return { ok: false, note: '这张图太大了。' }

  let head
  try { head = await readFile(real) } catch { return { ok: false, note: '这张图读不出来。' } }
  if (!sniffMime(head)) return { ok: false, note: '这不是一张图片。' }

  // 只发自己够得着的地方：她的数据目录 / 她的工作区。
  const roots = []
  const r1 = root ? await realOrEmpty(root) : ''
  if (r1) roots.push(r1)
  const r2 = herDir ? await realOrEmpty(herDir) : ''
  if (r2) roots.push(r2)
  if (roots.length && !roots.some((parent) => inside(parent, real))) {
    return { ok: false, note: '这张图不在我够得着的地方。' }
  }

  const r = await sender({ path: real, caption: String(caption ?? '') })
  return r?.ok ? { ok: true, note: '' } : { ok: false, note: r?.why || '没发出去。' }
}

export function registerSendImage(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const herDir = String(deps.tenant?.herDir ?? '')
  const tenancy = { root, herDir, tenant: deps.tenant?.tenant ?? { ok: true } }

  return ctx.tools.register(
    defineTool({
      name: 'send_image',
      description:
        '把本机的一张图片发给正在跟你说话的那个人（微信私聊）。只有你在回渠道消息时才用得上；' +
        '你自己在家里说话时没有对方，调用会被拒绝。只发本机文件（png/jpg/gif/webp，≤8MB），' +
        '不抓网上的链接。一次一张；想配一句话就用 caption。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机图片的路径（绝对路径）。' },
          caption: { type: 'string', description: '可选：跟着图片一起发的一句话。' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? '发出去了。' : `没发出去：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancy, exec, 'send_image')
        if (!who.ok) return { ok: false, note: who.note }
        const r = await sendImageOnce({ root, herDir, path: args?.path, caption: args?.caption })
        return { ok: r.ok, note: r.note }
      },
    }),
  )
}

export default { registerSendImage, sendImageOnce }
