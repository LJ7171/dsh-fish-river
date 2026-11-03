# 进度

这份文件只回答三个问题：**现在到哪了、下一步做什么、哪些坑已经踩过**。
产品事实看 `README.md`，不能做什么看 `AGENTS.md`，改了什么看 `CHANGELOG.md`。

---

## 这是什么

`dsh-fish-river` = 把 [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish) 的「她」与
[Britneycode/dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul) 的「渠道」合成一个插件。

四条立项前提（用户 2026-11-02 拍板）：

1. 人格只能长出来，禁止直接配；
2. 记忆是单一事件流 + 派生状态，只能追加；
3. 对外说话：DSH 会话 + QQ / B站 / 抖音；
4. 面向「观察一个存在」+「替我回消息」。

## 现在的状态

| | |
|---|---|
| 基线 | 从 dsh-fish 0.8.5 整包复制，包名改 `dsh-fish-river` 0.1.35，`engines.node` 提到 `>=22` |
| 测试 | **1312 个，1312 通过，0 失败，0 跳过**（原生独立进程跑约 49 秒） |
| 已跑通（真机） | DSH 会话；QQ 私聊 + 群聊（SnowLuma / OneBot 11）；B 站私聊收发、刷站、抽帧看画面；抖音私信收发 |
| 已完成 | 五字段 + 双通道派生、社会层开闸（`social_open`）、关系层、流水层、可见性闸门、私聊泄漏检测、渠道框架（router/gate/host）、代发、世界书、QQ / B站 / 抖音 适配器、B站扫码登录、渠道页签、观测台 `/channels` 与 `/worldbook`、抖音子包、群里只被 @ 才开口（`mentionOnly`） |
| 没做成 | 抖音推荐流：DOM 没有标题/作者，WS 帧只有私信。**但 `aweme/v1/web/tab/feed` 带 cookie 就能读（0.1.35 已实测 200/2 条）**，还没接进刷站；刷站目前仍走不了 |
| 未做 | 出行/帮主人回消息的权限细化、`migrate.js`（没有老数据） |

## 已经定下的事

- **五个可选字段**（`lib/schema.js`）：`person` / `visibility` / `channel` / `origin` / `influence`。
  全部可选，不写就不落 JSON，**不升 `EVENT_SCHEMA_VERSION`**。只收系统侧（`source !== 'tool'`），
  她自己改不了——否则等于绕过社会层那道闸。
- **两条成长通道**（`lib/derive.js`）：立宪层（`influence:'constitution'`，默认）进 `beliefs`；
  社会层（`influence:'social'`）只在**开闸之后**才被读，进 `model.influence.social`，不进 `beliefs`、
  不动阶段、不动称呼。`influence:'none'` 的流水事件完全不参与派生。
- **开闸是事件不是配置**：`meta social-open:<ISO>`。配置会跟着备份搬来搬去，事件流不会。
- **社会层 30% 权重上限**：`S ≤ C × 3/7`，超出的截最近的前 `cap` 条。
- **三层记忆**：成长（`events.jsonl`，追加）/ 关系（`people.json`，一人一条、可覆盖、≤150 字）/
  流水（`journal.json`，每会话最近 30 句、可淘汰）。后两层都是派生物，删了不失忆。
- **渠道默认全关**；群默认不开口；到第 3 阶段（自主）才搭理陌生人；名单外的群连听都不听。
- **渠道层是桥不是脑子**：进站过 `sanitizeForeign`，出站过 `screenOutgoing` + `looksLikePrivateLeak`，
  适配器自己不做「该不该说」的判断（见 `AGENTS.md` 第 9 节）。
- **可选装靠包装不装**：主包只认包名 `dsh-fish-river-douyin`，`loadAdapter` 在 `./douyin.js` 不存在时
  才去 import 那个包；没装就是没有这个渠道。
- **包名**：主包 `dsh-fish-river`，抖音子包 `dsh-fish-river-douyin`（npm 上的 `dsh-fish` 是别人的占位包）。
- **世界书**：允许配，但只当「她知道的事实」，单独存放、注入时与 identity 物理隔离，不进人格段。
- **没有老数据要迁**，所以 `migrate.js` 暂时不写。

## 社会层开闸（2026-11-02 已完成）

- `lib/socialgate.js`：四条闸（阶段≥3 / 立场≥6 / 30 天没整条推翻 / 活≥14 天且稳定度在 0.02–0.35），只从事件流算，不落盘、不可配置。
- `lib/social.js`：`social_open` 工具，她自己按才写 `social-open:<ISO>` 的 meta；差着时只回原因、不写事件。
- `lib/selfdoc.js`：差着时身份文档一个字不提；可以决定时出现「## 外面的人」；开了之后换成"不能收回"的说法。
- `test/social.test.mjs`：15 条。

