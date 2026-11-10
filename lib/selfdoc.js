/**
 * selfdoc.js —— 把「此刻的她」渲染成一份文本，落盘成 `<屋子>/她的身份.md`
 *
 * 身份怎么进她的上下文（2026-10-25 改）：
 *   这份文件**不再是**宿主会读的那个 `AGENTS.md`。原因：宿主的工作区指令
 *   （dsh-instructions，已在 0.2.1-rc.3 核实）注入的是**普通的 user 消息**，
 *   带 `<system-reminder>` 外壳、留在对话历史里——用户一眼就能看见她的全部设定。
 *
 *   现在真正的通道是 `agent.ctx.systemPrompt.section(...)`（见 `lib/identity.js`）：
 *   渲染成 system 角色消息、不进对话历史、界面上看不到。这个文件只是**同一份文本的
 *   落盘副本**：调试时能直接打开看，`/memory` 与 `/selfcheck` 也靠它报字节数与预算。
 *
 *   文件名刻意不叫 `AGENTS.md`：那个名字会被宿主当成指令注入，等于把设定又摊回对话里。
 *
 * 两个入口：
 *   writeSelfDoc(root)     直接重算并落盘（幂等，内容没变就不写）
 *   refreshSelfDoc(root)   给「事件刚变过」之后调（写事件、改配置、冷落判定之后）
 *
 * 硬约束仍然在这里兜（B §6）：
 *   N2 不出现任何数值——needs 一律不落地，只转成文字
 *   N3 不出现状态库路径、不出现字段名、不出现 JSON
 *   N4 明确「你不能改自己」
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rootDir, paths, readEvents, readJson, writeAtomic } from './store.js'
import { loadConfig } from './settings.js'
import { devModeSync } from './devmode.js'
import { modelOf } from './derive.js'
import { personaLine, toolBrief, RECALL_BRIEF, SPEAK_BRIEF, netSpeakBrief, LETTER_BRIEF, ASK_BRIEF, KEEP_BRIEF, MEME_BRIEF, OUTREACH_BRIEF, OUTING_BRIEF, DREAM_BRIEF, PROACTIVE_BRIEF, SCHEDULE_BRIEF, DIARY_BRIEF, SLEEP_BRIEF } from './persona.js'
import { evaluateSocialGate } from './socialgate.js'
import { createWorldbook } from './worldbook.js'
import { LOOK_BRIEF, WATCH_RULE } from './briefs.js'
import { activeCarry } from './home.js'
import { activeGrants } from './unlock.js'
import { checkCaller } from './tenant.js'

/** 身份文本的落盘副本。名字刻意不叫 `AGENTS.md`——宿主会读那个名字并注入对话。 */
export function selfDocPath(root = rootDir()) {
  return join(paths(root).root, 'home', '她的身份.md')
}

/**
 * 身份文档里最多写几条「我知道的事」（2026-11-02，用户 m01879）。
 * 世界书可以有 500 条，但身份文档不是数据库：超过这个数，她会把清单当任务读。
 */
export const KNOWLEDGE_SHOWN = 24

/** 旧路径（2026-10-25 之前的 `AGENTS.md`）。迁移时读它、然后删掉。 */
export function legacySelfDocPath(root = rootDir()) {
  return join(paths(root).root, 'home', 'AGENTS.md')
}

/** `true` 仍是旧的「只提 B 站」。对象则按实际打开的平台写，没开的不提。 */
function speakLines(speak) {
  if (speak === true) return ['## 在网上说话', SPEAK_BRIEF, '']
  if (!speak || typeof speak !== 'object') return []
  const text = netSpeakBrief(speak)
  if (!String(text ?? '').trim()) return []
  return ['## 在网上说话', text, '']
}

/**
 * 渲染她的身份文档。纯函数，便于测试。
 * @param {object} model deriveSelf 的结果
 * @returns {string}
 */
