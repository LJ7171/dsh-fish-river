import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'

import { isInside, isInsideStrict } from '../lib/core/paths.js'

const base = resolve('/tmp/fish-paths-base')
const child = join(base, 'media', 'a.png')

test('isInside：自己、子路径算在内；上级/旁支/绝对路径不算', () => {
  assert.equal(isInside(base, base), true)
  assert.equal(isInside(base, child), true)
  assert.equal(isInside(join(base, 'media'), child), true)
  assert.equal(isInside(child, base), false)
  assert.equal(isInside(base, join(base, '..', 'x')), false)
  assert.equal(isInside(base, '/etc/passwd'), false)
  assert.equal(isInside('', child), false)
})

test('isInsideStrict：自己不算，必须真在下面', () => {
  assert.equal(isInsideStrict(base, base), false)
  assert.equal(isInsideStrict(base, child), true)
  assert.equal(isInsideStrict(base, join(base, '..')), false)
})
