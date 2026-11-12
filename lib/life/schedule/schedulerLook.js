/**
 * schedulerLook.js —— 醒来前「看见点东西」的四路素材。
 *
 * 从 scheduler.js 抽出来（2026-11-09）：它们只依赖配置、状态文件和网络客户端，
 * 不碰调度器闭包里的 running/lastTick/ctx。留在 scheduler 里会让「生物钟」和
 * 「刷站」两件事混在 1500 行里。
 */

import { appendEvent, readEvents } from '../../core/store.js'
import { dailyQuota, inWindow } from '../../core/settings.js'
import { createClient } from '../../platforms/bili/bili.js'
import { gather, browseCountToday, recordBrowse } from '../../platforms/bili/browse.js'
import { gatherDouyin, douyinCountToday } from '../../platforms/douyin/douyinbrowse.js'
import { fetchZhihuMaterial } from '../../platforms/zhihu/zhihu.js'
import { fetchTiebaMaterial } from '../../platforms/tieba/tieba.js'
import { zhihuLookMeta, tiebaLookMeta } from '../../platforms/common/lookmeta.js'
import { riskState, browsePlan, noteRisk, isRiskCode } from '../../platforms/bili/risk.js'
import { readSleep, diceOpen, sleepEnabled } from './sleep.js'
import { pace } from '../../core/pacing.js'

/**
 * 醒之前让她"看见点东西"。
 *
 * 三个刻意的取舍：
 *   1. **刷站失败不算唤醒失败**。今天看不到就等于今天没看到，照样让她说话。
 *      （一个只能在社会条件齐全时才存在的人格，是脆的。）
 *   2. **配额单独算**（browse.perDay），与每日事件数无关。看几次和说几句话是两件事。
 *   3. **只给素材，不给结论**。全部网络文本在 browse.renderMaterial 里统一包成"素材"。
 *
 * @returns {Promise<{text:string, intro:string, picks:object[]}>}
 */
export async function biliLook(root, model, config, dk, deps, log) {
  const empty = { text: '', intro: '', picks: [], acted: false, blocked: false }
  if (!config?.browse?.enabled) return empty
  if (config?.browse?.homeEnabled === false) return empty // “逛的内容”没勾首页：这一路不出门
  const perDay = dailyQuota(config, 'bili')
  // forceBrowse（2026-10-26）：设置页那个「让她去刷 B 站」按钮专用。
  // 它只在**本机测试版**出现，用途就是验证「她到底能不能刷」——所以绕过
  // 当日上限与上网时段，别的什么都不改（素材仍然现场取、风控仍然生效）。
  const forced = deps.forceBrowse === true
  if (!forced && !(perDay > 0)) return empty

  // 上网时段（2026-10-23 加）：醒来和上网是两件事。
  // 醒了但不在上网时段 → 今天这轮不上网，她只说话、写日记。
  // 没配就退回全局时段，保持旧行为。
  const bw = Array.isArray(config?.browse?.window) ? config.browse.window
    : Array.isArray(config?.window) ? config.window
      : ['00:00', '23:59'] // 两处都没配 → 全天可上网，保持旧行为
  // deps.now 只为测试注入：线上永远走 new Date()。
  const gate = await browseGate(config, root, deps)
  if (!forced && gate.block) return { ...empty, blocked: true }
  if (!forced && !gate.skipWindow && !inWindow({ window: bw }, deps.now ?? new Date())) return { ...empty, blocked: true }

  // 风控闸（2026-10-23）：被锁着就不碰 B 站，但人照样醒。
  // 以前的做法是"接口失败 → 静默返回空"，于是页面看起来像"她今天什么都没说"，
  // 而真相是被限流了。现在至少给她一句当时的处境，也给我们一个明确的日志。
  const st = riskState(root, deps.now ?? new Date())
  if (st.cooling) {
    log?.('risk cooldown', `还有 ${st.remainMin} 分钟`)
    return { ...empty, blocked: true, riskNote: '今天网络不太顺，什么都没翻到。过一阵再看。' }
  }

  try {
    const events = deps.events ?? (await readEvents(root)).events
    // 今天的次数用完就不刷了。注意：**素材是每次唤醒现场取的，不缓存**——
    // 缓存会让她连着几天看同一批东西，那是投喂，不是刷站。
    if (!forced && browseCountToday(events, dk) >= perDay) return { ...empty, blocked: true }

    // 刚被风控过 → 减半试探。不是"恢复原样当没发生过"，
    // 因为下一次撞墙的罚则会比这次更久。
    const bp = browsePlan(config, st)
    const deepRead = config?.browse?.hotEnabled === false ? 0 : bp.deepRead
    const danmaku = config?.browse?.danmakuEnabled === false ? 0 : Number(config?.browse?.danmaku ?? 0)
    const cfg2 = (bp.topN === Number(config?.browse?.topN) && deepRead === Number(config?.browse?.deepRead) && danmaku === Number(config?.browse?.danmaku))
      ? config
      : { ...config, browse: { ...config.browse, topN: bp.topN, deepRead, danmaku } }

    const client = deps.client ?? createClient({ log: (...a) => log?.('bili', ...a) })
    const r = await gather(client, model, cfg2, { root, dk, events })
    if (!r.ok || !r.text) {
      // 只把 B 站亲自回的 -352/-412/-509 记成持久罚则。
      // 我们自己的 COOLDOWN（内存里那 60 秒）不是证据，不能记——否则一次小磕碰会自我加码。
      if (isRiskCode(r.code)) noteRisk(root, r.code, deps.now ?? new Date())
      if (r.note) log?.('browse empty', r.note)
      return empty
    }
    await recordBrowse(root, dk, r.picks, model)
    return {
      acted: true,
      blocked: false,
      text: r.text,
      intro: '## 你刚醒，屏幕上有人在说话\n这是平台此刻推到你面前的东西。你可以看，也可以不看。',
      picks: r.picks,
    }
  } catch (err) {
    if (isRiskCode(err?.code)) noteRisk(root, err?.code, deps.now ?? new Date())
    log?.('browse failed', err?.message ?? err)
    return empty
  }
}

