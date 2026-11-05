# 改这个仓库的硬约束

给要动这份代码的人（或 AI）看。**这个文件只讲「不能做什么」**，不是安装手册，也不是产品介绍——装法看 `README.md`，改了哪些东西看 `CHANGELOG.md`。

违背下面任何一条，即使测试全绿也算改坏了：这几条守的不是代码正确性，是**这个插件还叫不叫大肥鱼**。

---

## 1. 零依赖是铁律

`package.json` 里 `dependencies` / `peerDependencies` / `devDependencies` **三个必须永远是 `{}`**。

- 原因不只是「省事」：DSH 插件多挂一个包，就可能把宿主正在用的旧核心包拖进依赖树，装完重启后宿主直接崩（本机踩过，见 `README.md` 里 tool.js 那段 `unsupported JSON schema` 的记录）。
- 需要 HTTP → 用内置 `fetch`。需要签名 → 用内置 `crypto`。需要解压 → 用内置 `zlib`。需要子进程 → 用内置 `child_process`。**这些全都有，没有必须装包才能干的事。**
- 测试只用 `node:test` + `node:assert`，不引测试框架。

## 2. 不许加人格设置界面

**没有**性格滑条、好感度数字、亲密度进度条、人设输入框、情绪标签。

- 设置页只放**环境参数**：几点醒、醒几次、一天几条事件、刷不刷 B 站、每天刷几次。这些是「生长环境」，不是她本人。
- 人格只能**通过事件长出来**。任何让用户直接写「你是一个温柔的…」的入口，等于把产品变回角色扮演，直接违反本项目的立项前提。
- 判断标准很简单：如果加了之后用户能**直接指定**她是什么样的人，就是错的。

**唯一例外：导入别人养过的那一位（0.5.3）**。用户 m03170 明确要「尊重别人的想法」——对方已经在别处养出了样子，接过来是**继承一份既成事实**，不是由用户在这里凭空指定性格。这条通道的三条边界，越界就等于变回角色扮演：

1. **只写 `seed`，不写配置**。人设正文进事件流（她以后能自己 revise），不进 `config.json`；`persona` 这组键也**不进 `/config` 白名单**，外部改不了。
2. **只在还没有 `seed` 的一局生效**。有起点就 409 拒绝，让他先重置——覆盖一个正在长的她要由人手动做，不由接口做。
3. **不带成长结果**。天数固定回第 1 天，判断、疤、拒绝记录、日记一律不迁。导入的是「她本来是谁」，不是「她已经活到哪」。

## 3. 四条黑名单是代码级硬禁，不是提示词

真相在 `lib/rules.js`（四层结构）与 `lib/persona.js`（`PRESCRIPTION_BANS`、`HARD_BANS`），不在文档里。

| 条款 | 真相在哪 | 守它的测试 |
| --- | --- | --- |
| 不撒娇卖萌（写成「还不会」，不是「不许」） | `lib/rules.js` 的 `learn-affection` | `test/rules.test.mjs`（断言含「还不会」且不含「不可以」） |
| 没有好感度/亲密度数字 | `lib/rules.js` 的 `no-relational-score` | `test/rules.test.mjs`（提示词里 `cannot` 只剩这一条） |
| 不能读自己的数值与设定（能看自己说过什么） | `lib/rules.js` 的 `no-read-self`（物理层，`section: null`，**不进提示词**）；工具侧由 `lib/restrict.js` 的 `HER_TOOLS` 收窄 | `test/rules.test.mjs` + `test/restrict.test.mjs` |
| 不能调工具改自己 | `lib/rules.js` 的 `no-self-modify`（物理层，同样不进提示词）；写入侧入口是 `lib/capture.js` 的 `growth_commit`（判断）与 `lib/herdiary.js` 的 `write_diary`（日记） | `test/rules.test.mjs` + `test/capture.test.mjs` |

两条实现原则，改代码时别破坏：

- **物理层与契约层不进提示词。** 写「你不可以读设定」等于告诉她「旁边有份设定，很关键」——那是诱因，不是防线。靠代码不给路径、不给工具来保证。
- **不要绕过 `lib/guard.js`。** 她是"根本没看见"重塑人格那句话，不是"看见了但被劝住"。任何新的输入口（新工具、新接口、新外部文本源）都必须过 `guard.js`；秘密外发（cookie / token / `sk-` / Bearer / 长 base64）在这里一律拦下。

