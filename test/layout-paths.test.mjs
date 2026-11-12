/**
 * layout-paths.test.mjs —— 目录整理后的路径守卫（2026-11-12）
 *
 * 这组只看“路径还在不在、相对引用有没有指回上层”，不测行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

test('平台目录按平台分开，宿主门面不在 platforms 下', () => {
  for (const rel of [
    'lib/platforms/bili/look.js',
    'lib/platforms/zhihu/zhihuLook.js',
    'lib/platforms/tieba/tiebaLook.js',
    'lib/platforms/douyin/dylink.js',
    'lib/platforms/common/voices.js',
    'lib/host/platformHost.js',
  ]) assert.equal(existsSync(join(ROOT, rel)), true, rel)
  assert.equal(existsSync(join(ROOT, 'lib/platforms/platformHost.js')), false)
})

test('仓库里可选子包的 fallback 路径仍然存在', () => {
  const zh = read('lib/platforms/zhihu/zhihuLoad.js')
  assert.match(zh, /\.\.\/\.\.\/\.\.\/packages\/dsh-fish-river-zhihu\/index\.js/)
  assert.equal(existsSync(join(ROOT, 'packages/dsh-fish-river-zhihu/index.js')), true)
  const dy = read('lib/channels/sub.js')
  assert.match(dy, /\.\.\/\.\.\/packages\/dsh-fish-river-douyin\/index\.js/)
  assert.equal(existsSync(join(ROOT, 'packages/dsh-fish-river-douyin/index.js')), true)
})

test('静态资源路径在移动后仍然指向包里的 media', () => {
  const ob = read('lib/ui/observe.js')
  assert.match(ob, /\.\.\/\.\.\/media\//)
  assert.equal(existsSync(join(ROOT, 'media/principle-loop.svg')), true)
})

test('core 不再反向 import 上层领域', () => {
  for (const rel of ['lib/core/settings.js', 'lib/core/store.js', 'lib/core/schema.js', 'lib/core/owner.js']) {
    const src = read(rel)
    assert.doesNotMatch(src, /from\s+['"]\.\.\/(platforms|channels|life|mind|house|talk|ops|host)\//, rel)
    assert.doesNotMatch(src, /import\(\s*['"]\.\.\/(platforms|channels|life|mind|house|talk|ops|host)\//, rel)
  }
})
