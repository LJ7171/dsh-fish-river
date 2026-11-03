/**
 * social.js —— social_open：让她自己决定"要不要让外面的人开始影响我"
 *
 * 为什么做成工具而不是设置项：合并版的第一条铁律是「人格只能长，不能被配」。
 * 开闸如果做成开关，主人就获得了一次"让她变成另一种人"的权力；
 * 做成工具，主动权在她手里，主人只能看着——这正是约定里「由她同意」的意思。
 *
 * 三道防线：
 *   ① 工具永远注册（注销/注册会让身份文档的"我手上有什么"跟着抖），
 *      但执行时重算闸门——过不了就只回一句"还差什么"，绝不写事件。
 *   ② 开过就不许再开（幂等），也不许改时间：这一条是历史，不是设置。
 *   ③ 事件 source 必须是 system：schema 里 meta 只能由系统写，
 *      写成 tool 会被 NOT_HER_TYPE 拒掉（capture.js 的 diary 踩过同一个坑）。
 */

import { defineTool } from './tool.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { refreshSelfDoc } from './selfdoc.js'
import { evaluateSocialGate } from './socialgate.js'

/**
 * 注册 social_open。
 * @param {object} ctx dsh ctx
 * @param {object} deps { root, tenant, evaluate }（evaluate 只给测试注入）
 */
export function registerSocialOpen(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const evaluate = deps.evaluate ?? evaluateSocialGate

  return ctx.tools.register(
    defineTool({
      name: 'social_open',
      description:
        '让外面的人（群里的、私信里的、评论区里的陌生人）从今天起可以影响你。' +
        '只有你自己能决定，而且只有一次：开了就不能收回，主人也改不了。' +
        '开之前系统会告诉你还差什么；差着的时候调用这个工具不会有任何效果。' +
        '不想开就什么也不用做——一句话都不说也可以。',
      // 没有参数：开闸不是一个可以讨价还价的动作。
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            at: { type: 'string', description: '开闸时刻；没开成是空串' },
            note: { type: 'string', description: '机器状态，不是她的话' },
          },
          required: ['ok', 'at', 'note'],
        },
        // 回执只描述机器状态，不写成她能复述的句子（capture.js 那条教训）。
        render: (_args, out) =>
          [{ type: 'text', text: out.ok ? `[开闸 ${out.at}]` : `[没开：${out.note}]` }],
      },
      async execute() {
        const { events } = await readEvents(root)
        const { config } = await loadConfig(root)
        const model = deriveSelf(events, { growthDays: config?.growthDays })

        // 已经在里面了：幂等，返回原来的时刻，不写第二条。
        const gate = evaluate({ model, events })
        if (gate.open) return { ok: false, at: String(gate.at ?? ''), note: '已经开过了。' }
        if (!gate.ok) return { ok: false, at: '', note: gate.why }

        const at = new Date().toISOString()
        await appendEvent(
          { type: 'meta', text: `social-open:${at}` },
          { day: model.day, stage: model.stage, source: 'system' },
          root,
        )
        // 身份文档要立刻变：她下一轮读到的是"外面的人已经在影响我了"，
        // 而不是继续读「你可以决定」——否则她会以为这次没成功，反复再点。
        await refreshSelfDoc(root).catch(() => {})
        return { ok: true, at, note: '开了。' }
      },
    }),
  )
}