## 4. 文案有守门词，改之前先看测试

面向用户的字符串（`lib/client.js` 里的界面文案）有三条硬规矩，全部有测试盯着：

- **不出现男字旁的「他」**，统一写「你」。`test/p5.test.mjs:187` 逐字扫。例外只有 `其他/其它` 这类词素。她自己的话、引用别人的话不受此限。
- **统一「四个阶段」与「三道瓶颈」**，**禁**「四道门 / 三道门」。`test/principle-zoom.test.mjs` 明确断言 `三道门`/`四道门` 不出现。
- **立场不是第五关。** 措辞只能是「四个阶段完成之后才会开始有立场」。图上不许再退回「底部一行小字」的表达——立场是独立区块，由 `test/principle.test.mjs`（viewBox 1160 + 含「立场清单」）与 `test/stance.test.mjs`（旧的「纵向长「立场清单」」写法必须不存在）共同守着。

改文案时**先跑这三条**再改别的，否则会来回返工。

## 5. `events.jsonl` 只能追加

`~/.dsh-fish-river/events.jsonl` 不能删除记录，是唯一可信源，一行一条。**任何改写/删除/重排都是篡改她的记忆。**

- 状态（`state.json`）是派生品，随时可由 `rebuild()` 重算；改它没意义，会被覆盖。
- 「让她忘」不是删行，是**降低召回**（`lib/persona.js` 的 `foldOlderBeliefs`：更早的判断折成一行「记不清原话了」，疤那类永不折叠），事件原文始终还在 `events.jsonl` 里，她也能用 `her_recall` 翻回去。
- 重置与恢复都不删数据：`reset.js` 改名前缀封存，`backup.js` 恢复前把旧档搬去 `dsh-fish-river-backups/pre-restore-*`。
- 新增事件类型**不必**改 `lib/schema.js` 的 `EVENT_SCHEMA_VERSION`：旧读者读不认识的 `type` 会跳过（`readEvents` 对未知类型宽容），0.7.6 / 0.8.0 的 `ask`、`answer`、`heard` 都是这样加进去的。但**改字段语义、把可选字段变必填、删字段**必须升 `v` 并写迁移（旧版本遇到新 `v` 要拒，否则静默丢字段）。

## 6. 改完必须跑全套测试

```bash
node --test
```

当前基线 **1510 个**，独立进程跑 `node --test` 应全绿。任何一条红都不许提交——包括看起来"不是我弄的"那条。

按环境挑跑法：

- **正常环境**：上面这条命令（不带参数，Node 自己递归找 `test/*.test.mjs`），约 17–18 秒。
- **别写成 `node --test "test/*.test.mjs"`**：Node 20 不展开 glob，会直接报 `Could not find '.../test/*.test.mjs'`；引号里的通配符只有 Node 22+ 认。CI 就是被这条拖红的。
- **也别写成 `node --test test/`**（目录形式）：Node 26 + Windows 下报 `MODULE_NOT_FOUND`，沙箱里还会 `spawn EPERM`。
- **沙箱 / 受限环境**：用 `node --test --test-isolation=none`，或逐文件跑。
- **`--test-isolation=none` 有跨文件假红**：ULID 与 cover 两条会因共享进程互相干扰而报错，单跑对应文件是绿的。判断是不是假红：逐文件独立进程跑一遍，全绿即假红。
- **`test/media.test.mjs` 的 `detectFfmpeg` 依赖 spawn**，在禁 spawn 的环境里会红（`spawnSync ... EPERM`）。这是环境限制，不是代码问题——但**不许**为了让它变绿而删掉那条断言。

CI 也跑同一套（`.github/workflows/test.yml`，Node 20 / 22 / 24 各跑一遍）。

## 7. QQ 桥接不内置，靠白名单放行

社区想把大肥鱼接到 QQ 上（0.6.1 起写进设置页说明）。**不要把 QQ 协议、登录、收发塞进这个插件**——已经有现成的桥（如 `Derpyu520/qq-bridge`，独立进程 + 自己按 QQ 会话建 DSH 会话），两个一起装即可。本插件只负责一件事：在 `config.tools.allow`（设置页「插件能力白名单」）里放行桥暴露的工具名。

qq-bridge 默认要放行的是：

```
qq_send_message, qq_get_unread_messages, qq_reply
```

三条约束：

