import test from 'node:test'
import assert from 'node:assert/strict'

import { createSubAdapter, SUB_CANDIDATES } from '../lib/channels/subpackage.js'

test('抖音子包：仓库里那一份能被直接加载（不要求 npm 装过）', async () => {
  const factory = await createSubAdapter()
  assert.equal(typeof factory, 'function', '整包下载时应该能加载 packages/ 里的子包')
})

test('抖音子包：先找已安装的包，再退回仓库路径', () => {
  assert.equal(SUB_CANDIDATES[0], 'dsh-fish-river-douyin')
  assert.ok(SUB_CANDIDATES[1].includes('packages/dsh-fish-river-douyin/index.js'))
})