/** 刷抖音的那一半（2026-11-02，用户 m03490）。和 B 站同一条路，但各刷各的配额。 */
export async function douyinLook(root, model, config, dk, deps, log) {
  const empty = { text: '', intro: '', picks: [], note: '', acted: false, blocked: false }
  const dy = config?.browse?.douyin
  if (!dy || dy.enabled !== true) return empty
  const forced = deps.forceBrowse === true
  const perDay = dailyQuota(config, 'douyin')
  if (!forced && !(perDay > 0)) return empty
  // 空数组 = 「跟 B 站同一个时间段」（设置页是这么写的），不能当成「哪个时段都不行」。
  const bw = Array.isArray(dy.window) && dy.window.length ? dy.window
    : Array.isArray(config?.browse?.window) && config.browse.window.length ? config.browse.window
      : ['00:00', '23:59']
  const gate = await browseGate(config, root, deps)
  if (!forced && gate.block) return { ...empty, blocked: true }
  if (!forced && !gate.skipWindow && !inWindow({ window: bw }, deps.now ?? new Date())) return { ...empty, blocked: true }
  try {
    const events = deps.events ?? (await readEvents(root)).events
    if (!forced && douyinCountToday(events, dk) >= perDay) return { ...empty, blocked: true }
    // 抖音走浏览器请求，也按同一份「请求节奏」排队（注入 feed 的测试不等）。
    if (typeof deps.douyinFeed !== 'function') await pace()
    const r = await gatherDouyin({ model, cfg: config, root, dk, events, feed: deps.douyinFeed })
    if (!r.ok || !r.text) {
      if (r.note) log?.('douyin browse empty', r.note)
      return empty
    }
    return { text: r.text, intro: '', picks: r.picks, acted: true, blocked: false }
  } catch (err) {
    log?.('douyin browse failed', err?.message ?? err)
    return empty
  }
}

/**
 * 知乎那一半（2026-11-04，只读）：热榜 + 关注动态。
 *
 * 和刷站的区别：它不写事件流、不进 people、不叫醒任何人——只在她本来要醒的时候
 * 递一段「今天外面在说什么」。配额记在 `<root>/zhihu-state.json`，不占她的记忆。
 */
export async function browseGate(config, root, deps) {
  if (!sleepEnabled(config)) return { block: false, skipWindow: false }
  const st = deps.sleepState ?? await readSleep(root).catch(() => null)
  const g = diceOpen(config, st)
  if (!g.governed) return { block: false, skipWindow: false }
  if (!g.open) return { block: true, skipWindow: true }
  return { block: false, skipWindow: true }
}

export async function tiebaLook(root, model, config, dk, deps, log) {
  const empty = { text: '', intro: '', picks: [], acted: false, blocked: false }
  if (!config?.tieba?.enabled) return empty
  const gate = await browseGate(config, root, deps)
  if (!deps.forceBrowse && gate.block) return { ...empty, blocked: true }
  try {
    const r = await fetchTiebaMaterial({
      root,
      cfg: config,
      now: deps.now ?? new Date(),
      fetchImpl: deps.tiebaFetch,
    })
    if (!r.ok) return { ...empty, acted: r.acted === true, blocked: r.blocked === true, why: r.why }
    const meta = tiebaLookMeta(dk, r.picks)
    if (meta) await appendEvent({ type: 'meta', text: meta }, { day: Number(model?.day ?? 0), stage: Number(model?.stage ?? 1), source: 'system' }, root).catch(() => {})
    return { text: r.text, intro: '', picks: r.picks, acted: true, blocked: false }
  } catch (err) {
    log?.('tieba look failed', err?.message ?? err)
    return empty
  }
}