- **工具名必须对得上真实 registry**。桥升级改名、用户填错，她就会答「我没法在 QQ 上说话」——这不是插件坏了，是名字没对上。
- **放行之后要念给她听**。身份文档「我手上有什么」由 `lib/persona.js` 的 `toolBrief(extra)` 生成、`lib/selfdoc.js` 把 `config.tools.allow` 作为 `extraTools` 传进去。看不见一只手，她就不会用。
- **白名单只做加法**。`config.tools.allow` 与 `HER_TOOLS` 取并集，不要用它去减工具；收窄只走 `lib/restrict.js` 那一套。

**允许做「起桥」向导**（2026-11-02）：设置页可以填桥的可执行文件路径、由用户点一下 `spawn` 起来（`detached` + `unref`，只 spawn 用户填的那一个文件），也可以做 TCP 连通性探测。**不许**内置任何 QQ 协议、登录、消息解析——那是桥的事，升级也该跟着桥走。

`test/beliefs.test.mjs` 有一条「白名单里额外放行的工具要念给她听」盯着这段，改之前先跑它。

**其余平台同理**：Chatbox、Monica、AstrBot 这些客户端/框架也走「社区桥 + 白名单」这条路——不要把它们的协议塞进本插件，先找能桥过去的项目，再把工具名填进 `config.tools.allow`。不知道用什么项目、工具叫什么，就让她自己去查（前提是宿主放行了她能用的搜索/阅读工具）。

---

## 8. 两条成长通道不许合并（2026-11-02，合并版新增）

事件的 `influence` 字段决定这条经历算「她是谁」还是「她怎么处世」，**写入时定格，永不重算**。

- `constitution`（默认，没写就是它）：进 `beliefs`，能改阶段、能改称呼、能和她自己打架。
- `social`：只在 `meta social-open:` 之后才被读，进 `model.influence.social`，**不进** `beliefs`，
  不改阶段、不改称呼、不参与冲突检测。
- `none`：流水层，完全不参与派生。

守它的测试是 `test/channels.test.mjs`，其中两条是性质断言，不是行为断言：

- 「未开闸时喂 1000 条 social 事件，`deriveSelf` 的输出逐字节不变」；
- 「开闸后 social 事件也不出现在 `beliefs` 里」。

**不许**把 `social` 并进 `beliefs` 再用权重排序——那等于让群友最终仍能改写她，
只是慢一点。物理分开是这条产品的底线。

另外：这五个字段只收系统侧（`source !== 'tool'`）。她如果能自己打 `influence:'constitution'`，
就等于给自己批了通行证——和 `flags` 同一个道理。

---

## 9. 渠道层只负责「把话送到」，不负责「她是谁」（2026-11-02，合并版新增）

`lib/channels/*` 是**桥**，不是第二个大脑。它决定一条消息能不能送到、要不要回；
它**不许**决定她怎么说、更不许给她打分。

硬边界：

- **渠道配置里不许出现人格键**。`config.channels.<name>` 只允许 `enabled / wsUrl / accessToken /
 replyInGroup / groups / mentionOnly / browserPath / bridgePath / ownerId / intervalMs /
 accountOf / bond / closeIds` 这些「在哪、开不开、多久一次、号是家门还是出门号、这场近不近」。
 `accountOf` 只收 `home` / `outing`，`bond` 只收 `close` / `open`，`closeIds` 是可选近人的号。
 这三格是场合，不是性格：近人的话仍是 social，只有对上重要的人（`ownerId`）才进 constitution。
 加一个 `persona` 或 `tone` 键就是绕开第 2 节。
- **进站必过 `guard.sanitizeForeign`，出站必过 `screenOutgoing` + `looksLikePrivateLeak`**。
  适配器自己不做判断：`send()` 只负责发，判断在上层 `router.js`。
- **可见性按会话判**：群聊 `visibility:'public'`，私聊 `visibility:'private'`。私聊事件只对该
  `person` 可见，连主人都看不到原文——这是「不看别人私聊」的代码化。
- **`heard` 只能由 system 写**（不在 `HER_TYPES` 里），`origin:'guest'`、`influence:'social'`；
  只有主人私聊来的话才配 `origin:'owner'`、`influence:'constitution'`。
- **群里默认只在她被 @ 时开口**（2026-11-03，用户 m06663）：192 人的群里主人一说话她就回，太吵。
  `mentionOnly`（默认 `true`）关着的时候不看她有没有被点名；开着的时候群消息必须带
  `mentionedSelf: true` 才轮到后面几道判断。适配器负责认 @（QQ 走 message 段的 `at`，也认 CQ 码），
  gate 负责用它，router 只透传。
