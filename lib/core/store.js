/**
 * store.js —— 状态库读写（只追加，不改写）
 *
 * 目录结构（~/.dsh-fish-river）：
 *   events.jsonl   事件流，一行一条，永远只追加
 *   state.json     派生快照（可随时由 events.jsonl 重算删除，不是真相源）
 *   owner.json     主人身份（mid / 昵称 / cookie），0644→0600
 *   diary/YYYY-MM-DD.md   她的日记（可见性由设置决定）
 *   out/YYYY-MM-DD.md     刷站报告
 *
 * 铁律：state.json 是**派生品**。任何「改 state 就当改了她」的写法都不允许。
 *       rebuild() 必须能从 events.jsonl 完全复原，这条由 test 守住。
 *
 * API 全部 async：原子写用「写 tmp → rename」，避免断电留半行。
 */

import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { validateEvent, EVENT_SCHEMA_VERSION } from './schema.js'
import { defaultRoot, readLocationSync } from './locate.js'
import { logLine } from './log.js'
import { assertWritable } from '../ops/maintenance.js'

/**
 * 状态库的根目录。
 *
 * 2026-10-28（用户 m06510）：加一层「迁移指针」——用户可以把整个数据目录搬到
 * D 盘 / E 盘，位置记在 `~/.dsh-fish-river-location.json`（在数据目录**之外**，
 * 否则搬家时门牌号会被一起搬走）。这里必须保持**同步**：它被
 * `paths(root = rootDir())` 这种默认参数调用，几十处，不可能全改成 await。
 *
 * 顺序：环境变量 → 指针文件 → `~/.dsh-fish-river`。指针坏了等于没迁过，不抛。
 */
export function rootDir() {
  return process.env.DSH_FISH_HOME || readLocationSync() || defaultRoot()
}

