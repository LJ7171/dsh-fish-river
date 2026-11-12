/**
 * settings.js —— 唯一配置入口
 *
 * 设计要点（对应用户 m00497 的要求）：
 *   1. **可扩展**：DEFAULTS 是唯一默认值的来源，读配置时按 DEFAULTS 递归补全。
 *      以后想加新项，只在这里加一个键 + 在 settings.html 加一行，不用改别处。
 *   2. **她不认识这个文件的位置**：配置在 ~/.dsh-fish-river，不在她的 cwd，也没写进她的提示。
 *   3. **错误不静默**：配置坏了不覆盖，改名备份后用默认值，并在 status 里报出来。
 */

import { promises as fs } from 'node:fs'
import { readConfig, writeConfig, paths, readJson } from './store.js'
// 请求节奏是 bili 客户端的模块级状态，由配置驱动（issue #5）。
// 这里有 settings → bili 的单向依赖，bili.js 不反过来引 settings，不会成环。
import { DEFAULT_ACK_PHRASES, SILENCE_MAX_MS } from './ack.js'
import { zhihuConfigApi } from './zhihuConfig.js'

// 知乎字段的默认值在子包 config.js。没装子包时 zhihuConfigApi 给一份同形兜底。
const zhihuDefaults = JSON.parse(JSON.stringify(zhihuConfigApi().ZHIHU_DEFAULTS))