- **群白名单挡的是「长」，不只是「说」**：名单外（`group-not-allowed`）的群只留一行
  `journal.json` 流水，**不写 `heard`**——没听见的事不能长到她身上，也不能出现在「她认得谁」里。
  这条与界面文案「名单外的群她连听都不听」是同一句话，改一边就得改另一边。
- **渠道全关时不建文件、不连网**：`startChannels` 必须在 `createPeople`/`createJournal` 之前短路。
  这条有测试（`test/channels*.test.mjs`），别为了「统一初始化」把它挪走。
- **适配器永不抛**：`start/stop/send/status` 一律 `{ ok, why }`；凭据不进 `status()`、不进日志。
- **协议不进主包**：主包只有 QQ 的 OneBot 桥、B 站私信，和微信官方 ClawBot（iLink，HTTPS
  长轮询、零依赖、不需要浏览器）；抖音这类需要真浏览器的，放 `packages/dsh-fish-river-douyin/`，
  由 `lib/channels/sub.js` 懒加载——**代码分开，但随仓库一起分发**
  （2026-11-03 起：先找已安装的 `dsh-fish-river-douyin`，找不到就用仓库里那一份；只从 GitHub 装也能用抖音）。
  可选性由「渠道开不开」+「模块懒加载」体现：不开就不 `import`、不拉浏览器、不建 `douyin-profile`。
  「协议不进主包」挡的是**逆向个人号协议 / 需要桥或浏览器的实现**，不是挡官方 HTTPS 接口。
- **代发是主人的话，不是她的话**（2026-11-02）：`POST /channels/send` 只做三件事——发出去、
  写一行 `role:'owner'` 的流水、返回结果。**不问她、不过 gate、不过出站筛、不写事件流**。
  她的记忆里多出一句她没说过的话，比少回一条严重得多。
- **登录态是主人的，不是她的**（2026-11-02，扫码登录）：`/bili/qr` 拿到的 cookie 只写
  `owner.json`（0600），不进日志、不进 `status()`、不回显；二维码只活在内存里，服务端不留 key。
  适配器拿到的是「能发消息」这个能力，不是凭据本身。微信 ClawBot 同理（2026-11-04）：
  扫码拿到的 token 只写 `<root>/weixin.json`（0600），`/weixin/qr` 的读接口只回账号摘要，
  「退出登录」删文件而不是忽略。

---
## 10. 社会层开闸只能她自己按（2026-11-02）

- **能不能开**：`lib/socialgate.js` 的四条闸（阶段 ≥3、立场 ≥6、30 天没整条推翻、活 ≥14 天且稳定度在 0.02–0.35）。**只从事件流算，不落盘、不可配置。**
- **开不开**：`social_open` 工具（`lib/social.js`），她调用才写 `social-open:<ISO>` 的 meta。**没有任何 HTTP 路由或配置项能替她开**——加了就等于给了主人一次「让她变成另一种人」的权力。
- **差着的时候**：身份文档一个字都不写（`lib/selfdoc.js` 的 `socialSection` 返回空串）；调用工具也只回一句「还差什么」，绝不写事件。
- **开过之后**：`lib/derive.js` 才把 `influence:'social'` 的事件放进 `influence.social`（上限 30%），且永远不进 `beliefs`。
- **开过之后必须真的读到**：身份文档「我在外面学到的」（`lib/selfdoc.js` 的 `socialLines`）与渠道提示词「在外面见过的做法」（`lib/channels/router.js` 的 `buildPrompt`）各一处。只派生不注入，等于没开。

---

## 11. 世界书是知识，不是人格（2026-11-02，合并版新增）

`worldbook.json` 里的是**事实**——她住哪、公司在几楼、你们养过什么猫。它可以导入、可以删，
但**永远不许**变成「她是什么样的人」。

- **只进提示词的「你知道的事」一节**（`lib/worldbook.js` 的 `knowledgeBlock`），按关键词取，
  一次最多 5 条、共 1200 字。两处都写成事实清单：渠道回复的「你知道的事」（按关键词取，≤5 条）与身份文档的「我知道的事」（≤24 条、每条 ≤200 字，用户 m01879 要求 DSH 里也知道）。写成「我是一个…」的那一刻才算越界。
