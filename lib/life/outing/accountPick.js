/**
 * accountPick.js —— 出门前决定用哪一个号。
 *
 * 恰好一个允许且已登录的号：直接用，调用方把「她自己的 / 重要的人的」写进素材。
 * 两个都在：不抓、不扣次数，把两个号念给她，等她写 account。
 * B 站一个都没有：仍按原来的匿名浏览。
 */

import { choiceText, resolveSlot, stampOf } from '../../core/accounts.js'
import { loadBiliAccounts } from '../../core/ownerAccount.js'
import { readAccounts as readTiebaAccounts } from '../../platforms/tieba/client.js'

const NAMES = { bili: 'B 站', zhihu: '知乎', tieba: '贴吧' }

async function zhihuAccounts(root, deps) {
  let mod = deps.zhihuMod
  if (!mod) {
    const { loadZhihu } = await import('../../platforms/zhihu/bridge.js')
    mod = await loadZhihu().catch(() => null)
  }
  if (typeof mod?.readAccounts !== 'function') return []
  let label = 'owner'
  try {
    const { loadConfig } = await import('../../core/settings.js')
    const { config } = await loadConfig(root)
    if (config?.zhihu?.owner === 'her') label = 'her'
  } catch { /* 读不到配置就按知乎现在的默认 */ }
  return mod.readAccounts(root, label)
}

export async function platformAccounts(root, platform, deps = {}) {
  if (platform === 'bili') return loadBiliAccounts(root)
  if (platform === 'tieba') return readTiebaAccounts(root)
  if (platform === 'zhihu') return zhihuAccounts(root, deps)
  return []
}

export async function decideAccount(root, platform, requested, deps = {}) {
  const accounts = await platformAccounts(root, platform, deps)
  const picked = resolveSlot(accounts, requested ?? '')
  if (picked.ok) {
    return { ok: true, slot: picked.slot, stamp: stampOf(picked.slot), sole: picked.sole === true }
  }
  if (picked.why === 'choice') {
    return {
      ok: false,
      why: 'choice',
      text: choiceText(NAMES[platform] || platform, picked.choices),
      choices: picked.choices,
    }
  }
  if (platform === 'bili' && picked.why === 'none') return { ok: true, anonymous: true, slot: null, stamp: {} }
  return { ok: false, why: picked.why || 'none', text: '' }
}

/** 醒来时，把「这两个号先别替她选」写进叫醒语。只提这次能去的平台。 */
export async function pendingAccountChoices(root, platforms, deps = {}) {
  const lines = []
  for (const platform of platforms ?? []) {
    if (platform !== 'bili' && platform !== 'zhihu' && platform !== 'tieba') continue
    const decided = await decideAccount(root, platform, '', deps)
    if (!decided.ok && decided.why === 'choice' && decided.text) lines.push(decided.text)
  }
  return lines.join('\n\n')
}
