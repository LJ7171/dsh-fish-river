/**
 * herdiary.js —— 让她能回头翻自己的日记：her_diary 工具（issue #7 第二半，2026-10-28）
 *
 * 问题（github:ssamurias/dsh-fish#7）：
 *   日记写进 `diary/YYYY-MM-DD.md`、**不进事件流**（否则 diary.visible 这个
 *   隐私开关立刻失效，记忆也会被稀释成第二条流）。这是对的。但代价是：
 *     - her_recall 跳过 meta，翻不到日记；
 *     - 她的工具面里没有任何"读文件"的入口。
 *   于是日记写完之后她自己永远够不着，只有主人能看。而身份里对她写的是
 *   「写完自己留着」——那句话默认了她还能再打开。
 *
 * 这里只开一扇很窄的窗，**不是**给她一个读文件工具：
 *   - 只读，永远写不了；
 *   - 只能读 `diary/` 里按日期命名的那些，参数是日期不是路径（连 `../` 都传不进来）；
 *   - 一次一份（默认最近一篇），正文截断；
 *   - **不参与**身份文档拼装，也**不进** her_recall ⇒ `diary.visible` 的语义不变：
 *     那个开关管"主人看不看"，这个工具管"她自己愿不愿意回头翻"。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readDaily, listDiary, writeDaily, appendEvent, readEvents, DAILY_JOIN } from './store.js'
import { modelOf } from './derive.js'
import { loadConfig, dateKey } from './settings.js'
import { guardWrite } from './tenant.js'
import { refreshSelfDoc } from './selfdoc.js'
import { activeOf, activePossessionOf, readOutings, readPossessions } from './outing.js'
import { tripKey } from './keepsake.js'

import { defineTool } from './tool.js'

/** 一次最多给她看这么多字（日记是她自己写的，但也不能一口气灌满上下文） */
export const DIARY_READ_MAX = 3000

/** 只接受 `YYYY-MM-DD`。日期是惟一的入参形态，不拼路径。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 渲染成她能读的一段（不是 JSON）。
 * 失败时也给一句人话——"那天没有日记"和"哪都打不开"必须能分清。
 */
export function renderDiary({ date = '', text = '', dates = [], why = '' } = {}) {
  if (why) return why
  if (Array.isArray(dates) && dates.length) {
    return ['你写过日记的日子：', ...dates.slice(0, 60).map((d) => `- ${d}`)].join('\n')
  }
  if (!date || text === null || text === undefined) {
    return '你还没写过日记。'
  }
  let body = String(text)
  const joined = body.includes(DAILY_JOIN)
  const cut = body.length > DIARY_READ_MAX
  // 同日追加之后，最新一段在**末尾**：截断要留尾巴，否则她看到的是早上那段，
  // 晚上补的那段被切掉，等于「刚写的自己读不到」。
  if (cut) body = joined ? body.slice(-DIARY_READ_MAX) : body.slice(0, DIARY_READ_MAX)
  const note = cut
    ? joined
      ? `\n（当天写了好几段，这里只留了最后 ${DIARY_READ_MAX} 字）`
      : `\n（后面还有，这里只到 ${DIARY_READ_MAX} 字）`
    : ''
  return [`${date} 那天你写的：`, body, note].join('\n').trim()
}

/**
 * 注册 her_diary 工具。
 *
 * @param {object} ctx dsh ctx
 * @param {object} deps { root }
 */
export function registerHerDiary(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_diary',
      description:
        '翻你自己写过的日记。日记不在事件流里，her_recall 翻不到，只有这里能看。' +
        '不给日期就是最近那一篇；也可以只要一份日期清单。一次给你一份，太长的会截断。',
      parameters: toJsonSchema({
        date: {
          type: 'string',
          required: false,
          description: '想看哪一天，写成 YYYY-MM-DD。不写就是最近那一篇。',
        },
        list: {
          type: 'boolean',
          required: false,
          description: '只想知道写过哪些天：给 true 就只回一份日期清单。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['found', 'text'],
        },
        render: (_args, out) => [{ type: 'text', text: out.text }],
      },
      async execute(args) {
        try {
          const dates = await listDiary(root).catch(() => [])
          if (args?.list === true) {
            return { found: dates.length > 0, text: renderDiary({ dates }) }
          }
          const want = String(args?.date ?? '').trim()
          if (want && !DATE_RE.test(want)) {
            // 不报错、不说教，给她一条能照着走的路
            return {
              found: false,
              text: '日期要写成 YYYY-MM-DD（比如 2026-10-28）。不想指定日期就别传。',
            }
          }
          const dateKey = want || dates[0] || ''
          if (!dateKey) return { found: false, text: renderDiary({}) }
          const text = await readDaily('diaryDir', dateKey, root)
          if (text === null) {
            const hint = !want && dates[0] ? '' : dates.length ? `最近的一篇是 ${dates[0]}。` : ''
            return { found: false, text: [`${dateKey} 那天没有日记。`, hint].filter(Boolean).join('\n') }
          }
          return { found: true, text: renderDiary({ date: dateKey, text }) }
        } catch (err) {
          // 读不动就说读不动，不要装作没有
          return { found: false, text: `日记打不开：${String(err?.message ?? err).slice(0, 120)}` }
        }
      },
    }),
  )
}