- **不改阶段、不进 `beliefs`、不算事件**：查一条设定不是一段经历。
- **匹配靠关键词，不靠模型**：她为什么记得这条，要能一句话解释。
- **面板里没有编辑框**：能导入、能清空；「她语气温柔」这种句子没有入口。

## 12. 设置页的页签是「她的一天」，不是「配置分类」（2026-11-02，用户 m02861）

- **「社会」页只读**：四道闸、学到的处世办法都可以看，但**没有**「替我开」的按钮——
  开闸的唯一入口是 `social_open` 工具（§10）。页面上出现任何写 `social-open:` 的路径都算违规。
- **「出门」不占页签**：它是「上网」之后的一段行动，渲染在 `showTab('bili')` 里（`h('div', null, biliPage, outingPage)`）。
  再有人要加页签前先问：这件事是不是「她的一段时间」？是就并进去。
- **同一件事只留一个入口**：B 站登录只在渠道页（扫码为主，贴 cookie 收进 `<details>`）。
  「上网」页里那一段只留一句指路 + 一个 `setTab('channels')`。
- **设置项必须能显式保存**：`commitInput` 现在有「保存」按钮、回车也提交——
  只有 `onBlur` 时，填完直接重启就会丢（用户 m02861 亲历）。

---

## 13. 出门/请神的隔离带：能看，不能长（2026-11-02，用户 m03227）

出门（`lib/outing.js`）与请神（`lib/possess.js`）保留，但**它们碰过的一切都不许变成她**。
用户的原话是「保证让这个功能不影响到人格」，落成两条，缺一条都不算数：

- **写入时盖章**：`lib/store.js` 的 `appendEvent` 是唯一写入口。事件的 `sessionId` 出现在
  `outings.json` / `possessions.json` 里时，一律定格成 `influence:'none'`。
  **必须放在 `validateEvent` 之后**——`channelFields` 对 `source:'tool'` 会整块丢掉这几个字段，
  而她在外面写的恰恰多是 `growth_commit`。
- **读取时消失**：`deriveSelf` 入口 `filter(e => e.influence !== 'none')`；
  `evaluateSocialGate` 同样先过滤（在外面按的 `social_open` 不算数）。

因此：外面说的话、写下的成长、按过的按钮，照样落盘、观测台和导出都看得到，
但**不参与** beliefs / 阶段 / 立场 / 质量分 / 疤 / 四道闸。

**不许**改成「按时间窗过滤」或「按她当时在不在外面过滤」——台账是既成事实，一趟结束之后照样要隔离；
按会话 id 认，比按瞬时状态可靠。守它的是 `test/isolation.test.mjs`（5 条）。

---

## 14. 「自己看」和「社会层」是两条线（2026-11-02，用户 m03490）

人格最早只该从**她自己看见的东西**和**她和主人的对话**里长出来；陌生人要等她开闸之后才算数。

- **自己看**：B 站刷站（`browse.*`）、抖音推荐页（`browse.douyin.*`）、DSH 会话、主人私聊。
  这些是 `constitution` 或环境素材，什么时候都在。
- **社会层**：群聊、评论区里的别人（`voice` 事件）、陌生人私信。开闸前**不参与派生**，
  开闸后也只进 `influence.social`，永不进 `beliefs`（§8）。
- **刷抖音与刷 B 站同地位**：两个配额各算各的（`douyinCountToday` / B 站自己的 `usedToday`），
  互不挤占；`lookBeforeWake` 必须把两路结果合起来交给同一次唤醒，不许只留一路。
- **素材不是记忆**：`dy-browse:` / `video` 这类只写「此刻推到你面前的」，她的感想才走 `utterance`。
- 子包 `dsh-fish-river-douyin` 没装时，刷抖音静默跳过（`loadDouyin` 返回 `null`），不许报错、不许建目录。

## 15. ffmpeg 是运行时资产，不是依赖，也不进 git（2026-11-02，用户 m03816）

「看画面」要抽帧，抽帧要 ffmpeg。规矩：

- **查找顺序固定**：`DSH_FISH_FFMPEG`（显式指定时只认这一条，不回落）→ 自带的 `bin/<平台>-<架构>/ffmpeg.exe`
  （`bundledFfmpegPath()`）→ PATH。三条都试完才算「没有 ffmpeg」。
- **二进制不进 git**：`ffmpeg.exe` 正好 100 MB，卡在 GitHub 单文件上限上；`bin/` 在 `.gitignore` 里，
  但进 npm 包（`files` 含 `bin`）。谁clone 下来谁跑 `node tools/setup-ffmpeg.mjs`。