export function paths(root = rootDir()) {
  return {
    root,
    events: join(root, 'events.jsonl'),
    state: join(root, 'state.json'),
    owner: join(root, 'owner.json'),
    config: join(root, 'config.json'),
    diaryDir: join(root, 'diary'),
    outDir: join(root, 'out'),
    // 她自己的房间：会话 cwd 指向这里，**不是 root**。
    // 理由（原实现与 B 文档矛盾，已修）：cwd=root 等于让她站在自己的
    // events.jsonl / config.json 旁边，`cat` 一下就读到全部历史与参数，
    // 而 N3「读自己的参数」本该是做不到的。给她一个空目录，状态库是它的**父目录**，
    // 仍需主动 `cd ..` 才能碰到——把「顺手看见」降级成「刻意去找」。
    //
    // 2026-10-23 P3 修订：这个目录**就是** `home/`，不再单独开 `her/`。
    // 原因：她的身份文件原本是 `home/AGENTS.md`（宿主每轮重读 cwd 链上的它），
    // 而 P3 之后她的会话 = home 工作区里那个「跟她说话」的会话，cwd 由宿主定在 `home/`。
    // 曾经 `her/` 与 `home/` 并存：主路径没问题（会话已存在，cwd 参数被忽略），
    // 但**降级路径**（宿主没有 workspaceRegistry，退回每天一个 `fish-talk-*` 会话）
    // 会把 cwd 定在 `her/` —— 那里没有身份文件，她一降级就**没有身份**。
    // 2026-10-25 起身份改走 systemPrompt.section（`home/她的身份.md` 只是落盘副本），
    // 不再依赖 cwd 链，但两个目录仍然合一——她住在自己的房间里这件事没变。
    // 两个目录合一，降级路径也落在有身份文件的房间里。
    herDir: join(root, 'home'),
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * 建好（并返回）她自己的工作目录。会话 cwd 用它，不用 root。
 * 幂等：目录已存在就直接返回。
 */
export async function ensureHer(root = rootDir()) {
  const dir = paths(root).herDir
  await ensureDir(dir)
  return dir
}

/**
 * 原子写：写 tmp 再 rename（同盘 rename 是原子的）。
 *
 * Windows 上 rename 覆盖目标时，若目标正被另一个句柄读（宿主读 home.json、
 * 杀软扫目录、另一个进程 readJson），会偶发 EPERM/EACCES/EBUSY —— 不是权限
 * 问题，隔几十毫秒重试就好。以前这里不重试，失败被上层 catch 吞掉，表现为
 * home.json 偶发丢写（turns 停住、wokeFor 不见了），只在机器忙时才复现。
 */
const RENAME_WAIT = [0, 20, 60, 120, 240]
const RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

export async function writeAtomic(file, text, mode, { allowDuringMaintenance = false } = {}) {
  if (!allowDuringMaintenance) assertWritable()
  await ensureDir(dirname(file))
  // 同进程、同毫秒的两个并发写会算出同一个 tmp 名（Date.now 只到毫秒），
  // 一个 rename 掉之后另一个写同一份 tmp，轻则覆盖、重则 ENOENT。
  // 加随机后缀：这个碰撞在 /config 双标签页、tick 与 noteWeixin 同拍写入时是真会发生的。
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  if (mode) await fs.chmod(tmp, mode).catch(() => {})
  for (let i = 0; i < RENAME_WAIT.length; i++) {
    if (RENAME_WAIT[i]) await new Promise(r => setTimeout(r, RENAME_WAIT[i]))
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      const last = i === RENAME_WAIT.length - 1
      if (!RENAME_RETRY.has(err?.code) || last) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
    }
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    // 坏文件不静默吞：留证据，返回 fallback 让上层能用
    if (err instanceof SyntaxError) {
      await fs.rename(file, `${file}.corrupt.${Date.now()}`).catch(() => {})
      return fallback
    }
    throw err
  }
}

/**
 * 事件流缓存：按文件 stat 失效。
 *
 * 为什么值得加：`readEvents` 在 tick、每条渠道消息、面板每个只读接口里都被调用，
 * 而事件流只追加。20k 条时一次全量 JSON.parse 约 55ms，一次面板打开能叠十几次。
 *
 * 两条安全边界：
 *   - 返回的数组是浅拷贝，调用方 push/sort 不会污染缓存；事件对象本身只读。
 *   - `appendEvent` 写成功后自己更新缓存并重 stat；外部进程改写/恢复会让
 *     stat 对不上，下一次读自动全量重读。缓存永远只是快照，不是第二份真相。
 */
const eventCache = new Map()
const EVENT_CACHE_MAX = 8

function cacheEventFile(file, entry) {
  eventCache.delete(file)
  eventCache.set(file, entry)
  while (eventCache.size > EVENT_CACHE_MAX) {
    eventCache.delete(eventCache.keys().next().value)
  }
}

function sameStat(entry, st) {
  return Boolean(entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs && entry.ctimeMs === st.ctimeMs)
}

/** 读全量事件流。坏行跳过但计数（不阻塞启动）。 */
export async function readEvents(root = rootDir()) {
  const p = paths(root).events
  let st = null
  try {
    st = await fs.stat(p)
  } catch (err) {
    if (err.code === 'ENOENT') {
      eventCache.delete(p)
      return { events: [], skipped: 0, legacy: 0 }
    }
    throw err
  }
  const hit = eventCache.get(p)
  if (sameStat(hit, st)) {
    return { events: hit.events.slice(), skipped: hit.skipped, legacy: hit.legacy }
  }
  let raw = ''
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      eventCache.delete(p)
      return { events: [], skipped: 0, legacy: 0 }
    }
    throw err
  }
  const events = []
  let skipped = 0
  let legacy = 0
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const ev = JSON.parse(s)
      if (ev && typeof ev === 'object' && ev.id) {
        // v 字段是 2026-10-25 才加的：更早写的事件没有它，语义就是 v1。
        // 补上再进内存，下游就不用到处写 `ev.v ?? 1`。
        if (!Number.isInteger(ev.v)) {
          ev.v = EVENT_SCHEMA_VERSION
          legacy++
        }
        events.push(ev)
      } else skipped++
    } catch {
      skipped++
    }
  }
  // legacy：这批事件里有多少条是「加版本号之前」写的。备份与自检会显示它。
  cacheEventFile(p, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, events, skipped, legacy })
  return { events: events.slice(), skipped, legacy }
}

/**
 * 「外面那一趟」的会话 id 集合（2026-11-02，用户 m03227）。
 *
 * 用户拍板：出门/请神**留着**，但它们碰过的东西**一样都不许长到她身上**。
 * 这里是那道隔离带的读侧——`outings.json` 与 `possessions.json` 里记过的会话 id。
 *
 * 为什么不在 derive 里按时间窗过滤：台账是既成事实，一趟结束之后照样要隔离；
 * 按会话 id 认，比按「她当时在不在外面」这种瞬时状态可靠。
 */
async function outsideSessions(root) {
  const read = async (file, key) => {
    try {
      const raw = await readJson(join(root, file), null)
      const list = Array.isArray(raw?.[key]) ? raw[key] : []
      return list.map((x) => String(x?.sessionId ?? '')).filter(Boolean)
    } catch {
      return []
    }
  }
  const [outs, poss] = await Promise.all([read('outings.json', 'outings'), read('possessions.json', 'possessions')])
  return new Set([...outs, ...poss])
}

