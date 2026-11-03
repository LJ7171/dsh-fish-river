/**
 * QQ 桥的「装没装 / 起没起」小工具（2026-11-02，合并版新增）。
 *
 * 为什么不内置桥：`AGENTS.md` 第 7 条——QQ 协议、登录、收发是另一个工程，
 * 塞进主包等于把「她是谁」和「怎么登 QQ」绑在一起，还会把封号风险和依赖一起带进来。
 * 这里只做三件不碰协议的事：
 *
 *   1. 看端口通不通（复用 observe.js 的 probeTcp，只做 TCP 握手）；
 *   2. 看用户填的桥程序在不在；
 *   3. 用户点了「启动桥」时，把那一个 exe 以 detached 方式拉起来，然后立刻不管它。
 *
 * 桥本身可以是任何支持 OneBot 11 正向 WebSocket 的东西（SnowLuma / NapCat / LLOneBot…），
 * 我们只认那一个端口，不认牌子。
 */

import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'

/**
 * 只做一次 TCP 握手：回答「端口后面有没有人」。不握手协议、不发消息。
 */
export function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false
    const sock = net.connect({ host, port })
    const finish = (r) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve(r)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish({ ok: true }))
    sock.once('timeout', () => finish({ ok: false, why: '超时' }))
    sock.once('error', (err) => finish({ ok: false, why: String(err?.code || err?.message || err) }))
  })
}

export const DEFAULT_WS = 'ws://127.0.0.1:3001'

/** 从 ws 地址里取出 host / port；非法地址返回 null。 */
export function parseWsUrl(raw) {
  try {
    const s = String(raw ?? '').trim()
    if (!s) return null
    const u = new URL(s)
    if (!/^wss?:$/.test(u.protocol)) return null
    const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80))
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { host: u.hostname, port, secure: u.protocol === 'wss:' }
  } catch {
    return null
  }
}

/**
 * 桥现在什么状态。永不抛。
 * @returns {Promise<{ok:boolean, listening:boolean, port:number|null, host:string, pathExists:boolean, note:string}>}
 */
export async function detectBridge({ wsUrl = DEFAULT_WS, bridgePath = '', timeoutMs = 1500 } = {}) {
  const at = parseWsUrl(String(wsUrl ?? '').trim() || DEFAULT_WS)
  const pathExists = Boolean(bridgePath) && fs.existsSync(String(bridgePath))
  if (!at) {
    return { ok: false, listening: false, port: null, host: '', pathExists, note: '这个地址不是合法的 ws:// 地址。' }
  }
  const r = await probeTcp(at.host, at.port, timeoutMs)
  return {
    ok: r.ok === true,
    listening: r.ok === true,
    port: at.port,
    host: at.host,
    pathExists,
    note: r.ok
      ? `${at.host}:${at.port} 通了，桥在跑。`
      : `${at.host}:${at.port} 连不上（${r.why}）。桥没起，或者端口不是这个。`,
  }
}

/**
 * 把桥拉起来。只认用户自己填的那一个程序路径——我们不猜安装位置、不下载、不更新。
 * @returns {Promise<{ok:boolean, note:string, pid?:number}>}
 */
export async function startBridge(bridgePath, { cwd = '', args = [] } = {}) {
  const p = String(bridgePath || '').trim()
  if (!p) return { ok: false, note: '还没填桥的程序路径。找到那个 exe（或 .cmd），把完整路径填进来。' }
  if (!fs.existsSync(p)) return { ok: false, note: '这个路径不存在。' }
  try {
    const child = spawn(p, Array.isArray(args) ? args : [], {
      cwd: cwd || undefined,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    // spawn 在 Windows 上对「路径存在但起不来」是异步报错的，这里等一拍再判。
    await new Promise((r) => setTimeout(r, 300))
    if (child.exitCode !== null && child.exitCode !== 0) {
      return { ok: false, note: `桥刚起就退了（退出码 ${child.exitCode}）。` }
    }
    return { ok: true, note: '已经把它拉起来了。等几秒再点「测一下通不通」。', pid: child.pid }
  } catch (err) {
    return { ok: false, note: `起不来：${String(err?.message ?? err).slice(0, 80)}` }
  }
}
