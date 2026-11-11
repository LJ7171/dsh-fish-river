/**
 * outreach.js —— 醒来时她主动找重要的人（2026-11-05，用户要求）
 *
 * 只在「她自己的醒来回合」里可用：定时醒来、手动叫醒。她得自己调工具才发，
 * 没有自动转发——发不发由她决定。
 *
 * 三条边界：
 *   - **一天最多 `outreach.perDay` 次**（默认 2）：文字、图片、图配文都只算一次；
 *     被拒的调用不占次数。
 *   - **只走已连上的渠道**（现在只有微信 ClawBot）：目标取 `channels.<channel>.ownerId`；
 *     微信还需要一条你发来的消息带来的 `context_token`（适配器负责持久化）。
 *   - **出站必过 `screenOutgoing`**，和渠道回复同一道闸；被拦就一句「这句不能发出去。」，
 *     不解释为什么。
 *
 * 发出去之后由渠道层（host.js 注册的 sender）记流水与 `utterance` 事件——
 * 她的记忆里必须真的有这句话，不能只出现在微信里。
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { dateKey } from '../core/settings.js'
import { screenOutgoing } from '../core/guard.js'
import { writeAtomic } from '../core/store.js'
import { withSerial } from '../core/serialize.js'
import { currentWakeTurn } from '../life/wakeTurn.js'

const SCHEMA = 1
/** 一次最多带几张图：和微信适配器、send_image 的上限对齐。 */
const MAX_IMAGES = 2

let sender = null

/** 渠道层启动后把「真的发出去」的实现注册进来。 */
export function setOutreachSender(fn) {
  sender = typeof fn === 'function' ? fn : null
}

export function getOutreachSender() {
  return sender
}

export function outreachPath(root) {
  return join(String(root ?? ''), 'outreach-state.json')
}

/** 今天的额度台账；坏档当 0。 */
export async function readOutreachState(root) {
  try {
    const parsed = JSON.parse(await readFile(outreachPath(root), 'utf8'))
    return { dateKey: String(parsed?.dateKey ?? ''), sent: Number(parsed?.sent) || 0 }
  } catch {
    return { dateKey: '', sent: 0 }
  }
}

async function writeOutreachState(root, state) {
  await writeAtomic(outreachPath(root), JSON.stringify({ version: SCHEMA, dateKey: state.dateKey, sent: state.sent }, null, 2), 0o600)
}

/** 今天已经主动发过几次。 */
export async function sentToday(root, now = Date.now()) {
  const st = await readOutreachState(root)
  return st.dateKey === dateKey(new Date(now)) ? st.sent : 0
}

/**
 * 发一条主动消息（文字 / 图片 / 图配文）。
 * @returns {Promise<{ok:boolean, note:string}>}
 */
export async function sendOutreach({ root, cfg, text = '', images = [], now = Date.now() } = {}) {
  const o = cfg?.outreach
  if (!o || o.enabled !== true) return { ok: false, note: '现在不能主动发。' }
  if (!currentWakeTurn(now)) return { ok: false, note: '这不是醒着的时候。' }

  const channel = String(o.channel ?? 'weixin') || 'weixin'
  const to = String(cfg?.channels?.[channel]?.ownerId ?? '').trim()
  if (!to) return { ok: false, note: '还不知道要发给谁。' }

  const raw = String(text ?? '').trim()
  const pics = (Array.isArray(images) ? images : []).map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, MAX_IMAGES)
  if (!raw && !pics.length) return { ok: false, note: '没说发什么。' }

  let body = raw
  if (body) {
    const screened = screenOutgoing(body)
    if (!screened.ok) return { ok: false, note: '这句不能发出去。' }
    body = String(screened.text ?? body)
  }

  const send = sender
  if (!send) return { ok: false, note: '微信现在没连上。' }

  // 额度检查与发送放在同一条串行链里：两个工具同时调用时，
  // 不会都读到 sent=0 然后各发一条；被拒的调用不占次数。
  return withSerial(outreachPath(root), async () => {
    const cap = Math.max(0, Math.min(3, Math.round(Number(o.perDay) || 0)))
    const sent = await sentToday(root, now)
    if (sent >= cap) return { ok: false, note: `今天已经发过 ${sent} 次了。` }

    const r = await send({ channel, to, text: body, images: pics })
    if (!r?.ok) return { ok: false, note: r?.why || '没发出去。' }

    await writeOutreachState(root, { dateKey: dateKey(new Date(now)), sent: sent + 1 }).catch(() => {})
    return { ok: true, note: '发出去了。' }
  })
}

/** 测试用：清掉注册的 sender（线上不需要）。 */
export function resetOutreachForTests() {
  sender = null
}

export default {
  setOutreachSender,
  getOutreachSender,
  readOutreachState,
  sentToday,
  sendOutreach,
  outreachPath,
  resetOutreachForTests,
}
