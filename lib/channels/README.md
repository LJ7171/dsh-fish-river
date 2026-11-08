# 渠道适配器契约

主包只认这一份接口。渠道实现**不许**直接读写 `events.jsonl`、不许自己决定回不回、
不许自己拼提示词——那些是 `router.js` 与 `gate.js` 的事。适配器只干两件事：
**把外面的话搬进来**，**把她的话送出去**。

## 接口

```js
import { create } from './qq.js'

const adapter = create({
  log,                 // (...a) => void
  config,              // 这个渠道自己的配置段（见下）
  WebSocketImpl,       // 测试注入用；缺省 globalThis.WebSocket
  fetchImpl,           // 测试注入用；缺省 globalThis.fetch
  now,                 // 测试注入用；缺省 Date.now
})

adapter.name                     // 'qq' | 'bili' | 'douyin' | 'weixin'
await adapter.start()            // → { ok, why }  永不抛
await adapter.stop()             // → void
await adapter.send({             // → { ok, id?, why? }  永不抛
  conversation: { kind: 'dm' | 'group', id, name },
  text,
  images,                    // 可选。本机绝对路径。目前只有 weixin 会把它们发出去
})
const off = adapter.onMessage(fn)  // → 注销函数
```

## 进来的一条消息（规范化后）

```js
{
  channelId: 'qq',            // 与 schema.js 的 CHANNELS 一致
  kind: 'dm' | 'group',
  conversationId: '123456',   // 群号 / 对方 uid（字符串，永远）
  conversationName: '群名',    // 拿不到就 ''
  personId: 'u_123456',       // 全局唯一，前缀见下
  personName: '昵称',
  text: '……',                 // 已去掉 @ 机器人、已 trim；空串表示只有图/表情
  images: [],                 // 图片 url 或本地路径，可为空
  at: 1700000000000,
  raw: { … }                  // 原始报文，只给排查用，不许进提示词
}
```

`personId` 一律带渠道前缀（`u_` + 平台 uid），跨渠道的同名人不合并——
「同一个人」是 `people.js` 的判断，不是适配器的。

## 规则（违背了就是改坏了）

1. **永不把异常抛给调用方。** `start` / `send` / `stop` 一律返回对象；异常在里面吞掉、记日志。
2. **重连自己管。** 阶梯退避，别让 router 去管 socket。断了要把 `ok:false` 记进 `adapter.status()`。
3. **凭据不许进日志。** cookie / access_token / SESSDATA 打印前打码（照 `lib/log.js` 的 `scrub`）。
   设置页的 `GET /channels` 也不回 `accessToken` 原值，只回 `accessTokenSet`。
4. **不许在模块加载时建连接。** 只有 `start()` 里才碰网络——否则插件 import 阶段就会被拖死。
5. **不许有运行时依赖。** HTTP 用 `fetch`，WS 用 `globalThis.WebSocket`（Node 22+），
   CDP 用 `child_process` + 内置 WS。`package.json` 的三个依赖字段必须保持 `{}`。
6. **进站文本必须过 `guard.js` 的 `sanitizeForeign` + `looksLikeRewriting`。**
   适配器可以只做 `sanitizeForeign`，但**不许**把原始文本直接交出去。
7. **`send()` 里不许再判断"该不该说"。** 只判断"技术上能不能发"（超长切段、被禁言、没登录）。
   该不该说是 router 的事。

## 配置段

每个渠道在 `config.json` 里占一个键，默认全关：

```json
{
  "channels": {
    "qq":     { "enabled": false, "wsUrl": "ws://127.0.0.1:3001", "accessToken": "", "groups": [], "replyInGroup": false, "mentionOnly": true, "ownerId": "", "closeIds": "", "bridgePath": "" },
    "bili":   { "enabled": false, "replyInGroup": false, "ownerId": "", "closeIds": "" },
    "douyin": { "enabled": false, "browserPath": "", "ownerId": "", "closeIds": "" },
    "weixin": { "enabled": false, "ownerId": "", "closeIds": "" }
  }
}
```

- `groups` 是群号白名单，空数组 = 一个群都不回。私聊不受它管。
- `ownerId` / `closeIds` 只决定「场合」（重要的人 / 近人 / 陌生人），不凭空抬 influence。
- `accessToken` 是 QQ 桥的访问令牌；适配器同时认旧的 `token` 键。
- 微信 ClawBot 没有群、没有 @，`replyInGroup` / `mentionOnly` / `groups` 对它无意义。
- 设置页只提交改动的键；令牌留空 = 不改，清空要走单独的按钮。

## 状态（给观测台读）

`adapter.status()` 返回可直接 JSON 的对象，**不许**含凭据：

```js
{ ok: true, connected: true, since: 1700000000000, lastError: '', queued: 0, sent: 12, received: 30 }
```
