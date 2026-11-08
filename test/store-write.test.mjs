/**
 * store-write.test.mjs —— 原子写在并发下的两个硬要求。
 *
 * 2026-11-08：临时文件名原来用 `${pid}.${Date.now()}`，同进程同毫秒的两个写会撞名。
 * 这里不追求「最后是谁赢」，只要求：最终文件是合法 JSON、没有 tmp 残留、
 * 配置文件的权限是 0600。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { paths, writeAtomic, writeConfig, readConfig } from '../lib/store.js'

test('writeAtomic：同一文件并发写不撞 tmp，也不留半截', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-atomic-'))
  const file = join(root, 'same.json')
  try {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => writeAtomic(file, JSON.stringify({ i }))),
    )
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    assert.ok(Number.isInteger(parsed.i), '最终文件必须是合法 JSON')
    const leftovers = (await readdir(root)).filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], `不该留下临时文件：${leftovers.join(', ')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeConfig：config.json 是 0600（里面有渠道 token）', async () => {
  if (process.platform === 'win32') return // Windows 的 chmod 语义不同，Linux/CI 上验
  const root = await mkdtemp(join(tmpdir(), 'fish-mode-'))
  try {
    await writeConfig({ channels: { qq: { accessToken: 's' } } }, root)
    const st = await stat(paths(root).config)
    assert.equal(st.mode & 0o777, 0o600, `实际权限 ${(st.mode & 0o777).toString(8)}`)
    assert.equal((await readConfig(root)).channels.qq.accessToken, 's')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