/** 所有可调项。加新项就在这里加，下面读配置会自动补全。 */
export const DEFAULTS = {
  // 成长
  growthDays: 30,          // 7–180
  // 2026-11-02（用户 m03939）：原来 1 次/天，配上 daily.events=2，实际有效上限是
  // min(2, 1) = 1 —— 刷一次站再聊两轮就撞「今日事件已满」，一天剩下的时间她都不动了。
  // 两个旋钮一起抬到 2 / 4，有效上限变成 min(4, 2) = 2。
  window: ['20:00', '23:00'],  // 醒来的时间段（仅 sleep.enabled 关掉时驱动调度）

  // 作息（2026-11-05）：活跃窗、入睡、小睡、苏醒后各渠道掷骰。
  // 开着时调度以这里为准，旧 window / browse|zhihu|comment.window
  // 不再单独决定「什么时候主动上网」。关掉则上面那些旧键完全照旧。
  // 跟 memory.sleepEveryDays / sleepKeep（回头想）不是一回事，不要并到那一组。
  sleep: {
    active_start: '07:00',
    active_end: '23:00',
    idle_to_sleep_min: 90,
    nap_min_h: 3,
    nap_max_h: 5,
    browse_interval_min_m: 30,
    browse_interval_max_m: 45,
    browse_max_per_wake: 2,
    weixin_session_idle_min: 10,
    // 可选。不写某个渠道就走「开关开着则这次去」（间隔本身已经是随机的）。
    browse_prob: {},
    // 每天配额（2026-11-05，用户要求）：各路「真的上网」每天最多几次。
    // 0 = 这一路不主动去。上网页里旧的 browse/zhihu/comment.perDay 只用于迁移，
    // 运行时一律以这里为准。
    daily: {
      bili: 1,        // B 站刷几次（默认沿用旧 browse.perDay）
      douyin: 1,      // 抖音刷几次
      zhihu: 4,       // 知乎翻几次（一次里抓热榜/关注/推荐/历史里勾选的）
      tieba: 2,       // 贴吧抓几次（一次里抓首页推荐，按设置再进帖/进吧）
    },
  },

  // 每日事件配额（用户 m00497 要的自定义项）
  // 2026-11-06：wakesPerDay 删除。唤醒由作息状态机决定，这里只限制成长卡张数。
  daily: {
    // 2026-10-25：原来配额是"写得有、数不到"（见 scheduler todayCounts 的修复），
    // 修好之后 1 条/天会让 18 张卡里的大多数一辈子轮不上，默认放到 2。
    events: 4,          // 每天最多推几张成长卡
    questions: 1,       // 其中"她向你提问"最多几条 —— 防退化成问答机器
  },

  // 日记
  diary: {
    enabled: true,          // 她每天写不写日记
    visible: false,         // **默认不给看**：用户 m00497 明确要一个开关决定
    keepDays: 0,            // 0 = 永久保留
  },

  // 冷落：他多少天不出现才算"冷落"
  absenceAfterDays: 2,      // 1–30

  // 她的工具面（2026-10-24 用户批准）
  // 为什么限制：别的插件 / skill 一装上，就会把自己的工具定义塞进她的上下文。
  // 她会莫名其妙多出一堆「能做什么」，然后真的去做。**保持原生成长状态**是目的。
  //
  // ⚠️ 现状（2026-10-24 实测）：宿主按会话收窄工具要靠 agent preset。我们在
  // profile patch 里声明了 `fish-home`（行能激活、create 也接受 agentPreset），
  // 但首轮马上把会话的 preset 改回 `standard`——`presets.resolve('fish-home')`
  // 回落到默认值，工具面仍然是全量 37 个。所以这里**默认关闭**（空字符串），
  // 不写一个假装生效的名字。等宿主那侧打通再把默认值改回来。
  //   preset  ：她那条会话用的 agent preset（宿主支持时生效；现在留空）
  //   restrict：工具面收窄开关（2026-10-24 起用 agent.ctx.tools.restrict()，
  //             agent/created 里只关她一个 agent，不碰全局、不影响你自己的窗口）
  //   allow   ：额外放行的宿主工具名（白名单；空 = 只给她自己的那 7 个）
  tools: {
    preset: '',
    restrict: true,
    allow: [],
  },

  // 她主动说话（2026-10-30，用户 m04610；本机实验，只在 .dev 下生效）
  // 频率是上限不是行为要求：到上限就闭嘴，没到也不保证一定开口。
  // 概率随「多久没人说话」缓慢上升（baseChance + 超出 minIdleHours 的每小时 * gainPerHour，封顶 maxChance）。
  proactive: {
    enabled: false,       // 默认关；公开版没有这个功能
    maxPerDay: 2,         // 一天最多开几次空手回合
    minIdleHours: 6,      // 距上一次记录不足这么久就不打扰
    baseChance: 0.15,     // 每次掷骰子的基础概率
    gainPerHour: 0.05,    // 超过 minIdleHours 之后，每多一小时加多少
    maxChance: 0.6,       // 概率上限
    cooldownHours: 4,     // 两次之间至少隔多久
  },

  // 醒来时主动找他（2026-11-05，用户要求）：只在她自己的醒来回合里可以发，
  // 发不发由她决定。一天最多 2 次（文字/图片/图配文都算一次；被拒的调用不算）。
  // 只支持微信 ClawBot；需要他发来的消息带来 context_token（适配器已做持久化）。
  // 这是「能不能主动开口」的许可，不是人格设置——她说什么、说不说仍是她的判断。
  outreach: {
    enabled: false,
    channel: 'weixin',
    perDay: 2,
  },

  // 渠道（2026-11-02 合并版）：**默认全关**。
  // 为什么默认关：她第一阶段连主人都未必搭理，没有理由一装好就去接陌生人；
  // 而且「她能碰什么」是环境问题，不该由默认值替主人做决定。
  // 这里的每一项都是环境参数（在哪、什么时候、多频繁），不是人格参数——
  // 它们**不会**让她对同一个人说出不一样的话，所以可以配。
  channels: {
    qq: {
      enabled: false,
      wsUrl: 'ws://127.0.0.1:3001',   // OneBot 11 正向 WS（SnowLuma 默认口）
      accessToken: '',
      ownerId: '',                    // 重要的人的 QQ 号；填了才认得「这是重要的人在说话」
      bridgePath: '',                 // 桥的程序路径；只用于「启动桥」按钮，不参与任何判断
      replyInGroup: false,            // 群默认拒绝：群是"别人的地方"
      groups: [],                     // 允许她开口的群号（空 = 一个都不许）
      mentionOnly: true,              // 群里只在她被 @ 时开口（用户 m06663：重要的人一说话她就回，太吵）
      closeIds: '',                   // 可选近人。私聊按近场合记，话仍是 social
    },
    bili: {
      enabled: false,
      ownerId: '',                    // 重要的人的 B 站 uid（大号，不是登录的出门小号）
      replyInGroup: false,
      groups: [],
      mentionOnly: true,
      closeIds: '',
    },
    douyin: {
      enabled: false,                 // 子包装了才有这个渠道
      ownerId: '',                    // 重要的人的抖音号
      replyInGroup: false,
      groups: [],
      mentionOnly: true,
      browserPath: '',                // 空 = 自动找本机 Edge/Chrome
      // 打开浏览器之后落哪一页（空 = 精选）。抖音的「推荐 / 精选 / 关注」是首页上的
      // tab，地址不同、私信入口都在；想让她停在推荐流就填那一页的地址。
      homeUrl: '',
      closeIds: '',
    },
    weixin: {
      enabled: false,                 // 官方 ClawBot：扫码登录后才有凭据（凭据不进 config）
      ownerId: '',                    // 重要的人的微信 id（ClawBot 消息里的 from_user_id）
      // ClawBot 只有私聊，没有群。下面三项保留是为了让 config 的形状与别的渠道一致
      // （导出 / 旧配置不因缺键报错）；适配器不用它们做判断。
      replyInGroup: false,
      groups: [],
      mentionOnly: true,
      closeIds: '',
    },
  },

  // 她"不想看"的东西（可追加，用户说以后还会加）
  avoid: {
    keywords: ['恐怖', '血腥', '鬼畜', '政治'],
    upMids: [],             // 屏蔽的 UP 主 mid
    minDuration: 60,        // 秒，太短的不看
  },

  // 刷站（P2）
  // 注意：这里**没有任何一项是"她喜欢什么"**。这些全是环境参数——
  // 她看什么、信不信、想不想写，是她自己的事，不是旋钮。
  browse: {
    enabled: true,
    homeEnabled: true,      // 每次逛的内容：首页/排行
    hotEnabled: true,       // 每次逛的内容：热评
    danmakuEnabled: true,   // 每次逛的内容：弹幕          // 装好就能用；不想让她上网就关掉
    perDay: 1,              // 每天最多刷几次（0 = 从不）
    topN: 4,                // 一次看几条
    // 阶段 1 每次轮换几个不同的分区排行（2026-10-27，用户 m00763：首批别只吃固定片单）
    rankingTids: 2,
    deepRead: 6,            // 每条深读几条热评
    danmaku: 6,             // 每条抽几条弹幕（0 = 不抽）
    keywords: [],           // 额外的搜索词（可追加；空 = 只看首页/排行）
    // 评论区里别人的话（2026-10-24，用户 m02454）
    // 打开后每次浏览最多留 1 条评论给她读（跨视频重复 > 高赞短句 > 25% 随机）。
    // 关掉也能正常上网——只是她再也读不到别人的说法。
    voices: true,
    // 看图（评论区静态图）：开则可下载 + keep_image；每次点开最多下 max 张。
    // 抽帧仍走 video.*，不跟这里绑死。
    images: { enabled: true, max: 2 },
    // 刷抖音（2026-11-02，用户 m03490）：和刷 B 站一个地位，配额各算各的。
    // 没装子包 `dsh-fish-river-douyin` 时这一整条路直接消失，开着也没用。
    douyin: {
      enabled: false,       // 要装子包、要本机有 Edge/Chrome，所以默认关
      owner: 'owner',       // 这个号是谁的（只影响素材措辞）
      perDay: 1,            // 每天最多刷几次（0 = 从不）
      topN: 4,              // 一次看几条
      browserPath: '',      // 空 = 自动找 Edge/Chrome
    },
  },

  // 知乎字段的真身在子包 `config.js`（ZHIHU_DEFAULTS / normalizeZhihu）。
  // 这里只留一份拷贝给 fillDefaults。要装子包、要先扫码，所以默认关。
  zhihu: zhihuDefaults,

  // 贴吧素材（2026-11-05）：首页推荐。跟帖 / 楼中楼默认关，不发新主题帖、不点赞，也不进 channels。
  // 登录态在 tieba.json，不在这里。
  tieba: {
    enabled: false,
    owner: 'owner',         // 用谁的贴吧号看（只影响素材措辞）
    recommendTopN: 8,
    comment: {
      enabled: false,
      perDay: 1,
      replyPerDay: 1,
      replyToReplies: true,
      scanEveryMin: 30,
      lastScanAt: '',
    },
    // 看图：进帖时下载楼层图；关了也不让 keep_image 收本平台缓存。
    images: { enabled: true, max: 2 },
  },

  // B 站请求节奏（issue #5，2026-10-28）
  // 为什么可配：机房/服务器 IP 与家宽的风控阈值完全不同。家宽 800ms 很安全，
  // 机房 IP 反而**越刷越快被盯上**——需要放慢；反过来在某些代理下又能更快。
  // 放在设置里比写死合理（写死就是让一部分人永远用不了）。
  // 注意：这是环境参数，不是"她性格"的一部分。
  bili: {
    owner: 'her',           // 这个号是谁的（她自己的 / 主人的）；只影响素材措辞
    minIntervalMs: 800,     // 两次请求之间最少等多久
    jitterMs: 500,          // 在最小间隔上再随机多等 0–jitterMs（打散固定节奏）
  },

  // 看画面（2026-10-23 加）
  // 她看一条视频的**画面**：抽 9 帧拼成一张图，她 read_image 看。
  // 为什么单独一个开关而不跟 browse 绑死：抽帧要十秒、要 ffmpeg、占带宽，
  // 有人只想让她读文字。默认开，但每天只给 2 条——一条 9 帧 ≈ 一张图的时间，
  // 再多就变成"以看图为主"了，那不是她该有的生活。
  video: {
    enabled: true,
    perDay: 2,              // 每天最多看几条视频的画面（0 = 从不）
    frames: 9,              // 每条取几帧（9 = 3×3 拼图）
  },

  // 相册（2026-11-05）：她想留下的图抄到 album/，不跟三天 TTL 的缓存走。
  // 只有这一项：单张多大。留不留由她自己调 keep_image，这里没有开关。
  album: {
    maxBytes: 8 * 1024 * 1024, // 默认与微信 / send_image 的 8MB 对齐
  },

  // 表情包（2026-11-05）：只决定开不开、启用哪几套包。
  // 标签描述的是图，不是她的情绪。没有主动发图的档位，也没有人设输入框。
  // 单张大小复用 album.maxBytes，这里不再单开一个旋钮。
  meme: {
    enabled: false,
    // 顺序 = 优先。`dafeiyu-001` 放在数据目录（用户自己导入，不随仓库分发），
    // 没有这个包时 `memeCandidates` 会当它不存在，自动回落到自带的 `plain` 占位。
    packs: ['dafeiyu-001', 'plain'],
    // 渠道轮里一轮最多挑几张。0 = 不限（默认）；1–5 是硬上限。
    // 只管「挑」，发不发仍由她调 send_image 决定。
    maxPerTurn: 0,
  },

  // 桌面提醒（P3-3）
  // **默认关闭**：用户讨厌被弹窗打断，这个开关必须由他自己打开。
  // 打开后也一天最多一次，且只在她真的开口之后弹（见 lib/talk/notify.js）。
  notify: {
    enabled: false,
    lastShown: '',          // 内部用：上次弹通知的日期键，防一天多次
  },

  // 在 B 站说话（P4）
  // **默认关闭**。这是唯一会改动她账号上东西的功能：
  // 发评论留痕、别人能看见、删了也有通知。所以默认关，由用户自己打开。
  // 这些仍然是环境参数（能不能说、说几句、什么时候说），不是"她想说什么"。
  comment: {
    enabled: false,         // 总开关：不发任何评论
    perDay: 1,              // 每天最多发几条评论（0 = 不发）
    replyPerDay: 2,         // 每天最多回几条楼中楼
    replyToReplies: true,   // 有人回她时，允不允许她回一句
    scanEveryMin: 30,       // 多久去看一眼有没有人回她（分钟）
    atOwner: true,          // 发评论时在最前面 @ 主人（需要有昵称，见「主人在哪」）
    lastScanAt: '',         // 内部用：上次扫回复的时间戳
  },

  // 对话与会话（2026-10-23 加）
  // 一个侧栏会话聊到几百轮，上下文必然撑爆——不是"变慢"，是每轮为几十万字付费，
  // 最后直接失败。所以到点上换新会话，旧的改名留档（不删），原话搬几句过去。
  chat: {
    rotateAfter: 40,        // 聊满多少轮换新会话（0 = 永不换）
    // 单轮回复字数预算（2026-10-25 加）。
    //
    // 为什么这条不算「人格设置」：它描述的是**这一轮产出的预算**，不是「她是什么样的人」。
    // 和 daily.events（一天几张成长卡）同级，都是环境参数。
    // 写 0 就完全不提这件事——她的长短由她自己决定（默认就是这个）。
    //
    // 起因：如果某个用户就是想要她写长一点（也不在乎 token），原来没有任何入口：
    // 身份文档里既不许写「你话少」，也没有反向的「可以长」。
    // 有这个数，用户能明确「这一轮最多写多少」，而不必去改她的性格。
    replyChars: 0,          // 单轮最多写多少字（0 = 不限，提示词里不出现任何长度要求）
  },

  // 记忆与上下文（2026-10-23 加）
  // docBudget 是她身份文档的字数上限：超了不是报错，是**按优先级丢可选段**
  // （四条黑名单与"你是谁"永远不丢）。她记得越多，文档越该只留最要紧的。
  memory: {
    docBudget: 1800,        // 身份文档字数预算（600–4000）；2026-10-25 从 1200 提到 1800：
                            // 认知重构 + 矛盾 + 疤 + 别人的说法进来之后，可选段明显变多，1200 会把其中几段挤掉。
    sleepEveryDays: 7,      // 每几天让她"想一想"一次（0 = 不主动想）
    sleepKeep: 12,          // 她总共留多少条自述（超出后最早的折进「更早以前」）
    beliefsShown: 3,        // 她一轮里逐条摆出来的判断数（1–8，默认 3）；其余折成一行
                            // 2026-10-25 用户问「想让她记住更多能不能调」——原来写死在
                            // persona.js 的 BELIEF_SHOWN，docBudget 调多大都不会多摆一条。
    hearEvery: 3,           // 每几轮把你说的一句话记成「旁听」（0 = 不记，1–50）
                            // 2026-10-30（用户 m00112 的 A2）：只存原话、不加工；
                            // 记的是"你曾经说过什么"，不是"你当时是什么意思"。
  },

  // 规则与解禁（R3，2026-10-24）
  // 这里的开关约束的是**申请通道**，不是规则本身：
  // 关掉只是"最近别来跟我要东西"，已有的授权不会被撤销。
  rules: {
    offers: true,           // 允许她在某次醒来里提出「我想改一条规矩」
    holdDays: 3,            // 一张申请几天不处理 = 搁置（不算驳回、不加重冷却）
    cooldownDays: 3,        // 被驳回后至少隔几天才能再提
  },

  // 出门（2026-10-30，用户 m01904）：发布前加一道一次性确认。
  // 只记「说明卡看过一遍」，不是开关——看过的不用再看，没看过的按钮先挡着。
  outing: {
    ack: false,
  },

  // 2026-11-02（用户 m02861）：`observe: {enabled, port}` 删掉了。
  // 它从 2026-10 起就没有任何读者——路由是随宿主 webServer 无条件注册的，
  // 界面上也没有对应的开关，留着只会让人以为「观测台能关」。

  // 界面（2026-10-25 加）
  // 只放「这一版界面怎么显示」的偏好，与她的成长无关。
  ui: {
    ownerHintDismissed: false, // 用户手动关掉「B 站登录还没存」提示卡后记为 true
  },

  // 渠道回复怎么送出去、进站时要不要等一等（2026-11-04，2026-11-05 改过标点）。
  // 这是送达和节奏：同一轮拆成几条短消息连着发，还是一整段一次发；
  // 发出去之前要不要把连续标点收一收；进来的几条要不要攒一下再想；
  // 纯确认要不要叫醒她。
  // 不描述她是什么样的人，不进身份文档，也不按泡写多条 utterance。
  // 不放进 channels.<name>：那一组只许「在哪、开不开」（见 AGENTS.md §9）。
  // bubbleSplit 默认关：跟以前一样一次 send。往外多发几条会改对方看到的节奏，
  // 和评论、桌面提醒一样，由使用者自己打开。
  // casualPunctuation 默认开：连续标点收成一个，空白收一收。句末句号留着。
  // inboundSilenceMs 缺省 null：按场合（重要的人 / 家门近聊约 2 秒，群不等）。0 = 关。
  // ackSilence 默认开：整段只是短确认时不调度回复。名单可改。
  im: {
    bubbleSplit: false,
    casualPunctuation: true,
    inboundSilenceMs: null,
    ackSilence: true,
    ackPhrases: [...DEFAULT_ACK_PHRASES],
  },
}