/**
 * 追加一条事件。唯一写入口。
 * @param {object} raw 未校验的事件
 * @param {object} ctx { day, stage, source }
 */
export async function appendEvent(raw, ctx = {}, root = rootDir()) {
  assertWritable()
  // 2026-10-27（0.5.8）：把「已有事件的 id 集合」交给校验器，让 refs 能真的查到。
  //
  // 只在写 revise / narration 时才去读一遍全量事件流——这两类才带 refs 义务，
  // 别的写（meta、diary、voice…）占绝大多数，不该为它们多读一次盘。
  // 读失败当「不知道有哪些 id」处理（knownIds = null），退化成 0.5.7 的只查非空，
  // 不能因为查不了就拒收她的正常写入。
  let knownIds = null
  const type = String(raw?.type ?? '')
  if (type === 'revise' || type === 'narration') {
    try {
      const { events } = await readEvents(root)
      knownIds = new Set(events.map((e) => e.id).filter(Boolean))
    } catch {
      knownIds = null
    }
  }
  let ev
  try {
    ev = validateEvent(raw, { ...ctx, knownIds })
  } catch (err) {
    // 2026-10-29（用户 m02241）：校验拒收以前也不落盘日志。
    // `capture.js` 只把 err.message 变成给她看的 note（「你不可以写 meta 类事件…」），
    // 现场无痕——她说了写不进去，日志里却什么都没有。
    logLine('warn', [
      '事件被校验拒收：',
      `type=${type || '?'}`,
      `source=${String(ctx?.source ?? '?')}`,
      String(err?.message ?? err).slice(0, 300),
    ], root)
    throw err
  }
  // 隔离带（2026-11-02，用户 m03227）：外面那一趟里写下的一切，一律定格成 influence:'none'。
  //
  // 位置必须在 validateEvent 之后：channelFields 对 source==='tool' 会整块丢掉这几个字段，
  // 而她在外面写的恰恰多是成长事件（growth_commit），放在校验前会被抹掉。
  // 这一步只盖章、不拒绝——她的经历照写，只是不再参与派生（deriveSelf 入口会丢掉 none）。
  const sid = String(ev?.sessionId ?? '')
  if (sid) {
    try {
      const outside = await outsideSessions(root)
      if (outside.has(sid)) {
        ev.influence = 'none'
        logLine('info', [`外面那一趟（${sid.slice(0, 28)}）写的事件不进人格：type=${type}`], root)
      }
    } catch {
      // 台账读不到就当没出门：宁可漏一次标记，也不能因为台账坏了拒收她的正常写入。
    }
  }
  const p = paths(root)
  await ensureDir(p.root)
  const line = JSON.stringify(ev) + '\n'
  const lineBytes = Buffer.byteLength(line)
  try {
    await fs.appendFile(p.events, line, 'utf8')
    // 写成功之后把缓存往前推一格：下一条消息读到的就是这份，不必再 parse 全量。
    // stat 一次拿新的 mtime/ctime/size；拿不到就让缓存失效，下一次读全量。
    const hit = eventCache.get(p.events)
    if (hit) {
      try {
        const st = await fs.stat(p.events)
        // 缓存里的数组是内部持有、只给 readEvents 做浅拷贝的；push 不扩容到调用方。
        // 如果 stat 的这段时间里有另一个读已经把缓存换新了，就别拿旧数组盖回去。
        // 如果文件比「旧缓存 + 这一行」更大/更小，说明中间有外部写入/恢复——
        // 这份缓存已经不完整，只能丢掉重读，不能只 push 自己这一条。
        if (eventCache.get(p.events) === hit && st.size === hit.size + lineBytes) {
          hit.events.push(ev)
          cacheEventFile(p.events, {
            size: st.size,
            mtimeMs: st.mtimeMs,
            ctimeMs: st.ctimeMs,
            events: hit.events,
            skipped: hit.skipped,
            legacy: hit.legacy,
          })
        } else {
          eventCache.delete(p.events)
        }
      } catch {
        eventCache.delete(p.events)
      }
    }
  } catch (err) {
    // 2026-10-29（用户 m02241）：写失败以前是**完全静默**的——磁盘满、权限、文件被独占，
    // 调用方普遍写成 `.catch(() => {})`，于是「她说了但没落盘」这种最典型的故障
    // 在日志里一个字都不留。0.7.4 那三个 appendEvent 参数错位 bug 能潜伏整个 0.6.x，
    // 就是因为这一层没有声音。这里补一行，错误继续往上抛（调用方的语义不变）。
    logLine('error', [
      '事件没写进去：',
      `type=${type || '?'}`,
      `source=${String(ctx?.source ?? '?')}`,
      `${err?.code ?? ''} ${String(err?.message ?? err).slice(0, 300)}`,
    ], root)
    throw err
  }
  return ev
}