export async function zhihuLook(root, model, config, dk, deps, log) {
  const empty = { text: '', intro: '', picks: [], acted: false, blocked: false }
  const z = config?.zhihu
  if (!z || z.enabled !== true) return empty
  const gate = await browseGate(config, root, deps)
  if (!deps.forceBrowse && gate.block) return { ...empty, blocked: true }
  // 2026-11-05：和刷 B 站一致——醒来现场抓一次，当次递；不再预翻、不再攒 pending。
  try {
    const r = await fetchZhihuMaterial({
      root,
      cfg: config,
      now: deps.now ?? new Date(),
      fetchImpl: deps.zhihuFetch,
      mod: deps.zhihuMod,
      log,
    })
    if (!r.ok) return { ...empty, acted: r.acted === true, blocked: r.blocked === true, why: r.why }
    const meta = zhihuLookMeta(dk, r.picks)
    if (meta) await appendEvent({ type: 'meta', text: meta }, { day: Number(model?.day ?? 0), stage: Number(model?.stage ?? 1), source: 'system' }, root).catch(() => {})
    return { text: r.text, intro: '', picks: r.picks, acted: true, blocked: false }
  } catch (err) {
    log?.('zhihu look failed', err?.message ?? err)
    return empty
  }
}

/**
 * 醒之前让她"看见点东西"：B 站 + 抖音（可选）+ 知乎（可选）+ 贴吧（可选）。
 * 全部失败就等于今天没看到，照样让她说话。
 */
export async function lookBeforeWake(root, model, config, dk, deps, log) {
  const blank = { text: '', intro: '', picks: [], acted: false, blocked: false }
  const allow = (name) => !Array.isArray(deps?.channels) || deps.channels.includes(name)
  const bili = allow('bili') ? await biliLook(root, model, config, dk, deps, log).catch(() => blank) : blank
  const dy = allow('douyin') ? await douyinLook(root, model, config, dk, deps, log).catch(() => blank) : blank
  const zh = allow('zhihu') ? await zhihuLook(root, model, config, dk, deps, log).catch(() => blank) : blank
  const tb = allow('tieba') ? await tiebaLook(root, model, config, dk, deps, log).catch(() => blank) : blank
  const acted = {}
  const blocked = {}
  if (bili.acted) acted.bili = true
  if (dy.acted) acted.douyin = true
  if (zh.acted) acted.zhihu = true
  if (tb.acted) acted.tieba = true
  if (bili.blocked) blocked.bili = true
  if (dy.blocked) blocked.douyin = true
  if (zh.blocked) blocked.zhihu = true
  if (tb.blocked) blocked.tieba = true
  const picks = [...(bili.picks ?? []), ...(dy.picks ?? []), ...(zh.picks ?? []), ...(tb.picks ?? [])]
  // 风控/失败时的说法要原样带上（2026-11-02）：以前只看 B 站，这句只在 biliLook 里，
  // 合并成两路之后必须在外面接住，否则「今天网络不太顺」就丢了。
  const riskNote = bili.riskNote ?? dy.riskNote ?? ''
  const extra = riskNote ? { riskNote } : {}
  const parts = [bili.text, dy.text, zh.text, tb.text].filter(Boolean)
  if (!parts.length) return { text: '', intro: '', picks, acted, blocked, ...extra }
  return {
    acted,
    blocked,
    text: parts.join('\n\n'),
    // 知乎的素材自带小标题（## 今天外面在说这些），不加一遍总 intro 会重复。
    intro: '## 你刚醒，屏幕上有人在说话\n这是平台此刻推到你面前的东西。你可以看，也可以不看。',
    picks,
    ...extra,
  }
}

/**
 * 唤醒那一刻的时间与缘由（2026-10-27 用户反馈）。
 *
 * 她在会话里第一次醒来时，只看到「（醒一醒）」，然后自己猜「大概不是我的时段」，
 * 还以为是权限出了问题。与其让她猜，不如把事实摆给她：现在几点、这一次是谁让醒的。
 *
 * `manual` = 有人按了叫醒（观测台按钮 / 首次建屋），否则是定时醒来；
 * `insideWindow` = 这一刻在不在她平时的活动时段里（跨零点窗口也交给 inWindow 判）。
 */
