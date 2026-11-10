# dsh-fish-river-zhihu

大肥鱼（[dsh-fish-river](https://github.com/LJ7171/dsh-fish-river)）的**可选子包**：
给她一条知乎素材线——当日热榜 + 关注动态；评论、楼中楼和写回答默认关着，开了才写。

**不私信、不点赞、不改资料。** 评论和写回答要 cookie 里的 `_xsrf`。要验证码就停，不自动过。

## 为什么放子包

知乎没有面向个人的开放消息 API，这里的接口是网页/移动端的内部接口（逆向）。
按主仓 `AGENTS.md` §9，逆向协议不进主包——所以它和抖音一样，靠「装不装」体现可选：
没装时主包连 `import` 都不会发生。

## 装法

**随仓库分发，通常不用单独装。** 主包先找已安装的 `dsh-fish-river-zhihu`，
找不到就直接加载仓库里这一份（`lib/zhihu.js` 的 `loadZhihu`），和抖音同一个约定。
只有从 npm 装主包的人，才需要额外装：

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
| 浏览历史 | `www.zhihu.com/api/v4/unify-consumption/read_history` | 网页端，读的是「他看过什么」 |
| 关注动态 | `api.zhihu.com/moments` | **移动端**，只要 cookie，不校验 `x-zse-96` |
| 认账号 | `www.zhihu.com/api/v4/me` | 登录后校验用 |

实测（2026-11-04）：网页端的 `/api/v4/members/{token}/answers` 等接口会回
`403 {"code":10003,"message":"请求参数异常，请升级客户端后重试"}`——它要 `x-zse-96` 签名；
同一份数据走 `api.zhihu.com/members/{token}/answers` 就是 200。所以能走移动端就走移动端。

## 已知限制

- 只有热榜和关注动态；**浏览历史**（`/api/v4/unify-consumption/read_history`）已经验证可用，
  但那是「主人看过什么」，默认关，留给下一版接。
- 没有评论/私信/点赞/收藏。
- 知乎随时可能给移动端也加签名；真到那天，改动集中在 `api.js` 一个文件里。
- 频率由主包控制（默认一天 4 次），子包自己不做限流。

## 测试

```sh
node --test test/zhihu.test.mjs
```

不联网：热榜与关注动态的两种报文形状是假的，解析、去重、降级都在纯函数里验。

MIT。