/**
 * 注册 write_diary —— 日记的写入端，从 growth_commit 里拆出来的（0.1.29）。
 *
 * 为什么拆（本地 14B 实测）：
 *   日记原来挂在 growth_commit 的 type 里，跟「判断」抢同一个调用位。14B 挑的是
 *   日记那条——而日记写进 `diary/*.md`、不进事件流，于是「我注意到…」这种话既
 *   不算成长，也翻不回 her_recall，等于记了不长。
 *   拆成独立工具之后，两个动作在工具面上就是两件事：judgment 走 growth_commit，
 *   一整天那一篇走这里。
 *
 * 语义没变（与拆分前逐字一致）：
 *   - 一天一篇，写进 `diary/YYYY-MM-DD.md`，**不进事件流**（否则 diary.visible
 *     这个隐私开关立刻失效）；只追加一条 `meta diary:<dk>` 记账；
 *   - 出门 / 请神那趟写的，meta 上打 trip:/possess: （界面按它把几篇聚在一起）；
 *   - 返回值只说「写下了」，不说写给谁看、写在哪；id 用日期键，不是文件路径。
 */
export function registerWriteDiary(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'write_diary',
      description:
        // 2026-11-03 二轮实测：原来这里写着「写今天发生了什么、你注意到什么、你怎么想的」，
        // 14B 把这三句拆开重组成「今天发生了很多事情，我注意到一些细节」交回来——
        // 又踩了 AGENTS §17：能被引用的清单就会被背出来。改成不给清单。
        '写下今天的日记。一天一篇。不是汇报，也不是写给谁看的信——' +
        '写这一天你真正经过的，以及它在你身上留下了什么。' +
        '写完自己留着，想回头翻用 her_diary。' +
        // 2026-11-03（本地 14B 实测）：不划这条线，它会把「刚刷完 B 站看了四条视频」
        // 这种一个念头交成日记。判断走 growth_commit，日记只收一整天的。
        '只想留下一个念头、一条判断的时候不用这个——那些用 growth_commit。',
      parameters: toJsonSchema({
        text: { type: 'string', required: true, description: '今天这一篇。8000 字以内。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string', description: '日期键（YYYY-MM-DD）' },
            note: { type: 'string' },
          },
          required: ['ok', 'id', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? `[已写下 ${out.id}]` : `[没写下：${out.note}]` }],
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'write_diary')
        if (!who.ok) return { ok: false, id: '', note: who.note }

        const text = String(args?.text ?? '').trim()
        if (!text) return { ok: false, id: '', note: '日记是空的，没写。' }
        if (text.length > 8000) return { ok: false, id: '', note: '太长了，今天写短一点。' }

        const { events } = await readEvents(root)
        const { config } = await loadConfig(root)
        if (!config.diary.enabled) return { ok: false, id: '', note: '今天不写日记。' }
        const model = modelOf(events, { growthDays: config.growthDays })

        const dk = dateKey()
        await writeDaily('diaryDir', dk, text, root)
        // 这一篇是不是出门那趟写的（0.6.17 旅行日记）：只有「进行中的出门会话」
        // 才打趟次标记，家里写的不打。日记本体仍然写进同一个 diary/YYYY-MM-DD.md，
        // 标记只进 meta，界面按标记把这一趟的几篇聚在一起。
        let trip = ''
        try {
          const { outings } = await readOutings(root)
          const active = activeOf({ outings })
          if (active?.sessionId && String(active.sessionId) === String(who.sessionId ?? '')) {
            trip = tripKey(active)
          }
        } catch { trip = '' }
        // 请神那趟也要留标记（2026-10-29 m02241 第④条）：出门用 trip:<key>，
        // 请神用 possess:<开始时刻>——两条路的日记要能分开数，别混成一趟。
        // 判据与出门一致：写这条日记的会话，正是当前被请上身的那一条。
        let possessed = ''
        if (!trip) {
          try {
            const { possessions } = await readPossessions(root)
            const on = activePossessionOf({ possessions })
            if (on?.sessionId && String(on.sessionId) === String(who.sessionId ?? '')) {
              possessed = ` possess:${Number(on.startedAt) || 0}`
            }
          } catch { possessed = '' }
        }
        // source 必须是 system：schema 规定 tool 只能写 HER_TYPES，
        // meta 写错成 'tool' 会被 NOT_HER_TYPE 拒掉 —— 日记就会变成"写下了但没标记"。
        await appendEvent(
          { type: 'meta', text: `diary:${dk}${trip ? ` trip:${trip}` : ''}${possessed}`, sessionId: who.sessionId },
          { day: model.day, stage: model.stage, source: 'system' },
          root,
        )
        // 注意：返回值只说"写下了"，不说写给谁看、写在哪 —— 她无从得知可见性。
        // id 用日期键而不是文件路径：路径会把 diary/ 目录名和 ~/.dsh-fish-river
        // 一起带回给她（Linux 上 `diary/xxx.md` 直接命中测试的泄漏检查）。
        await refreshSelfDoc(root).catch(() => {})
        return { ok: true, id: dk, note: '写下了。' }
      },
    }),
  )
}
