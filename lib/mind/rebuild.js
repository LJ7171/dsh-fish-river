/**
 * rebuild.js —— 从事件流重算 state.json。
 *
 * 原来在 core/store.js 里，惰性 import derive；现在单独放 mind，store 不再反向依赖人格层。
 */

import { readEvents, writeState, rootDir } from '../core/store.js'
import { deriveSelf } from './derive.js'

/**
 * state.json 的真身：**从 events.jsonl 重算出来的派生快照**。
 *
 * 这个函数以前不存在，只有第 12 行注释声称"rebuild() 这条由 test 守住"，
 * 属于注释撒谎。补上它，并让 test/store.test.mjs 真的去做
 * 「删掉 state.json → rebuild → 内容与之前一致」的往返验证，
 * 才配得上「真相源只有事件流」这句话。
 *
 * @returns {Promise<object>} 写入的 state
 */
export async function rebuild(root = rootDir(), opts = {}) {
  const { events } = await readEvents(root)
  // 惰性 import：避免 store ←→ derive 的静态循环（derive 不依赖 store，但这样更稳）
  const { deriveSelf } = await import('./derive.js')
  const model = deriveSelf(events, opts)
  const state = {
    builtAt: new Date().toISOString(),
    events: events.length,
    day: model.day,
    stage: model.stage,
    stageName: model.stageName,
    stageForced: model.stageForced,
    name: model.name,
    beliefCount: model.beliefCount,
    absenceDays: model.absenceDays,
    // needs 落盘只是为了排查，观测台与提示词都不会返回它（N2）
    needs: model.needs,
  }
  await writeState(state, root)
  return state
}

