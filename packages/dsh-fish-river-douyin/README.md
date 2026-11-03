# dsh-fish-river-douyin

抖音渠道，`dsh-fish-river` 的可选子包。

```bash
pnpm add dsh-fish-river dsh-fish-river-douyin
```

装了这个包，主包的渠道层才会 import 到它；没装就没有这个渠道——其它三个（DSH 会话、QQ、B 站私信）照常。

## 它要求什么

- **一个真的 Chromium**：本机装着 Microsoft Edge 或 Google Chrome（Windows / macOS）。Linux 服务器要自己接 Xvfb，本包不做。
- **一个能扫码的桌面窗口**：第一次启动会打开浏览器，你自己扫码登录抖音；登录态存在 `--user-data-dir` 指向的独立配置目录里，**本包不读、不存、不打日志任何 cookie**。
- **一个固定端口**：默认 CDP 端口 9333。被占用时在设置里换一个。

## 它为什么是单独一个包

主包承诺「零依赖、装完就能跑」。抖音做不到：它靠浏览器自动化，要真窗口、要能扫码、DOM 一改就得跟着改。把这种东西塞进主包，等于让只想在 DSH 里陪她的人也为它付安装代价。

## 它有多脆（先说清楚）

| 脆点 | 说明 |
| --- | --- |
| DOM 选择器 | 全部集中在 `index.js` 的 `SELECTORS`，**没有在真机上校准过**。第一次接通时按浏览器里的实际结构改这一块，别改下面的逻辑。 |
| 账号风控 | 这是浏览器自动化，不是官方协议。频率别调太低，账号有可能被风控。 |
| 图形会话 | 无头环境跑不了；`--headless` 对登录态与消息列表都不友好。 |

## 校准选择器

1. 正常登录后打开 `https://www.douyin.com/chat`。
2. F12 里找到会话列表项、消息列表、输入框、发送按钮的真实选择器。
3. 改 `SELECTORS` 里对应的四个键：`conversationItem`、`messageList`/`messageItem`、`input`、`sendButton`。
4. 跑 `node --test test/douyin-channel.test.mjs`（用假传输层，不需要浏览器）。

## 接口

和主包的渠道契约一致（`dsh-fish-river/lib/channels/README.md`）：

```js
import { create } from 'dsh-fish-river-douyin'
const a = create({ browserPath: '', debugPort: 9333, intervalMs: 6000, log: console.log })
await a.start()
a.onMessage((m) => { /* m.channelId === 'douyin' */ })
await a.send({ conversation: { id: 'xxx', name: '某某' }, text: '在' })
a.status() // { ok, connected, since, lastError, queued, sent, received }
await a.stop()
```

`start()` / `send()` 永不抛：失败一律 `{ ok: false, why }`。

## 已知未验证

- 选择器（见上）。
- 抖音群聊的按人区分：本包只做私信（`kind: 'dm'`），群聊要先把列表项与发言人结构补齐。
- 发送失败后的重试：目前直接返回失败，交给上层决定要不要再说一次。
