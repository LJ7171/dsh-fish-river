# dsh-fish-river-zhihu

大肥鱼（[dsh-fish-river](https://github.com/LJ7171/dsh-fish-river)）的**可选子包**。
知乎自己的事都在这里：登录、接口、解析、素材、点开、评论、楼中楼、写回答、工具注册，以及这一组设置的默认值和文案。

**不私信、不点赞、不改资料。** 评论和写回答默认关。要 cookie 里的 `_xsrf`。要验证码就停，不自动过。

## 和主包的边界

子包**不 import 主包的 `lib/`**。鱼的政策由主包注入（`bindHost`）：

- 她醒着没有（作息）
- 这话能不能发出去
- 记一条动作、读事件
- 这个号是谁的（素材措辞）
- 每天刷几次（作息配额）

主包不重写知乎规则。调度、观测台、工具注册都走 `loadZhihu`：先找已安装的 `dsh-fish-river-zhihu`，没有就用仓库里这一份。没装时这些调用直接降级，不把插件拖垮。

设置页仍由主包 `lib/client.js` 画（浏览器里只能 `require('react')`）。默认值、夹紧和文案的真身是本包的 `config.js`（`ZHIHU_DEFAULTS` / `normalizeZhihu` / `ZHIHU_COPY`）。`lib/client.js` 里留了对照钩子，表单这一步先不搬。

事件前缀不变：`zhihu:`、`zhihu-open:`、`zhihu-comment:`、`zhihu-reply:`、`zhihu-answer:`、`zhihu-cseen:`。

## 为什么放子包

知乎没有面向个人的开放消息 API，这里的接口是网页/移动端的内部接口（逆向）。
按主仓 `AGENTS.md` §9，逆向协议不进主包。没装时主包连这些规则都不会加载。

贴吧、B 站这次没搬。以后别的平台可以走同一扇门（`lib/host/platformHost.js`）。

## 装法

**随仓库分发，通常不用单独装。** 只有从 npm 装主包的人，才需要额外装：

```sh
dsh plugin --profile web add ./packages/dsh-fish-river-zhihu
```

## 登录

设置 → 大肥鱼 → **上网** → 知乎 → **扫码登录**。

走的是知乎官方扫码接口，纯 `fetch`、不需要浏览器：

```
GET  /signin                                拿 _xsrf / d_c0
POST /udid                                  补设备 cookie
POST /api/v3/account/api/login/qrcode       → { token, link }
GET  /api/v3/account/api/login/qrcode/{token}/scan_info
     未确认 → 403 {"need_login":true}；确认后 Set-Cookie: z_c0=…
```

cookie 只写 `<数据目录>/zhihu-auth.json`（0600），不进日志、不回显、不写进 config。

## 接口与为什么要用两个域名

| 用途 | 接口 | 说明 |
|---|---|---|
| 热榜 | `www.zhihu.com/api/v3/feed/topstory/hot-lists/total` | 网页端，**不需要**签名 |
| 首页推荐 | `www.zhihu.com/api/v3/feed/topstory/recommend` | 网页端，不需要 `session_token`（实测） |
| 浏览历史 | `www.zhihu.com/api/v4/unify-consumption/read_history` | 网页端，读的是「这个号看过什么」 |
| 关注动态 | `api.zhihu.com/moments` | **移动端**，只要 cookie，不校验 `x-zse-96` |
| 邀请回答 / 问题推荐 | `api.zhihu.com` 对应接口 | 只有「允许回答问题」开着才抓 |
| 写回答 | 先 `publish/control/v2`，再 `www.zhihu.com/api/v4/content/publish` | 控制失败就不发 |
| 评论 / 楼中楼 | 评论接口 | 楼中楼同时带被回的那条和自己的主楼 |
| 认账号 | `www.zhihu.com/api/v4/me` | 登录后校验用 |

实测（2026-11-04）：网页端的 `/api/v4/members/{token}/answers` 等接口会回
`403 {"code":10003,"message":"请求参数异常，请升级客户端后重试"}`——它要 `x-zse-96` 签名；
同一份数据走 `api.zhihu.com/members/{token}/answers` 就是 200。所以能走移动端就走移动端。

## 这个包现在负责什么

- 热榜、关注、首页推荐、浏览历史：拼成当次素材，不写事件流
- 回答开关开着时，额外给最多 6 条候选问题（邀请 / 推荐 / 首页）
- `zhihu_look`：列表，以及点进问题、回答、评论（图会落到本机）
- `zhihu_speak`：评今天点开过的回答、回自己评论下面的话、给今天点开过的问题写回答
- 扫自己评论下面的新回复（睡着不发请求）

频率、能不能说、社会层开没开，由主包决定。

## 已知限制

- 不私信，不发图片或表情到评论 / 回答里。
- 知乎随时可能给移动端也加签名；协议改动集中在 `api.js`。
- 一天刷几次由主包作息配额管（默认 4）。子包自己不做限流。

## 测试

```sh
node --test
```

在仓库根跑全套。子包用例在 `packages/dsh-fish-river-zhihu/test/`，不联网。

MIT。
