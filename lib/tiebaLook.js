/**
 * tiebaLook.js —— `tieba_look`
 *
 * 她自己决定看贴吧的哪一页。定时素材是「醒来时推到面前的」，这个工具是「我现在想看看」。
 * 只读：不发帖、不回帖、不点赞。不告诉她还剩几次、处在第几阶段、开关开没开。
 */

import { defineTool } from './tool.js'
import { loadConfig } from './settings.js'
import { guardWrite } from './tenant.js'
import { rootDir } from './store.js'
import { openForum, openRecommend, openThread, postsFrom, readAuth, renderMaterial, threadsFrom } from './tieba.js'
import { saveFetchedImages } from './media.js'
import { sanitizeForeign } from './guard.js'
import { slashed } from './posix.js'

const KINDS = ['recommend', 'thread', 'forum']

function miss() {
  return { ok: false, text: '', picks: [], note: '现在看不了。' }
}

/** 贴吧链接或裸 id → 帖子号。 */
export function parseThreadId(value) {
  const s = String(value ?? '').trim()
  const m = /\/p\/(\d+)/.exec(s)
  if (m) return m[1]
  if (/^\d{6,}$/.test(s)) return s
  return ''
}

function imageLines(paths) {
  return paths.length ? ['', ...paths.map((p) => `（有图存在 ${slashed(p)}，想看就用 read_image。）`)] : []
}

/**
 * 现场看一次。不记配额、不写事件。
 */
export async function tiebaLookOnce({ root, cfg, kind = 'recommend', id = '', name = '', fetchImpl } = {}) {
  if (!cfg?.tieba?.enabled) return miss()
  const auth = await readAuth(root).catch(() => null)
  if (!auth?.cookie) return miss()
  const k = KINDS.includes(kind) ? kind : 'recommend'
  try {
    if (k === 'thread') {
      const kz = parseThreadId(id)
      if (!kz) return { ok: false, text: '', picks: [], note: '没有帖子号。' }
      const page = await openThread({ cookie: auth.cookie, kz, fetchImpl })
      const parsed = postsFrom(page, 6)
      const body = renderMaterial({ threads: [{ ...parsed, id: parsed.id || kz }], config: cfg })
      if (!body) return { ok: false, text: '', picks: [], note: '这次没看到什么。' }
      let pics = []
      const imgCfg = cfg?.tieba?.images
      if (imgCfg?.enabled !== false) {
        const max = Math.max(1, Math.min(6, Number(imgCfg?.max) || 2))
        const urls = (parsed.posts ?? []).flatMap((p) => p.images ?? []).slice(0, max)
        if (urls.length) {
          pics = await saveFetchedImages(root, urls, {
            fetchImpl,
            referer: 'https://tieba.baidu.com/',
            prefix: 'tieba',
            max,
          })
        }
      }
      const text = [sanitizeForeign(body).text, ...imageLines(pics)].join('\n')
      return { ok: true, text, picks: [], note: '' }
    }
    if (k === 'forum') {
      const kw = String(name || id || '').trim().replace(/吧$/, '')
      if (!kw) return { ok: false, text: '', picks: [], note: '没有吧名。' }
      const page = await openForum({ cookie: auth.cookie, kw, sort: 'hot', fetchImpl })
      const list = threadsFrom(page).slice(0, 8)
      const text = renderMaterial({ forums: [{ name: kw, threads: list }], config: cfg })
      if (!text) return { ok: false, text: '', picks: [], note: '这次没看到什么。' }
      return { ok: true, text, picks: list, note: '' }
    }
    const page = await openRecommend({ cookie: auth.cookie, limit: 8, fetchImpl })
    const list = threadsFrom(page).slice(0, 8)
    const text = renderMaterial({ recommend: list, config: cfg })
    if (!text) return { ok: false, text: '', picks: [], note: '这次没看到什么。' }
    return { ok: true, text, picks: list, note: '' }
  } catch {
    return { ok: false, text: '', picks: [], note: '这次没看到什么。' }
  }
}

export function registerTiebaLook(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }
  return ctx.tools.register(
    defineTool({
      name: 'tieba_look',
      description:
        '看贴吧。kind=recommend 看首页推荐；kind=thread 进一个帖，id 可以是帖号或链接（https://tieba.baidu.com/p/数字）；' +
        'kind=forum 进一个吧，name 写吧名。进帖时楼层里的图会下载到本机并告诉你路径，用 read_image 看。只读，不发帖、不回帖、不点赞。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS, description: 'recommend / thread / forum。默认 recommend。' },
          id: { type: 'string', description: '帖子号或帖子链接。kind=thread 时用。' },
          name: { type: 'string', description: '吧名。kind=forum 时用。' },
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
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看到：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancy, exec, 'tieba_look')
        if (!who.ok) return { ok: false, text: '', note: who.note }
        const { config } = await loadConfig(root)
        const kind = KINDS.includes(String(args?.kind ?? '')) ? String(args.kind) : 'recommend'
        const r = await tiebaLookOnce({
          root,
          cfg: config,
          kind,
          id: args?.id,
          name: args?.name,
        })
        return { ok: r.ok, text: r.text, note: r.note }
      },
    }),
  )
}

export default { registerTiebaLook, tiebaLookOnce, parseThreadId }
