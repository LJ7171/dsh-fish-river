/**
 * 可选子包的加载器（2026-11-02）
 *
 * 「可选装」不靠开关，靠**装没装**：没装子包时 `import()` 抛
 * `ERR_MODULE_NOT_FOUND`，这里吞掉并返回 null，主包照常启动、整条渠道消失。
 * 这样用户不会因为少装一个包看到红色报错。
 *
 * 两个找法（2026-11-03 补第二个）：
 * 1. `dsh-fish-river-douyin` —— 单独 npm 装了，或 profile 里 link 过；
 * 2. `../../packages/dsh-fish-river-douyin/index.js` —— 从 GitHub / 压缩包整包下载时，
 *    子包就在仓库里。没有第二个的话，非 npm 安装的人会以为「抖音没做」。
 */

const CANDIDATES = [
  'dsh-fish-river-douyin',
  '../../packages/dsh-fish-river-douyin/index.js',
]

export async function createSubAdapter() {
  for (const spec of CANDIDATES) {
    try {
      const mod = await import(spec)
      const factory = mod?.create ?? mod?.default?.create ?? null
      if (typeof factory === 'function') return factory
    } catch (err) {
      // 只有「找不到」可以继续试下一个；语法错、导出错要让它显形，否则永远静默
      if (String(err?.code ?? '') === 'ERR_MODULE_NOT_FOUND') continue
      throw err
    }
  }
  return null
}

/** 用于日志与 `status()`：只报「哪份代码在用」，不报绝对路径。 */
export const SUB_CANDIDATES = CANDIDATES

export default { createSubAdapter, SUB_CANDIDATES }