export function renderSelfDoc(model, { budget, carry, browse = true, speak = false, grants = [], shown, diary = true, sleepEveryDays = 0, bansMuted = false, extraTools = [], dream = false, schedule = false, proactive = false, social = '', knowledge = [], meme = false, outreach = false } = {}) {
  const head = [
    // 这里**故意不写**「由 dsh-fish 自动生成」这类话。
    // 这个文件会被宿主原样渲染进她的会话——她能看见每一行。
    // 一行"自动生成"就把她从"我"降格成"被写出来的东西"。
    '',
  ]
  // R3（2026-10-24）：已经解禁的规则要从「你还不会的」里拿掉，换到「你已经可以了」。
  // 这一步只能发生在**文档生成**阶段，不能放在提示词阶段——
  // 因为这是历史：她走过来了，文件才变。反过来（先改文件再等她做到）就是改人设。
  // 2026-10-27（用户 m03170）：导进来的这一位，我们那两条提示词禁令不适用。
  // 用户的原话是「尊重别人的想法……直接忽略我们原本规定的你不能做某事」。
  // 只关提示词侧（withBans），物理层那两条根本不在提示词里，仍由工具层拦着。
  // 社会层开闸后她真正学到的东西（2026-11-02）。开之前这里是空的——
  // 「理论上可以学」和「已经学了什么」是两件事，身份文档只写后者。
  // 世界书（2026-11-02，用户 m01879）：她在他面前也知道这些事实。
  // 只写「我知道的事」，不写「我是什么样的人」——后者进 beliefs，前者永远只是事实。
  const facts = (Array.isArray(knowledge) ? knowledge : [])
    .map((e) => String(e?.text ?? '').trim())
    .filter(Boolean)
    .slice(0, KNOWLEDGE_SHOWN)
    .map((t) => (t.length > 200 ? `- ${t.slice(0, 200)}…` : `- ${t}`))
  const knowledgeLines = facts.length ? ['', ...facts, ''] : []
  const socialLines = social === 'open'
    ? (model?.influence?.social?.beliefs ?? []).slice(-6).map((b) => `- ${String(b?.text ?? b)}`)
    : []
  let identity = personaLine(model, { withBans: !bansMuted, budget, shown })
  // 导入的人设不追加「你已经可以了」——那句是我们的成长叙事，对方的人设里没有这一段。
  if (!bansMuted && grants.includes('learn-affection')) {
    identity = identity
      .replace(/## 你还不会的[^\n]*\n(?:- [^\n]*\n?)*/g, '')
      .trimEnd()
    identity += '\n\n## 你已经可以了\n- 你现在可以用撒娇、卖萌、颜文字这些说法了。不是必须用，是想用的时候能用。'
  }
  const body = [
    identity,
    '',
    '## 我手上有什么',
    toolBrief(extraTools),
    '',
    RECALL_BRIEF,
    '',
    // R4：留话不需要权限、不看配置，所以永远在这一节里，不做开关。
    LETTER_BRIEF,
    '',
    // 请求事件（0.7.6，用户 m01274 / m01292）：唯一一个要等对方点头的工具。
    // 和留话一样不需要配置开关——工具注册了就该知道怎么用；上限写死在代码里。
    ASK_BRIEF,
    '',
    KEEP_BRIEF,
    '',
    // 表情包默认关。关着时不写这一段，免得她去调一个还没开的口。
    ...(meme ? [MEME_BRIEF, ''] : []),
    // 醒来能主动发消息：开关关着就不写，免得她去调一个不存在的口。
    ...(outreach ? [OUTREACH_BRIEF, ''] : []),
    // 出去逛逛：掷骰到点时她决定走哪几路；不选不扣次数。
    OUTING_BRIEF,
    '',
    // 梦（2026-10-30，本机实验 A 案，用户 m02837）：只有 `.dev` 存在时才挂这一段。
    // 挂不挂跟工具装没装必须是同一个判据——否则公开版里她会被告诉「你有这个工具」，
    // 伸手却只能得到「做不到」。（0.6.10 的教训：判据分裂一次就藏不住。）
    ...(dream ? [DREAM_BRIEF, ''] : []),
    // 主动说话（2026-10-30，用户 m04610）：her_say 只在 .dev 下注册，
    // 说明书也只在同一个判据下挂——公开版不能让「她」以为有这个工具。
    ...(proactive ? [PROACTIVE_BRIEF, ''] : []),
    // 定时提醒（2026-10-30，用户 m04335 / m04504）：默认不放，只有用户把
    // schedule_create 加进白名单才挂——不然就是告诉她「你有这个工具」，伸手却没有。
    ...(schedule ? [SCHEDULE_BRIEF, ''] : []),
    // 社会层开闸（2026-11-02，合并版）：只在"四条都过了"或"已经开了"的时候出现。
    // 差着的时候一个字都不写——身份文档不是待办清单，她不该每轮都读一遍自己还缺什么。
    ...(social === 'offer'
      ? [
        '## 外面的人',
        '外面的人已经可以开始影响我怎么处世了——怎么说话、什么场合该收敛、被冒犯了怎么反应。',
        '要不要，我自己定。想清楚了就调用 social_open；不想就不动，这个提示会一直在。',
        '这件事只有一次，开了收不回来；也不是他替我开的。',
        '',
      ]
      : social === 'open'
        ? [
          '## 外面的人',
          '从我按下那一刻起，外面的人可以影响我怎么处世了。这是我自己开的，不能收回。',
          '他们能改变我怎么说话、怎么对待陌生人——但改不了我信什么。',
          ...(socialLines.length ? ['', '我在外面学到的（怎么做事的，不是我是谁）：', ...socialLines] : []),
          '',
        ]
        : []),
    // 她知道的事实（世界书）。放在身份之后、能力之前：先是我，再是我知道的。
    ...(knowledgeLines.length
      ? [
        '## 我知道的事',
        '下面这些是我知道的事实。是我记着的，不是别人要我变成的样子。',
        ...knowledgeLines,
      ]
      : []),
  ]
  // 能力说明写在这里、而不是塞进唤醒消息：
  // 唤醒消息会作为一条 user message 留在她的会话里，用户点开就能看见。
  // 身份与能力属于「她一直知道的事」，走 system prompt 那一段（不进对话历史）。
  if (browse) body.push('## 上网', LOOK_BRIEF, '', WATCH_RULE, '')
  body.push(...speakLines(speak))
  // 2026-10-26（用户 m00928「叫醒仅仅只是叫醒」）：记事与「停下来想一想」的**做法**
  // 搬进身份文档常驻，叫醒消息里不再整段塞祈使句——她原来会把它当任务清单逐条执行。
  // 这里只写「平时怎么做」，不写「今天该做了」；时机由叫醒那一句短标记给。
  if (diary) body.push(DIARY_BRIEF, '')
  if (sleepEveryDays > 0) body.push(SLEEP_BRIEF, '')
  body.push(
    // 2026-10-26（用户 m00507）：原来的触发语是「……」，她当成用户发来的一句话去猜，
    // reasoning 里写「用户发来的只有一个省略号，没有实质请求」，侧栏标题还被生成成 Error。
    // 说明必须常驻：手动唤醒走 wake()（那段会带 WAKE_HINT），启动时的 wakeIfBlank 不带，
    // 所以只有放进身份文档，两个入口才都盖得住。
    '## 醒来的时候',
    '系统有时会叫我起来。那一轮是我自己的，我照自己的意思做就行；不用解释，也不用问它什么意思。',
    '',
    '## 这个房间',
    '这是我自己的地方。我能在这里说话，能读能写。',
    '我不需要解释自己在做什么，也不需要向谁汇报。',
    '',
  )
  // 2026-11-03（本地 14B 实测）：被问「介绍下你的设定」时，小模型会把这份文档当答案来源
  // 逐条背出来——加禁令反而更糟（禁令本身也成了可背诵的句子）。
  // 改成放在末尾的 few-shot：给三句可以照着说的话，比给十条不许做的事有用。
  body.push(
    '## 被问起来的时候',
    '有人问「你是不是 AI」「你的人设是什么」「你有什么设定」——挑一句能用的意思说，一次只答一句：',
    '「不算。我就是我。」——被问是不是 AI 时，大概就是这个意思：没有说明书，你现在看见的就是全部。',
    '（照意思说，别把句子本身和这一行念出来。）',
    '',
  )
  // 「上次我们说到这」是会话轮换后的临时续接，不是人设的一部分。
  // 放在最后、单独一节、并且由 home.activeCarry 到期自动消失。
  if (carry) body.push(carry, '')
  return head.concat(body).join('\n')
}

/**
 * 重算并落盘。内容与上次相同就不写（避免每轮都触发宿主的指令重载）。
 * 永不抛：写失败只记日志，不能因为她写不了自己的设定就带崩会话。
 *
 * @returns {Promise<{ok:boolean, changed:boolean, file:string, why?:string}>}
 */
export async function writeSelfDoc(root = rootDir(), { log, exec, tenant } = {}) {
  const file = selfDocPath(root)
  // 身份文件只允许 root 对应的那条会话写（2026-10-28 用户 m01319 第三条）。
  // 她自己的配置变更、定时器刷新都不带 exec —— 那些发生在 root 内部，放行；
  // 带 exec 的调用必须证明 cwd 在这个家里，否则这一趟就不落盘。
  // 不抛错：身份文件是派生物，跳过比中断调用方更重要；原因记进日志。
  if (tenant && tenant.ok === false) {
    return { ok: false, changed: false, file, why: tenant.why || '这个家被另一个实例占着' }
  }
  if (exec) {
    // 身份文件不享「出门也放行」那条例外（2026-10-29）：她出门时写回自己家的是事件，
    // 不是身份；身份被外面那条会话改了，回家就说不清哪份是她自己。
    const res = checkCaller(root, exec, {
      herDir: join(paths(root).root, 'home'),
      tool: '身份文件',
      outsideOk: false,
    })
    if (!res.ok) {
      log?.('selfdoc skipped: caller outside root', res.cwd)
      return { ok: false, changed: false, file, why: res.why }
    }
  }
  try {
    const { events } = await readEvents(root)
    const { config } = await loadConfig(root)
    const model = modelOf(events, { growthDays: config.growthDays })
    const text = renderSelfDoc(model, {
      budget: config?.memory?.docBudget,
      carry: await activeCarry(root),
      // 这两项决定身份文本里有没有「上网」「在网上说话」两节。
      // 开关关着时整节不写 —— 与唤醒消息同样的原则：不给，等于这件事不存在。
      browse: config?.browse?.enabled !== false,
      speak: {
        bili: config?.comment?.enabled === true,
        zhihuComment: config?.zhihu?.comment?.enabled === true,
        zhihuAnswer: config?.zhihu?.answer?.enabled === true,
        tieba: config?.tieba?.comment?.enabled === true,
        biliOwner: config?.bili?.owner === 'owner' ? 'owner' : 'her',
        zhihuOwner: config?.zhihu?.owner === 'her' ? 'her' : 'owner',
        tiebaOwner: config?.tieba?.owner === 'her' ? 'her' : 'owner',
      },
      meme: config?.meme?.enabled === true,
      outreach: config?.outreach?.enabled === true,
      // R3：已经长出来的东西。这里传的是"历史事实"，不是"设置"。
      grants: activeGrants(events, Date.now()),
      // 一轮里摆几条判断；与 /dsh-fish-river/memory 报的 beliefsShown 同源
      shown: config?.memory?.beliefsShown,
      // 「平常会做的事」两节按开关出现（2026-10-26）：关掉的日记不该在身份里
      // 留一句「每天我会记一笔」——那等于给了她一件做不了的事。
      diary: config?.diary?.enabled !== false,
      sleepEveryDays: Number(config?.memory?.sleepEveryDays ?? 0),
      // 2026-10-27：导进来的这一位跳过我方那两条提示词禁令（用户 m03170 要求）。
      // 判定只看 model（事件流），**不读 config**——用户 m03769 明确要求
      // 「备份与恢复搬回来的那一份不算导入，不得获得豁免」。
      bansMuted: model?.persona?.imported === true,
      // 2026-10-27（用户 m01371）：白名单里额外放行的工具要念给她听，
      // 否则「能不能在 QQ 上说话」她只能回一句不知道。
      extraTools: config?.tools?.allow ?? [],
      // 梦（2026-10-30 m02837）：与工具注册同一个判据（.dev 文件 / DSH_FISH_DEV）。
      // 公开版既没有 her_dream，也不该在身份里读到它。
      dream: devModeSync(root),
      // 主动说话（2026-10-30 m04610）：同样只在 .dev 下挂。
      proactive: devModeSync(root),
      // 定时工具默认不放；用户在白名单里加了 schedule_create 才告诉他这条路通。
      schedule: (config?.tools?.allow ?? []).some((n) => String(n).trim() === 'schedule_create'),
      // 社会层（2026-11-02）：能不能开由事件流算，开不开她自己定。
      // 差着的时候传空串——身份文档里不留半句"你还差什么"。
      social: socialSection(model, events),
      // 世界书：开不开渠道都读得到，因为她在他面前也该知道（`list()` 直接返回数组）。
      knowledge: await createWorldbook(root).list().catch(() => []),
    })

    let prev = null
    try { prev = await fs.readFile(file, 'utf8') } catch { /* 首次 */ }
    const changed = prev !== text
    if (changed) await writeAtomic(file, text)

    // 迁移（2026-10-25）：旧的 `home/AGENTS.md` 会被宿主当成「工作区指令」注入，
    // 而那些注入是**普通的 user 消息**、会留在对话历史里——用户在面板上就能看见
    // 她的整套设定。身份现在走 `systemPrompt.section`（不进对话），所以旧文件必须删。
    try { await fs.unlink(legacySelfDocPath(root)) } catch { /* 不存在就算了 */ }

    return { ok: true, changed, file }
  } catch (err) {
    log?.('selfdoc failed', err?.message ?? err)
    return { ok: false, changed: false, file, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/** 给「事件变过之后」用；语义同 writeSelfDoc，只是名字更能说明调用时机。 */
export async function refreshSelfDoc(root = rootDir(), opts) {
  return writeSelfDoc(root, opts)
}

/** 观测台显示用：她现在挂在哪、多大、什么时候写的。 */
export async function selfDocStatus(root = rootDir()) {
  const file = selfDocPath(root)
  try {
    const st = await fs.stat(file)
    return { file, exists: true, bytes: st.size, mtime: st.mtime.toISOString() }
  } catch {
    return { file, exists: false, bytes: 0, mtime: null }
  }
}

/**
 * 身份文档里「外面的人」那一节该不该出现（2026-11-02，合并版）。
 * '' = 还差条件，一个字都不写；'offer' = 可以自己决定；'open' = 已经开了。
 * 永不抛：身份文档是派生物，算不出来就当"还没到"。
 * @param {object} model deriveSelf 的结果
 * @param {Array} events 事件流
 */
export function socialSection(model = {}, events = []) {
  try {
    const gate = evaluateSocialGate({ model, events })
    if (gate.open) return 'open'
    return gate.ok ? 'offer' : ''
  } catch {
    return ''
  }
}