## 代发与世界书（2026-11-02 已完成）

- **代发**：`POST /channels/send` → `router.sendAs` → 适配器。不问她、不过 gate、不写出站筛、不写事件流，只留 `role:owner` 流水。面板「最近的流水」每个会话带一个输入框。
- **世界书**：`lib/worldbook.js` + `/worldbook` 路由 + 设置页「她知道的事」。导入 SillyTavern lorebook（对象/数组都认），按关键词取 ≤5 条、≤1200 字，只进渠道路由的 `knowledgeBlock`，不进身份文档、不进 beliefs。
- **社会层真的被读到**：开闸后 `selfdoc.js` 写「我在外面学到的」（≤6 条），`router.buildPrompt` 写「在外面见过的做法」（≤5 条）。此前只派生不注入，开闸等于空转。
- **身份文档也带世界书**（用户 m01879）：`selfdoc.js` 写「## 我知道的事」（≤24 条），渠道提示词那一路不变。
- 测试：`test/worldbook.test.mjs` 6 条 + `test/channel-router.test.mjs` 代发 2 条 + 社会层注入 2 条。全套 **1218 / 1215 / 0 / 3**。

## 下一步

1. **抖音刷视频（唯一没做成的）**：推荐流的标题/作者不在 DOM（`/jingxuan` 只有 1 个 `<video>`、0 个 `/video/` 链接、0 个 `aweme_list`），WebSocket 帧只有 IM/直播，`Network.responseReceived` 里没有 `aweme/v1/web/tab/feed`（要签名）。唯一稳的路子是 **CDP 截屏 + 多模态**；动工前要先确认宿主的 `prompt` 能不能收图片块——现在 `buildPrompt` 只发文本。用户 2026-11-03 说「明天再说」。
2. **代发细化**：她拒发时面板要不要提示「你可以接话」——产品问题，等用户拍板。
3. **世界书取词质量**：真世界书导入后看关键词召回够不够用。
4. **观测台**：渠道页已有状态 / 认识的人 / 流水 / 拦截理由；还差「她在这个群学到的社会层片段」的可视化。
5. **权限细化**：出门 / 请神已在（隔离带 `influence:none`），但「她能不能替主人发」的边界还没写死——现在是「她不说时主人自己发」，不是「她授权代发」。

## 环境（本机）

PATH 里没有 node，用宿主自带的：

```
D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

v24.21.0，自带全局 `WebSocket` 与 `node:sqlite`。跑测试：

```
& 'D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test
```

## 踩过的坑

- `--test-isolation=none` 会因共享进程出现假红（ULID / cover），别拿它当准。
- 别写 `node --test "test/*.test.mjs"`（Node 20 不展开 glob）。
- 30% 上限在立宪层还很小时会退化成「只留 1 条」，这是有意的：宁可少，也不要让群聊在早期就占满身份。
- **`askHer` 的 pending 必须带 `sessionId`**：`ctx.on('session/event')` 第一句就按 sessionId 过滤，漏了它就永远等不到 `turn/end`（表现是测试 4 秒超时、生产里是她「没回话」）。
- **`people.list()` / `journal.threads()` 都是 async**：观测台里漏 `await` 会拿到 Promise，页面显示空白而不是报错。
- **「好感度」是客户端守门词**：`test/client.test.mjs` 逐字扫，连注释里写一句「这里没有好感度」都会红。要表达「她不给谁打分」就换说法。
- **页签顺序有测试钉着**：加页签要同时改 `test/principle.test.mjs` 的期望数组，否则红的是那条 deepEqual。
- 抖音渠道的脚本要在页面里跑，`JSON.stringify` 注入选择器；测试用假传输层，不需要浏览器。
- **渠道配置要以 `opts.config` 递给适配器**（2026-11-02）：宿主曾经摊平传参，适配器读到空对象 → token 空 → 连不上，而 `start()` 只要 socket 非空就返回 `ok:true`，界面照旧显示「已起」。失败被吞掉比报错难查得多。
- **「面板开着」不能用节点在不在判断**（2026-11-03，抖音）：面板收起时 `im-dialog` 还在 DOM 里，只是 `0×0`；要按 `getBoundingClientRect` 判。
- **抖音的 `im-entry` 是开关**：连点两次会把面板关掉，然后再也找不到会话项。`start()` 已经点过一次，探针不要再点。
- **`sameAs` 要收两种 id 写法**（2026-11-03）：设置里填裸 id（`10002`），事件里带前缀（`u_10002`）。只比裸串会把主人自己的话判成「外泄别人的私事」。
- **群聊 @ 规则会改一堆测试夹具**（2026-11-03）：`groupMsg` 默认给了 `mentionedSelf: true`，测 @ 规则本身才传 false；直接调 `canReply` 的断言也要补 `mentioned`。

