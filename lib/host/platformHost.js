/**
 * platformHost.js —— 给可选平台子包用的宿主门面。先服务知乎。
 *
 * 子包不许 import `lib/`。鱼自己的政策从这里注进去：
 *   醒着没有、这话能不能出去、记一条动作、读事件、这个号是谁的。
 * 知乎怎么抓、怎么说，不在这里。
 */

import { rootDir, readEvents as readEventsStore, appendEvent, writeAtomic } from '../core/store.js'
import { dateKey, dailyQuota, loadConfig } from '../core/settings.js'
import { screenOutgoing, sanitizeForeign } from '../core/guard.js'
import { modelOf } from '../mind/derive.js'
import { evaluateSocialGate } from '../life/social/socialgate.js'
import { whoseAccount, ownerLine } from '../core/ownership.js'
import { occasionLine, resolveOccasion } from '../channels/passport.js'
import { pacedFetch } from '../core/pacing.js'
import { defineTool } from '../core/tool.js'
import { toJsonSchema } from '../core/toolschema.js'
import { guardWrite } from '../house/tenant.js'
import { fetchableImageUrl, sniffImageExt } from '../core/media.js'
import { slashed } from '../core/posix.js'
import { recordZhihuVoice } from '../platforms/common/voices.js'
import {
  formatZhihuBrowse,
  formatZhihuOpen,
  formatZhihuComment,
  formatZhihuReply,
  formatZhihuAnswer,
} from '../core/acts.js'

export function createFishHost() {
  return {
    rootDir,
    dateKey,
    dailyQuota,
    async readEvents(root) {
      try {
        const { events } = await readEventsStore(root)
        return events ?? []
      } catch {
        return []
      }
    },
    async loadConfig(root) {
      return loadConfig(root)
    },
    async recordAct(root, text, sessionId) {
      const stamp = sessionId ? { sessionId } : {}
      await appendEvent(
        { type: 'meta', text, ...stamp },
        { day: 0, stage: 1, source: 'system' },
        root,
      ).catch(() => {})
    },
    async writeAtomic(file, text, mode) {
      return writeAtomic(file, text, mode)
    },
    /**
     * 作息有没有把这一拍按住。
     * sleepState 传了就用那份（测试）；没传才读盘。返回 { governed, open }。
     */
    async isAwake(root, config, sleepState) {
      const { diceOpen, readSleep } = await import('../life/schedule/sleep.js')
      const st = sleepState !== undefined ? sleepState : await readSleep(root).catch(() => null)
      const gate = diceOpen(config, st)
      return { governed: gate.governed === true, open: gate.open !== false }
    },
    /** 出站筛。why 保持 guard 的原词（leak / secret），话术由子包自己说。 */
    maySend(text) {
      return screenOutgoing(text)
    },
    sanitize(text) {
      return sanitizeForeign(text)
    },
    socialOpen(events) {
      return evaluateSocialGate({ model: modelOf(events), events }).open === true
    },
    whoseAccount,
    ownerLine,
    commentScene() {
      return occasionLine(resolveOccasion({ channel: 'zhihu', kind: 'comment' }))
    },
    pacedFetch() {
      return pacedFetch()
    },
    defineTool,
    toJsonSchema,
    guardWrite,
    fetchableImageUrl,
    sniffImageExt,
    slashed,
    recordVoice(opts) {
      return recordZhihuVoice(opts)
    },
    formatBrowse: formatZhihuBrowse,
    formatOpen: formatZhihuOpen,
    formatComment: formatZhihuComment,
    formatReply: formatZhihuReply,
    formatAnswer: formatZhihuAnswer,
  }
}

export default { createFishHost }
