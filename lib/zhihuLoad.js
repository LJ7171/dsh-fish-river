/**
 * zhihuLoad.js —— 知乎子包怎么装进来。
 *
 * 顺序和原来一样：先已安装的 `dsh-fish-river-zhihu`，没有再用仓库里这一份。
 * 没装就返回 null，主包不因此启动失败。
 *
 * 设置归一只拿 `config.js`（不把整包 HTTP 在读配置时拉起来）。
 * 运行时入口走 `index.js`，和 config 同一条查找顺序。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)

const INDEX_SPECS = ['dsh-fish-river-zhihu', '../packages/dsh-fish-river-zhihu/index.js']
const CONFIG_SPECS = ['dsh-fish-river-zhihu/config.js', '../packages/dsh-fish-river-zhihu/config.js']

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

let indexMod
let indexLoaded = false

/** 同步拿到子包入口。没装返回 null。同一进程只解析一次。 */
export function loadZhihuSync() {
  if (indexLoaded) return indexMod
  indexLoaded = true
  indexMod = loadFirst(INDEX_SPECS, (mod) => mod && typeof mod.fetchHot === 'function')
  return indexMod
}

/**
 * 异步入口。传入 importer 时按原来的动态 import 顺序走（测试用来模拟「没装」）。
 * 不传就用同步加载的那一份，保证和 register 工具是同一个模块实例。
 */
export async function loadZhihuModule(importer) {
  if (typeof importer !== 'function') return loadZhihuSync()
  for (const spec of INDEX_SPECS) {
    try {
      const mod = await importer(spec)
      if (mod && typeof mod.fetchHot === 'function') return mod
    } catch (error) {
      if (String(error?.code ?? '') === 'ERR_MODULE_NOT_FOUND') continue
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

export default { loadZhihuSync, loadZhihuModule, zhihuConfigApi }