- **不许为了让它跑起来引第三方解压库**：`tools/setup-ffmpeg.mjs` 用系统自带的 `Expand-Archive` / `unzip`。
- 缺 ffmpeg 时**必须降级而不是失败**：日志写一行 `看画面：抽帧失败 <bvid> …`，其余照常。
  测试要能造出「没有 ffmpeg」（同时清 `PATH` 并把 `DSH_FISH_FFMPEG` 指到不存在的路径），
  否则本机装了自带那份之后这条覆盖会假绿。

---
## 提 PR / 提交前自检

- [ ] 三个依赖字段还是 `{}`
- [ ] 没有新增人格设置入口
- [ ] 新输入口都过了 `guard.js`
- [ ] `node --test` 1510 全绿
- [ ] 界面文案没有「他」「四道门」「三道门」「好感度」
- [ ] 改了 `EVENT_SCHEMA_VERSION` 的话，`CHANGELOG.md` 里写了迁移说明

---

## 16. 抖音的私信只能从 WebSocket 帧里读

网页版的 DOM 里没有消息正文：点开会话之后 `im-dialog` 的 `innerText` 只有会话列表行和
「我们已互相关注」这类系统提示，消息气泡节点的 `innerText` 是空的（虚拟化 + 画布）。

真机抓到的事实：私信走 `wss://frontier-im.douyin.com/ws/v2`，帧是 protobuf，但**字符串是裸 UTF-8**，
一帧里能直接读出 `小满` · `私信了你` · `这条是测试`。所以 `parseDmFrame` 只做「base64 解开 + 按
`私信了你` 这个标记切前后」，不写完整 proto 解码。

三条不许改的前提：

- 不许把收消息改回读 DOM —— 那条路已证明拿不到正文；
- 会话列表与发送仍然走 DOM/真实鼠标事件（`Input.dispatchMouseEvent`，合成 `click()` 抖音不认）；
- 登录态必须留在 `<root>/douyin-profile`，子包默认的 `os.tmpdir()` 每轮都换，扫码一次就丢。

已知收不到的：表情包、图片、撤回、群消息（这些帧的形状不是「X 私信了你 Y」）。

---

## 17. 小模型下面，文档里能被引用的句子都会被背出来

2026-11-03 用 Qwen3-14B 接进 DSH 实测：问它「介绍下你的设定」，它把身份文档逐条念了出来——
工具名、规则原文、连「我还不太会用撒娇」都念。**加禁令是负优化**：禁令本身也成了可背诵的句子
（加了「我不会列举条目」之后，它先把这句念了出来）。

所以：

- 身份文档里不写「我不能……」这类可被当作答案引用的第一人称禁令；要约束行为，就写进工具说明、
  代码逻辑，或者放到末尾的短例子里（例子只给一两句，别给清单）。
- 任何字面标记（叫醒词之类）都不要在文档里写出原文——写出什么，就会被复述什么。
- **工具说明同理，清单就是模板。** `write_diary` 原来写着「写今天发生了什么、你注意到什么、你怎么想的」，
  14B 把这三句拆开重组成「今天发生了很多事情，我注意到一些细节」交回来；删掉清单之后复读消失。
  写「不要写成汇报」也会被当成一句可引用的内容（「不是汇报」出现在正文里）。
- `narration` 没带 `refs` 一律降级成 `utterance`，由 `test/capture.test.mjs` 守住。

---

## 18. 链接能打开才叫看过，打不开就说打不开（2026-11-03）

- 任何渠道的文本里出现抖音链接，路由层要先替她去解析（`lib/dylink.js`）：
  短链只跟一次跳转，详情走她自己那个浏览器的页面请求（cookie 才带得上）。
- **解析成功**：提示词里写事实（文案、作者、时长、互动数、有没有拉到画面），
  并记一条 `meta looked:dy_<id>`。
- **解析失败**：写「这边没打开它，别猜里面是什么」，且**不记** `looked:`。
  没看成的不能说看过——这条由 `test/channel-router.test.mjs` 两个用例钉住。
- 私信里的「分享卡片」只有「分享图文」四个字，没有 id：那条路不算看过，
  不许拿它补内容。要让她看见，得是链接。
- 从别的渠道（群里、评论区）来的链接算社会层：开闸前不进她的处世方式。