export async function writeState(state, root = rootDir()) {
  await writeAtomic(paths(root).state, JSON.stringify(state, null, 2))
}

/**
 * state.json 的真身：**从 events.jsonl 重算出来的派生快照**。
 *
 * 这个函数以前不存在，只有第 12 行注释声称"rebuild() 这条由 test 守住"，
 * 属于注释撒谎。补上它，并让 test/store.test.mjs 真的去做
 * 「删掉 state.json → rebuild → 内容与之前一致」的往返验证，
 * 才配得上「真相源只有事件流」这句话。
 *
 * @returns {Promise<object>} 写入的 state
 */
export async function rebuild(root = rootDir(), opts = {}) {
  const { events } = await readEvents(root)
  // 惰性 import：避免 store ←→ derive 的静态循环（derive 不依赖 store，但这样更稳）
  const { deriveSelf } = await import('../mind/derive.js')
  const model = deriveSelf(events, opts)
  const state = {
    builtAt: new Date().toISOString(),
    events: events.length,
    day: model.day,
    stage: model.stage,
    stageName: model.stageName,
    stageForced: model.stageForced,
    name: model.name,
    beliefCount: model.beliefCount,
    absenceDays: model.absenceDays,
    // needs 落盘只是为了排查，观测台与提示词都不会返回它（N2）
    needs: model.needs,
  }
  await writeState(state, root)
  return state
}

/** 读派生快照。不存在/坏掉都返回 null（调用方应改用 rebuild）。 */
export async function readState(root = rootDir()) {
  return readJson(paths(root).state, null)
}

/** 主人身份：0600 权限（cookie 在里面） */
export async function readOwner(root = rootDir()) {
  return readJson(paths(root).owner, null)
}

export async function writeOwner(owner, root = rootDir()) {
  await writeAtomic(paths(root).owner, JSON.stringify(owner, null, 2), 0o600)
}

export async function readConfig(root = rootDir()) {
  return readJson(paths(root).config, null)
}

export async function writeConfig(cfg, root = rootDir()) {
  // 0600：config.json 里有渠道的 accessToken / 桥 token，和 owner.json 同级敏感。
  await writeAtomic(paths(root).config, JSON.stringify(cfg, null, 2), 0o600)
}

/**
 * 日记 / 报告落盘。
 *
 * issue #7（2026-10-28）：日记按日期命名，同一天写第二次原来是**整篇覆盖**，
 * 前一版永久丢失，而界面只显示「有日记」，主人在界面上完全无感。当时的修法是
 * 覆盖前把旧稿归档到 `diary/archive/`——但归档版界面上看不到，用户仍然觉得
 * 「被盖掉了」（0.6.28 的反馈，用户 m01952）。
 *
 * 2026-10-29 起改成**同日追加**（方案 B）：
 *   - 同一天再写一次，不再覆盖，而是在当天文件末尾接一段，中间一行 `---` 隔开；
 *     旧稿原样留在文件里，不用再去 archive 里找；
 *   - 内容与最后一版完全一样时不追加（重写同一篇仍幂等）；
 *   - 「一天一篇」的语义不变：客户端按日期分页，listDiary 只认顶层
 *     `YYYY-MM-DD.md`，**跨天**才出现翻页键；
 *   - 老归档（archive/）不动也不清：那是 0.6.4–0.6.27 留下的历史。
 * 报告（out/）仍然整篇覆盖：它是派生品，随时能由事件流重算。
 */
export const DAILY_JOIN = '\n\n---\n\n'

export async function writeDaily(dirName, dateKey, text, root = rootDir()) {
  const dir = paths(root)[dirName]
  const file = join(dir, `${dateKey}.md`)
  if (dirName === 'diaryDir') {
    const prev = await readDaily(dirName, dateKey, root).catch(() => null)
    if (prev !== null) {
      const old = String(prev).replace(/\r\n/g, '\n').trimEnd()
      const body = String(text).replace(/\r\n/g, '\n').trim()
      if (old === body) return file
      await writeAtomic(file, `${old}${DAILY_JOIN}${body}\n`)
      return file
    }
  }
  await writeAtomic(file, text)
  return file
}

export async function readDaily(dirName, dateKey, root = rootDir()) {
  try {
    return await fs.readFile(join(paths(root)[dirName], `${dateKey}.md`), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** 列出已有的日记日期（新→旧） */
export async function listDiary(root = rootDir()) {
  try {
    const names = await fs.readdir(paths(root).diaryDir)
    return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10)).sort().reverse()
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}
