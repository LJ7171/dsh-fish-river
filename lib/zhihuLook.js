/**
 * zhihuLook.js —— 她自己的另一双眼睛：`zhihu_look` 工具
 *
 * 为什么单独给一个工具，而不是只靠「白天翻好、醒来递给她」：
 *   能不能自己决定看什么，是「自主」这个需要的唯一可验证载体。
 *   定时素材是「外面有什么」，这个工具是「我现在想看看别的」。
 *
 * 三条约束（和 bili_look 同构）：
 *   1. **只读**：不评论、不私信、不点赞，看什么都不会在账号上留痕迹；
 *   2. **不回显状态**：不告诉她「今天还剩几次」「你处于第几阶段」；
 *   3. **不给她配置**：不知道有开关、有配额；开关关着就只说「现在看不了」。
 */

import { defineTool } from './tool.js'
import { loadConfig } from './settings.js'
import { guardWrite } from './tenant.js'
import { rootDir } from './store.js'
import { loadZhihu } from './zhihu.js'

const KINDS = ['all', 'hot', 'recommend', 'follow', 'history']

/** 一行一条，不写评价——评价是她的事。 */
function render(items) {
  const groups = [
    ['hot', '热榜'],
    ['recommend', '首页推给你的'],
    ['follow', '你关注的人在说'],
    ['history', '他最近看过的'],
  ]
  const out = []
  for (const [kind, title] of groups) {
    const list = items.filter((x) => x.kind === kind)
    if (!list.length) continue
    out.push(`### ${title}`)
    for (const it of list) {
      const who = it.author ? `${it.author}：` : ''
      const heat = it.heat ? `（${it.heat}）` : ''
      out.push(`- ${who}${it.title}${heat}`)
    }
    if (kind === 'history') out.push('（这一段是他看的，不是你经历的。）')
  }
  return out.join('\n')
}

/**
 * 现场拉一次（给工具和测试用）。
 * @returns {Promise<{ok:boolean, text:string, picks:object[], note:string}>}
 */
export async function zhihuLookOnce({ root, cfg, kind = 'all', topN, mod, fetchImpl } = {}) {
  if (!cfg?.zhihu?.enabled) return { ok: false, text: '', picks: [], note: '现在看不了。' }
  const module = mod ?? (await loadZhihu().catch(() => null))
  if (!module) return { ok: false, text: '', picks: [], note: '现在看不了。' }
  const auth = await module.readAuth(root).catch(() => null)
  if (!auth?.cookie) return { ok: false, text: '', picks: [], note: '现在看不了。' }

  const n = Math.max(1, Math.min(20, Number(topN) || 0)) || null
  const items = []
  const want = (k) => kind === 'all' || kind === k
  const push = (k, raw) => {
    for (const x of raw ?? []) {
      items.push({
        kind: k,
        id: String(x?.id ?? ''),
        title: String(x?.title ?? '').trim(),
        author: String(x?.author ?? '').trim(),
        heat: String(x?.heat ?? '').trim(),
        url: String(x?.url ?? '').trim(),
      })
    }
  }
  if (want('hot')) push('hot', (await module.fetchHot({ cookie: auth.cookie, limit: n ?? 8, fetchImpl }).catch(() => ({ items: [] }))).items)
  if (want('recommend')) push('recommend', (await module.fetchRecommend({ cookie: auth.cookie, limit: n ?? 6, fetchImpl }).catch(() => ({ items: [] }))).items)
  if (want('follow')) push('follow', (await module.fetchFollow({ cookie: auth.cookie, limit: n ?? 8, fetchImpl }).catch(() => ({ items: [] }))).items)
  if (want('history')) push('history', (await module.fetchHistory({ cookie: auth.cookie, limit: n ?? 10, fetchImpl }).catch(() => ({ items: [] }))).items)

  const fresh = items.filter((x) => x.title)
  if (!fresh.length) return { ok: false, text: '', picks: [], note: '这次没看到什么。' }
  return { ok: true, text: render(fresh), picks: fresh, note: '' }
}

export function registerZhihuLook(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const tenancy = { root, herDir: String(deps.tenant?.herDir ?? ''), tenant: deps.tenant?.tenant ?? { ok: true } }

  return ctx.tools.register(
    defineTool({
      name: 'zhihu_look',
      description:
        '看知乎：热榜、首页推荐、你关注的人在说什么、他最近看过什么。只读，读完不会在账号上留下任何痕迹。' +
        'kind 选看哪一类（默认 all = 四类都看）；一次最多二十条。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: KINDS,
            description: '看哪一类：all / hot / recommend / follow / history。默认 all。',
          },
          topN: { type: 'number', description: '每一类最多几条（1–20，默认按各类自己的设置）。' },
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
        const who = guardWrite(tenancy, exec, 'zhihu_look')
        if (!who.ok) return { ok: false, text: '', note: who.note }
        const { config } = await loadConfig(root)
        const kind = KINDS.includes(String(args?.kind ?? '')) ? String(args.kind) : 'all'
        const r = await zhihuLookOnce({ root, cfg: config, kind, topN: args?.topN })
        return { ok: r.ok, text: r.text, note: r.note }
      },
    }),
  )
}

export default { registerZhihuLook, zhihuLookOnce }