const LIMITS = {
  growthDays: [7, 180],
  'daily.events': [0, 6],
  'daily.questions': [0, 6],
  'diary.keepDays': [0, 3650],
  absenceAfterDays: [1, 30],
  'browse.topN': [1, 20],
  'browse.deepRead': [0, 40],
  'browse.danmaku': [0, 30],
  'browse.perDay': [0, 4],
  'browse.images.max': [1, 6],
  'zhihu.images.max': [1, 6],
  'tieba.images.max': [1, 6],
  'bili.minIntervalMs': [200, 120000],
  'bili.jitterMs': [0, 60000],
  'video.perDay': [0, 6],
  'video.frames': [4, 16],
  'album.maxBytes': [256 * 1024, 20 * 1024 * 1024],
  'avoid.minDuration': [0, 3600],
  'comment.perDay': [0, 5],
  'comment.replyPerDay': [0, 10],
  'comment.scanEveryMin': [5, 720],
  'chat.rotateAfter': [0, 500],
  'chat.replyChars': [0, 2000],
  'memory.docBudget': [600, 4000],
  'memory.sleepEveryDays': [0, 60],
  'memory.sleepKeep': [0, 100],
  'memory.beliefsShown': [1, 8],
  'memory.hearEvery': [0, 50],
  'rules.holdDays': [1, 30],
  'rules.cooldownDays': [1, 30],
  'sleep.idle_to_sleep_min': [15, 720],
  'sleep.nap_min_h': [1, 12],
  'sleep.nap_max_h': [1, 18],
  'sleep.browse_interval_min_m': [5, 180],
  'sleep.browse_interval_max_m': [5, 360],
  'sleep.browse_max_per_wake': [0, 8],
  'sleep.weixin_session_idle_min': [1, 180],
  'tieba.recommendTopN': [1, 20],
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function setPath(obj, dotted, val) {
  const parts = dotted.split('.')
  const last = parts.pop()
  let cur = obj
  for (const p of parts) {
    if (typeof cur[p] !== 'object' || cur[p] === null || Array.isArray(cur[p])) cur[p] = {}
    cur = cur[p]
  }
  cur[last] = val
}

function clampNum(v, [lo, hi], dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

/**
 * 按 DEFAULTS 的形状补全（新增键自动出现，旧配置不会缺字段）。
 * 同时**保留 actual 里 DEFAULTS 没有的键**：用户自己往后加的自定义项不能因为
 * 插件版本没跟上就被吃掉（这是「配置可扩展」的底线）。
 */
function fillDefaults(defaults, actual) {
  if (Array.isArray(defaults)) {
    return Array.isArray(actual) ? actual.filter((x) => typeof x === 'string').map((s) => s.trim()).filter(Boolean) : [...defaults]
  }
  if (defaults && typeof defaults === 'object') {
    const out = {}
    const act = actual && typeof actual === 'object' && !Array.isArray(actual) ? actual : {}
    for (const [k, v] of Object.entries(defaults)) {
      out[k] = fillDefaults(v, act[k])
    }
    for (const [k, v] of Object.entries(act)) {
      if (!(k in out)) out[k] = v
    }
    return out
  }
  return actual === undefined || actual === null ? defaults : actual
}

function normalizeSilenceMs(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(SILENCE_MAX_MS, Math.round(n)))
}

function normalizeAckPhrases(v) {
  if (!Array.isArray(v)) return [...DEFAULT_ACK_PHRASES]
  const out = []
  const seen = new Set()
  for (const x of v) {
    const s = String(x ?? '').trim()
    const key = s.toLowerCase()
    if (!s || s.length > 24 || seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= 48) break
  }
  return out
}

/** 上网看图：enabled 严格布尔；max 钳到 1–6，缺省跟 DEFAULTS。 */
export function normalizeImages(raw, fallback = { enabled: true, max: 2 }) {
  const base = fallback && typeof fallback === 'object' ? fallback : { enabled: true, max: 2 }
  const cur = raw && typeof raw === 'object' ? raw : {}
  const maxN = Number(cur.max)
  return {
    enabled: cur.enabled !== false,
    max: Number.isFinite(maxN) ? Math.max(1, Math.min(6, Math.round(maxN))) : Math.max(1, Math.min(6, Number(base.max) || 2)),
  }
}

/** 知乎 / 贴吧评论：配额上限和 B 站对齐（评论 0–5，回复 0–10，扫回复 5–720 分钟）。 */
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
 * 某一路「每天最多几次」。作息页是唯一入口；旧的 perDay 只在迁移时读。
 * @param {object} cfg 规范化后的配置
 * @param {'bili'|'douyin'|'zhihu'|'recommend'|'comment'|'reply'} name
 */
export function dailyQuota(cfg, name) {
  const v = Number(cfg?.sleep?.daily?.[name])
  if (Number.isFinite(v) && v >= 0) return Math.round(v)
  const fallback = Number(DEFAULTS.sleep.daily?.[name] ?? 0)
  return Number.isFinite(fallback) ? fallback : 0
}

export function normalizeConfig(raw = {}) {
  const cfg = fillDefaults(DEFAULTS, raw || {})

  for (const [key, range] of Object.entries(LIMITS)) {
    const cur = getPath(cfg, key)
    setPath(cfg, key, Math.round(clampNum(cur, range, getPath(DEFAULTS, key))))
  }

  // 时间窗：两个合法 HH:MM 且 起 != 止；跨零点（22:00–02:00）也允许
  cfg.window = validWindow(cfg.window, DEFAULTS.window)

  cfg.growthDays = Math.round(cfg.growthDays)
  cfg.diary = { ...DEFAULTS.diary, ...cfg.diary }
  cfg.diary.visible = Boolean(cfg.diary.visible)
  cfg.diary.enabled = Boolean(cfg.diary.enabled)

  // 黑名单：去重、去空、保序（用户以后往数组里 push 就行，加一条不用改代码）
  cfg.avoid = { ...DEFAULTS.avoid, ...cfg.avoid }
  cfg.avoid.keywords = dedupe(cfg.avoid.keywords)
  cfg.avoid.upMids = dedupe(cfg.avoid.upMids)

  // 刷站：布尔严格化 + 关键词去重（同上，可追加）+ 上网时段自校验
  cfg.browse = { ...DEFAULTS.browse, ...cfg.browse }
  cfg.browse.enabled = Boolean(cfg.browse.enabled)
  cfg.browse.homeEnabled = cfg.browse.homeEnabled !== false
  cfg.browse.hotEnabled = cfg.browse.hotEnabled !== false
  cfg.browse.danmakuEnabled = cfg.browse.danmakuEnabled !== false
  cfg.browse.voices = false // 2026-11-06：读评论先停，等统一到社会层再接回
  cfg.browse.keywords = dedupe(cfg.browse.keywords)
  cfg.browse.images = normalizeImages(cfg.browse.images, DEFAULTS.browse.images)
  // 刷抖音：默认关；时段留空表示跟 browse.window 走（空数组不算坏值）
  const dyin = cfg.browse.douyin && typeof cfg.browse.douyin === 'object' ? cfg.browse.douyin : {}
  cfg.browse.douyin = { ...DEFAULTS.browse.douyin, ...dyin }
  cfg.browse.douyin.enabled = cfg.browse.douyin.enabled === true
  cfg.browse.douyin.owner = cfg.browse.douyin.owner === 'her' ? 'her' : 'owner'
  cfg.browse.douyin.perDay = Math.max(0, Math.min(4, Number(cfg.browse.douyin.perDay) || 0))
  cfg.browse.douyin.topN = Math.max(1, Math.min(20, Number(cfg.browse.douyin.topN) || 4))
  cfg.browse.douyin.browserPath = String(cfg.browse.douyin.browserPath ?? '').slice(0, 400)

  // 知乎归一在子包 normalizeZhihu。fillDefaults 已经按默认值补过一层。
  const zh = cfg.zhihu && typeof cfg.zhihu === 'object' ? cfg.zhihu : {}
  cfg.zhihu = zhihuConfigApi().normalizeZhihu(zh)

  const tb = cfg.tieba && typeof cfg.tieba === 'object' ? cfg.tieba : {}
  cfg.tieba = { ...DEFAULTS.tieba, ...tb }
  cfg.tieba.enabled = cfg.tieba.enabled === true
  cfg.tieba.owner = cfg.tieba.owner === 'her' ? 'her' : 'owner'
  cfg.tieba.recommendTopN = Math.max(1, Math.min(20, Number(cfg.tieba.recommendTopN) || DEFAULTS.tieba.recommendTopN))
  const tc = tb.comment && typeof tb.comment === 'object' ? tb.comment : {}
  cfg.tieba.comment = normalizeThreadComment(tc, DEFAULTS.tieba.comment)
  cfg.tieba.images = normalizeImages(cfg.tieba.images, DEFAULTS.tieba.images)
  // 进帖/进吧不再由调度器自动做（她想点才点，走 tieba_look），旧键直接丢掉。
  delete cfg.tieba.thread
  delete cfg.tieba.forum

  // 请求节奏：夹值已由 LIMITS 做过，这里只保证是对象（老配置里没有这一组）
  cfg.bili = { ...DEFAULTS.bili, ...cfg.bili }
  cfg.bili.owner = cfg.bili.owner === 'owner' ? 'owner' : 'her'

  // 相册上限：LIMITS 已经夹过。这里只保证是对象，避免老配置缺这一组。
  cfg.album = { ...DEFAULTS.album, ...(cfg.album && typeof cfg.album === 'object' ? cfg.album : {}) }
  cfg.album.maxBytes = Math.round(Number(cfg.album.maxBytes) || DEFAULTS.album.maxBytes)

  const meme = cfg.meme && typeof cfg.meme === 'object' ? cfg.meme : {}
  cfg.meme = { ...DEFAULTS.meme, ...meme }
  cfg.meme.enabled = cfg.meme.enabled === true
  cfg.meme.packs = dedupe(cfg.meme.packs)
    .filter((id) => /^[A-Za-z0-9_-]{1,40}$/.test(id))
    .slice(0, 8)
  if (!cfg.meme.packs.length) cfg.meme.packs = [...DEFAULTS.meme.packs]
  cfg.meme.maxPerTurn = Math.max(0, Math.min(5, Math.round(Number(cfg.meme.maxPerTurn) || 0)))

  // 提醒：布尔严格化 + lastShown 只收字符串（它的值是日期键，不是数字）
  cfg.notify = { ...DEFAULTS.notify, ...cfg.notify }
  cfg.notify.enabled = Boolean(cfg.notify.enabled)
  cfg.notify.lastShown = String(cfg.notify.lastShown ?? '')

  // 说话（写操作）：布尔严格化 + 时段自校验（坏值回退到自己的默认，不跟着 window 变）
  cfg.comment = { ...DEFAULTS.comment, ...cfg.comment }
  cfg.comment.enabled = Boolean(cfg.comment.enabled)
  cfg.comment.replyToReplies = Boolean(cfg.comment.replyToReplies)
  cfg.comment.atOwner = cfg.comment.atOwner !== false
  cfg.comment.lastScanAt = String(cfg.comment.lastScanAt ?? '')

  // 出门：只存一个布尔（老配置里没有这一组）
  cfg.outing = { ...DEFAULTS.outing, ...cfg.outing }
  cfg.outing.ack = Boolean(cfg.outing.ack)

  // 主动说话（0.8.1 本机实验）：布尔严格化 + 数值夹紧（夹紧规则真身在 proactive.js）
  cfg.proactive = { ...DEFAULTS.proactive, ...cfg.proactive }
  cfg.proactive.enabled = Boolean(cfg.proactive.enabled)

  // 主动发消息：布尔 + 次数夹紧。渠道先固定微信（其他渠道没有 context_token 语义）。
  cfg.outreach = { ...DEFAULTS.outreach, ...(cfg.outreach && typeof cfg.outreach === 'object' ? cfg.outreach : {}) }
  cfg.outreach.enabled = cfg.outreach.enabled === true
  cfg.outreach.channel = 'weixin'
  cfg.outreach.perDay = Math.max(0, Math.min(3, Math.round(Number(cfg.outreach.perDay) || 0)))

  // 作息：布尔 + 时刻。上限小于下限时把上限抬到下限，避免抽出负的小睡。
  const sl = cfg.sleep && typeof cfg.sleep === 'object' ? cfg.sleep : {}
  cfg.sleep = { ...DEFAULTS.sleep, ...sl }
  cfg.sleep.active_start = TIME_RE.test(String(cfg.sleep.active_start ?? ''))
    ? String(cfg.sleep.active_start)
    : DEFAULTS.sleep.active_start
  cfg.sleep.active_end = TIME_RE.test(String(cfg.sleep.active_end ?? ''))
    ? String(cfg.sleep.active_end)
    : DEFAULTS.sleep.active_end
  if (cfg.sleep.active_start === cfg.sleep.active_end) {
    cfg.sleep.active_start = DEFAULTS.sleep.active_start
    cfg.sleep.active_end = DEFAULTS.sleep.active_end
  }
  if (cfg.sleep.nap_max_h < cfg.sleep.nap_min_h) cfg.sleep.nap_max_h = cfg.sleep.nap_min_h
  if (cfg.sleep.browse_interval_max_m < cfg.sleep.browse_interval_min_m) {
    cfg.sleep.browse_interval_max_m = cfg.sleep.browse_interval_min_m
  }
  const probIn = sl.browse_prob && typeof sl.browse_prob === 'object' ? sl.browse_prob : {}
  const prob = {}
  for (const k of ['bili', 'douyin', 'zhihu', 'reply', 'tieba']) {
    if (probIn[k] == null || probIn[k] === '') continue
    const n = Number(probIn[k])
    if (!Number.isFinite(n)) continue
    prob[k] = Math.max(0, Math.min(1, n))
  }
  cfg.sleep.browse_prob = prob

  // 每天配额：新配置放 sleep.daily；老配置里那些 perDay 只当迁移来源。
  // 迁移只认「sleep.daily 里缺的那一项」，之后改旧键不再影响运行。
  const dailyIn = raw?.sleep?.daily && typeof raw.sleep.daily === 'object' ? raw.sleep.daily : {}
  const legacyDaily = {
    bili: cfg?.browse?.perDay,
    douyin: cfg?.browse?.douyin?.perDay,
    zhihu: cfg?.zhihu?.perDay,
    comment: cfg?.comment?.perDay,
    reply: cfg?.comment?.replyPerDay,
  }
  const dailyCaps = { bili: 8, douyin: 8, zhihu: 12, tieba: 8 }
  const daily = {}
  for (const k of Object.keys(DEFAULTS.sleep.daily)) {
    const picked = dailyIn[k] ?? legacyDaily[k] ?? DEFAULTS.sleep.daily[k]
    const n = Math.round(Number(picked))
    daily[k] = Number.isFinite(n) ? Math.max(0, Math.min(dailyCaps[k], n)) : DEFAULTS.sleep.daily[k]
  }
  cfg.sleep.daily = daily
  // 评论 / 回评论不是「出门次数」，搬回 comment 那组（旧 sleep.daily 里的值只做一次迁移）。
  if (dailyIn.comment != null) cfg.comment.perDay = dailyIn.comment
  if (dailyIn.reply != null) cfg.comment.replyPerDay = dailyIn.reply
  delete cfg.sleep.enabled

  // 渠道：布尔严格化 + 群号去重（群号可能是数字，统一成字符串再比）
  // 只认已登记的渠道名（qq/bili/douyin/weixin），别的键原样留着但不进 cfg.channels——
  // 避免把拼错的渠道名当功能开关，让人以为开了却没生效。
  cfg.channels = { ...DEFAULTS.channels, ...(cfg.channels && typeof cfg.channels === 'object' ? cfg.channels : {}) }
  for (const key of Object.keys(DEFAULTS.channels)) {
    const cur = cfg.channels[key] && typeof cfg.channels[key] === 'object' ? cfg.channels[key] : {}
    cfg.channels[key] = { ...DEFAULTS.channels[key], ...cur }
    cfg.channels[key].enabled = cfg.channels[key].enabled === true
    cfg.channels[key].replyInGroup = cfg.channels[key].replyInGroup === true
    cfg.channels[key].groups = dedupe(Array.isArray(cfg.channels[key].groups) ? cfg.channels[key].groups.map((g) => String(g).trim()) : [])
    // 字符串类环境参数统一截干净：没填就是空串，不是 undefined。
    for (const k of ['wsUrl', 'accessToken', 'browserPath', 'bridgePath', 'ownerId', 'homeUrl', 'closeIds']) {
      if (cfg.channels[key][k] !== undefined) cfg.channels[key][k] = String(cfg.channels[key][k] ?? '').trim().slice(0, 400)
    }
    // 2026-11-06：号主/场合从渠道配置退役。谁重要看 ownerId/closeIds，场合由代码算。
    delete cfg.channels[key].accountOf
    delete cfg.channels[key].bond
  }

  // 她的工具面：preset 名 trim（空 = 用宿主默认组合），allow 去重去空
  // 不改 allow 的语义——它只是"额外放行"，真正的收窄由 preset 完成。
  cfg.tools = { ...DEFAULTS.tools, ...cfg.tools }
  cfg.tools.preset = String(cfg.tools.preset ?? '').trim()
  cfg.tools.restrict = cfg.tools.restrict !== false
  cfg.tools.allow = dedupe(cfg.tools.allow)

  // 对话与界面（2026-10-25）：replyChars 由 LIMITS 夹值，这里只补布尔严格化
  cfg.chat = { ...DEFAULTS.chat, ...cfg.chat }
  cfg.ui = { ...DEFAULTS.ui, ...cfg.ui }
  cfg.ui.ownerHintDismissed = Boolean(cfg.ui.ownerHintDismissed)

  // 分段连发：只认显式 true。缺键、字符串、0 都当关——关掉必须和现在完全一样。
  // 标点轻整理：只认显式 false 才关。缺键就是开。
  // 静默窗：null / 缺键 = 按场合；数字含 0 是显式覆盖（0 = 一律不等）。
  // 确认静默：只认显式 false 才关。名单不是数组时回到默认短名单。
  cfg.im = { ...DEFAULTS.im, ...(cfg.im && typeof cfg.im === 'object' ? cfg.im : {}) }
  cfg.im.bubbleSplit = cfg.im.bubbleSplit === true
  cfg.im.casualPunctuation = cfg.im.casualPunctuation !== false
  cfg.im.inboundSilenceMs = normalizeSilenceMs(cfg.im.inboundSilenceMs)
  cfg.im.ackSilence = cfg.im.ackSilence !== false
  cfg.im.ackPhrases = normalizeAckPhrases(cfg.im.ackPhrases)

  return cfg
}

/**
 * 时段校验：两个合法 HH:MM 且起止不同。
 * 坏值一律回退到**它自己的默认**，不跟着别的时段走
 * （否则把"醒来时间"改坏会顺手把"上网时间"也改掉）。
 */
function validWindow(w, fallback) {
  const a = Array.isArray(w) ? w : fallback
  const ok = a.length === 2 && TIME_RE.test(String(a[0])) && TIME_RE.test(String(a[1])) && String(a[0]) !== String(a[1])
  return ok ? [String(a[0]), String(a[1])] : [...fallback]
}

function dedupe(arr) {
  const seen = new Set()
  const out = []
  for (const x of Array.isArray(arr) ? arr : []) {
    const s = String(x ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 给观测台看的渠道配置：`accessToken` 只回「设没设」，不回原值。
 *
 * 面板保存走 `patchChannel`，只提交改动的键；所以 GET 里把 token 置空
 * 不会被自动保存写回去（`buildConfig` 里没有 channels）。"清掉"由界面上
 * 单独的按钮发 `{ accessToken: '' }`。
 */
export function publicChannelSettings(channels = {}) {
  const out = {}
  for (const [name, raw] of Object.entries(channels ?? {})) {
    if (!raw || typeof raw !== 'object') continue
    const { accessToken, ...rest } = raw
    out[name] = {
      ...rest,
      accessToken: '',
      accessTokenSet: String(accessToken ?? '').trim() !== '',
    }
    if (Array.isArray(raw.groups)) out[name].groups = [...raw.groups]
  }
  return out
}

/**
 * 白名单输入 → 名字数组（纯函数）。
 * 分隔符与界面一致：半角/全角逗号、空格、换行都算，去重保序。
 */
export function parseToolNames(input) {
  // 数组也要再拆一次：界面偶尔会把「一项里带逗号」的东西整条提上来，
  // 拼错的名字就这样混过形状校验，最后整条收窄失效。
  const raw = (Array.isArray(input) ? input : [input]).flatMap((x) => String(x ?? '').split(/[,，\s]+/))
  const seen = new Set()
  const out = []
  for (const x of raw) {
    const s = String(x ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 白名单校验（纯函数）：拼错的字母、根本不存在的工具 → unknown，**不许保存**。
 *
 * 为什么必须挡（2026-10-24 查明）：宿主 `tools.restrict({ allow })` 遇到不认识的名字会
 * 抛错，整条收窄当场不生效——她会退回全量工具面。所以这里宁可不让存。
 *
 * `known` 传 null（拿不到名单）时只做形状校验，返回 checked:false，
 * 不把「不知道」当成「不存在」。
 */
export function validateToolNames(input, known) {
  const names = parseToolNames(input)
  const list = Array.isArray(known) ? known.map((x) => String(x)) : null
  const knownSet = list && list.length ? new Set(list) : null
  const unknown = []
  for (const n of names) {
    // 工具名一律小写 + 数字 + 下划线（宿主注册名就是这个形状）
    if (!/^[a-z][a-z0-9_-]*$/.test(n)) { unknown.push(n); continue }
    if (knownSet && !knownSet.has(n)) unknown.push(n)
  }
  return { ok: unknown.length === 0, names, unknown, checked: Boolean(knownSet) }
}

/**
 * 保存前的清洗（0.8.3，2026-10-31 issue #14 @ming-fish）：把「这台机器上确实没有」
 * 的名字丢掉，其余照常留下。
 *
 * 为什么不再整表拒绝：设置页的自动保存是**整表提交**，一个人手改过的 `config.json` 里
 * 只要留着一个早就没有的工具名，就会让整页所有设置都存不进去，而界面上的提示还指着
 * 「插件这一版还没接上它」——方向完全错了。他遇到的那个名字是裸的 `delete`。
 *
 * 丢弃不等于放过：丢掉的名字会随 `dropped` 原样回给界面，用户看得到自己少了什么，
 * 拼错的字母也不会悄悄生效。用户自己手输白名单的那条路（`saveTools`）仍然严格拦，
 * 因为那时候是**他刚敲进去的字**，该当场告诉他打错了。
 */
export function sanitizeToolNames(input, known) {
  const check = validateToolNames(input, known)
  const drop = new Set(check.unknown)
  const names = check.names.filter((n) => !drop.has(n))
  return { names, dropped: check.unknown, checked: check.checked }
}

/** 读配置之后要跟着更新运行时状态的东西（例如 B 站的请求节奏）。 */
const configHooks = []

/** 注册一个配置生效后的回调；同一个函数只注册一次。 */
export function onConfigLoaded(fn) {
  if (typeof fn === 'function' && !configHooks.includes(fn)) configHooks.push(fn)
}

function notifyConfig(config) {
  for (const fn of configHooks) {
    try { fn(config) } catch { /* 配置回调失败不连累读配置 */ }
  }
}

/** 读配置（文件不存在时返回默认值，不写盘） */
// 每个 root 只收一次权限：老版本写下的 config.json 是 0644，里面有渠道令牌。
// 只收紧、不放松；Windows 上 chmod 基本是 no-op，失败也吞掉。
const configModeChecked = new Set()

export async function loadConfig(root) {
  const file = paths(root).config
  if (!configModeChecked.has(file)) {
    configModeChecked.add(file)
    await fs.chmod(file, 0o600).catch(() => {})
  }
  const raw = await readConfig(root)
  let res
  if (raw === null) {
    res = { config: normalizeConfig({}), fresh: true, broken: false }
  } else {
    let broken = false
    try {
      res = { config: normalizeConfig(raw), fresh: false, broken }
    } catch {
      broken = true
      res = { config: normalizeConfig({}), fresh: false, broken }
    }
  }
  // 每次读配置都把新值推给关心它的运行时模块（B 站节奏由 index.js 注册的回调接）。
  // 失败也不能连累读配置本身。
  notifyConfig(res.config)
  return res
}

/** 合并式更新：只改你传的键，其余保持。传未知键会原样存下（向前兼容）。 */
export async function updateConfig(patch, root) {
  const { config: cur } = await loadConfig(root)
  const merged = deepMerge(cur, patch && typeof patch === 'object' ? patch : {})
  const next = normalizeConfig(merged)
  await writeConfig(next, root)
  return next
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

/** 当前是否落在今天的活跃时间窗内 */
export function inWindow(cfg, now = new Date()) {
  const [sh, sm] = cfg.window[0].split(':').map(Number)
  const [eh, em] = cfg.window[1].split(':').map(Number)
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = sh * 60 + sm
  const end = eh * 60 + em
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end
}

/** 今天的日期键（本地时区，YYYY-MM-DD） */
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 时间窗内随机一个落点（同一个 seed 稳定，便于测试） */
export function pickWakeTime(cfg, seed = Math.random()) {
  const [sh, sm] = cfg.window[0].split(':').map(Number)
  const [eh, em] = cfg.window[1].split(':').map(Number)
  const start = sh * 60 + sm
  let end = eh * 60 + em
  if (end <= start) end += 24 * 60
  const t = start + Math.floor(seed * (end - start))
  return ((t % 1440) + 1440) % 1440
}

export async function configFileInfo(root) {
  const p = paths(root)
  const raw = await readJson(p.config, null)
  return { path: p.config, exists: raw !== null, keys: raw ? Object.keys(raw) : [] }
}
