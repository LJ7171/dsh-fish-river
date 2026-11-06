/**
 * ownership.js —— 「这个号是谁的」的素材措辞（2026-11-06 用户定）
 *
 * 现在每个平台只有一份登录态，这个选项只改素材开头那句说法；
 * 以后要做「她自己的号 / 主人的号」两套登录态时，再按 owner 取不同凭据。
 *
 * 两种说法由用户原话定：
 *   her   → 这是用她自己的{平台}号看到的。
 *   owner → 这是用那个重要的人的{平台}号看到的，不是你经历的。
 */
export const OWNER_VALUES = Object.freeze(['her', 'owner'])

export function ownerLine(platform, owner) {
  const p = String(platform ?? '').trim()
  return owner === 'her'
    ? `（这是用她自己的${p}号看到的。）`
    : `（这是用那个重要的人的${p}号看到的，不是你经历的。）`
}

export default { OWNER_VALUES, ownerLine }
