/**
 * config.js —— 知乎这一组设置的默认值、夹紧和文案。
 *
 * 设置页仍由主包 `lib/client.js` 画（浏览器里只能 require('react')，
 * 加载不了这个包）。主包 `normalizeConfig` 调这里的 `normalizeZhihu`，
 * 文案放在 `ZHIHU_COPY`，给设置页当对照，不在这里画控件。
 *
 * 评论条数、看图张数的上下限和贴吧共用同一套数（评论 0–5、回复 0–10、图 1–6）。
 * 算法写在这里，是因为这是知乎字段的形状；贴吧仍用主包那份助手。
 */

export const ZHIHU_DEFAULTS = {
  enabled: false,
  // owner 只决定素材措辞：her=用她自己的号看，owner=用那个重要的人的号看。
  owner: 'owner',
  perDay: 4,
  hot: { enabled: true, topN: 8 },
  follow: { enabled: true, topN: 8 },
  history: { enabled: true, onlyToday: true, topN: 10 },
  recommend: { enabled: true, topN: 6 },
  comment: {
    enabled: false,
    perDay: 1,
    replyPerDay: 1,
    replyToReplies: true,
    scanEveryMin: 30,
    lastScanAt: '',
  },
  answer: { enabled: false, perDay: 1 },
  images: { enabled: true, max: 2 },
}

/** 设置页上能点的知乎字段。client.js 仍逐项画，这里只描述形状。 */
export const ZHIHU_FIELDS = {
  hotTopN: { min: 1, max: 20, unit: '条' },
  followTopN: { min: 1, max: 20, unit: '条' },
  recommendTopN: { min: 1, max: 20, unit: '条' },
  historyTopN: { min: 1, max: 20, unit: '条' },
  imagesMax: { min: 1, max: 6, unit: '张' },
  commentPerDay: { min: 0, max: 5, unit: '条' },
  replyPerDay: { min: 0, max: 10, unit: '条' },
  answerPerDay: { min: 0, max: 1, unit: '条' },
  scanEveryMin: { options: [5, 10, 15, 30, 60, 120, 360, 720] },
  perDay: { min: 0, max: 8 },
}

export const ZHIHU_COPY = {
  groupTitle: '刷知乎',
  groupIntro: '热榜、关注、推荐和浏览历史：今天外面在讨论什么、你关注的人在说什么、重要的人最近看过什么。要扫码登录一次，并且装的是可选子包 dsh-fish-river-zhihu。评论和写回答各自有开关，默认关。不私信、不点赞。',
  allowLabel: '允许她看知乎',
  allowHint: '关着时一个请求都不发。',
  notInstalled: '没装子包 dsh-fish-river-zhihu。',
  ownerLabel: '这个号是谁的',
  ownerHint: '大肥鱼 = 用她自己的号看、说；主人 = 用那个重要的人的号看、说。标成主人也可以发，她会知道这是谁的号。',
  sourcesTitle: '每次刷知乎逛的内容（一次抓完勾选的这些）',
  commentLabel: '允许在知乎评论',
  commentHint: '她自己写。只能评今天点开过的回答。标成主人的号也可以发，她会知道这是谁的号。',
  answerLabel: '允许回答问题',
  answerHint: '和评论分开，默认关。刷知乎时会额外看邀请回答、作者推荐和首页推荐里的问题；只能回答今天用 zhihu_look 点开过的问题。标成主人的号也可以发，她会知道这是谁的号。',
}

function normalizeImages(raw, fallback = { enabled: true, max: 2 }) {
  const base = fallback && typeof fallback === 'object' ? fallback : { enabled: true, max: 2 }
  const cur = raw && typeof raw === 'object' ? raw : {}
  const maxN = Number(cur.max)
  return {
    enabled: cur.enabled !== false,
    max: Number.isFinite(maxN) ? Math.max(1, Math.min(6, Math.round(maxN))) : Math.max(1, Math.min(6, Number(base.max) || 2)),
  }
}

function normalizeThreadComment(raw, defaults) {
  const cur = raw && typeof raw === 'object' ? raw : {}
  const base = defaults && typeof defaults === 'object' ? defaults : {}
  const per = Number(cur.perDay ?? base.perDay)
  const reply = Number(cur.replyPerDay ?? base.replyPerDay)
  const scan = Number(cur.scanEveryMin ?? base.scanEveryMin)
  return {
    enabled: cur.enabled === true,
    perDay: Math.max(0, Math.min(5, Number.isFinite(per) ? Math.round(per) : 0)),
    replyPerDay: Math.max(0, Math.min(10, Number.isFinite(reply) ? Math.round(reply) : 0)),
    replyToReplies: cur.replyToReplies !== false,
    scanEveryMin: Math.max(5, Math.min(720, Number.isFinite(scan) ? Math.round(scan) : 30)),
    lastScanAt: String(cur.lastScanAt ?? base.lastScanAt ?? ''),
  }
}

/**
 * 把知乎这一组收成稳定形状。入参是 fillDefaults 之后的对象（和主包原来的写法一样）。
 * 多出来的键留着（老的 recommend.perDay 还要能被作息迁移读到），
 * accountOf / bond / voices 删掉。
 */
export function normalizeZhihu(raw) {
  const zh = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...ZHIHU_DEFAULTS, ...zh }
  cfg.enabled = cfg.enabled === true
  const oldOwner = zh.owner ?? (zh.accountOf === 'home' ? 'her' : zh.accountOf === 'outing' ? 'owner' : '')
  cfg.owner = oldOwner === 'her' ? 'her' : 'owner'
  delete cfg.accountOf
  delete cfg.bond
  delete cfg.voices
  cfg.perDay = Math.max(0, Math.min(8, Number(cfg.perDay) || 0))
  const zc = zh.comment && typeof zh.comment === 'object' ? zh.comment : {}
  cfg.comment = normalizeThreadComment(zc, ZHIHU_DEFAULTS.comment)
  const za = zh.answer && typeof zh.answer === 'object' ? zh.answer : {}
  cfg.answer = {
    enabled: za.enabled === true,
    perDay: Math.max(0, Math.min(1, Math.round(Number(za.perDay ?? ZHIHU_DEFAULTS.answer.perDay) || 0))),
  }
  cfg.images = normalizeImages(cfg.images, ZHIHU_DEFAULTS.images)
  for (const key of ['hot', 'follow', 'history', 'recommend']) {
    const cur = cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {}
    cfg[key] = { ...ZHIHU_DEFAULTS[key], ...cur }
    cfg[key].enabled = cfg[key].enabled !== false
    const topN = Number(cfg[key].topN)
    cfg[key].topN = Number.isFinite(topN)
      ? Math.max(1, Math.min(20, topN))
      : ZHIHU_DEFAULTS[key].topN
    if (key === 'history') cfg.history.onlyToday = cfg.history.onlyToday !== false
  }
  return cfg
}

export default { ZHIHU_DEFAULTS, ZHIHU_FIELDS, ZHIHU_COPY, normalizeZhihu }
