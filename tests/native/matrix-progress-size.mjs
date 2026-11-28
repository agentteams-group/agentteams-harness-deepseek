import assert from 'node:assert/strict'
import { MatrixProgress } from '../../plugins/teamharness/adapters/deepseek-harness/matrix-progress.js'

const sent = []
const progress = new MatrixProgress({
  token: 'fixture-secret-token', room: '!fixture',
  api: async () => { throw Object.assign(new Error('unencrypted'), { status: 404, code: 'M_NOT_FOUND' }) },
  send: async content => { sent.push(content); return { event_id: '$original' } },
}, {}, 'fixture-run')
const value = { content: '文件正文😀'.repeat(20000), token: 'fixture-secret-token' }
const block = { type: 'tool_call', tool_name: 'write', tool_call_id: 'call-one', status: 'succeeded',
  arguments: progress.bounded(value), result: progress.bounded(value) }
await progress.send(block)
await progress.send(block, '$original')
assert.ok(block.arguments.truncated)
for (const content of sent) {
  const text = JSON.stringify(content)
  assert.ok(Buffer.byteLength(text) < 65536)
  assert.ok(!text.includes('fixture-secret-token'))
  assert.ok(!text.includes('\uFFFD'))
}
console.log('PASS: native multilingual tool progress and replacement events fit Matrix limits')
