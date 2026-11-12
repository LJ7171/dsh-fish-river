/**
 * zhihuConfig.js —— 知乎设置的默认值 / 归一 / 文案加载。
 *
 * 这是主包 core 自己的配置形状，留在 core 是为了让 core/settings 不必 import
 * platforms/zhihuLoad；子包仍然只提供 config.js 这份数据。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)

const CONFIG_SPECS = ['dsh-fish-river-zhihu/config.js', '../../packages/dsh-fish-river-zhihu/config.js']

function resolveSpec(spec) {
  try {
    return require.resolve(spec)
  } catch {
    return ''
  }
}

function loadFirst(specs, accept) {
  for (const spec of specs) {
    const file = resolveSpec(spec)
    if (!file || !existsSync(file)) continue
    try {
      const mod = require(file)
      if (accept(mod)) return mod
    } catch (error) {
      const code = String(error?.code ?? '')
      // Node 20 不能 require ESM：当作没装，主包照常跑，不能让设置归一炸掉。
      if (['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', 'ERR_UNKNOWN_FILE_EXTENSION'].includes(code)) continue
      throw error
    }
  }
  return null
}

let configMod

/** 知乎设置的默认值 / 归一 / 文案。子包缺失时给一份能让主包继续跑的兜底。 */
export function zhihuConfigApi() {
  if (configMod) return configMod
  const found = loadFirst(CONFIG_SPECS, (mod) => typeof mod?.normalizeZhihu === 'function' && mod?.ZHIHU_DEFAULTS)
  configMod = found ?? {
    ZHIHU_DEFAULTS: {
      enabled: false,
      owner: 'owner',
      perDay: 4,
      hot: { enabled: true, topN: 8 },
      follow: { enabled: true, topN: 8 },
      history: { enabled: true, onlyToday: true, topN: 10 },
      recommend: { enabled: true, topN: 6 },
      comment: {
        enabled: false, perDay: 1, replyPerDay: 1, replyToReplies: true, scanEveryMin: 30, lastScanAt: '',
      },
      answer: { enabled: false, perDay: 1 },
      images: { enabled: true, max: 2 },
    },
    ZHIHU_COPY: {},
    ZHIHU_FIELDS: {},
    normalizeZhihu(raw) {
      const zh = raw && typeof raw === 'object' ? raw : {}
      return { ...this.ZHIHU_DEFAULTS, ...zh, enabled: zh.enabled === true }
    },
  }
  return configMod
}
