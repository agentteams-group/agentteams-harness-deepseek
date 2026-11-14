import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { runtimeRecord } from '../plugins/teamharness/adapters/deepseek-harness/runtime-logging.js'

test('the distributable adapter contains the logging module imported by the runner', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: new URL('../plugins/teamharness/adapters/deepseek-harness/', import.meta.url), encoding: 'utf8',
  })
  assert.equal(packed.status, 0, packed.stderr)
  assert.ok(JSON.parse(packed.stdout)[0].files.some(file => file.path === 'runtime-logging.js'))
})

test('native operation logs omit prompts, answers and tool arguments', () => {
  assert.equal(runtimeRecord({ type: 'user/message', data: { content: 'private prompt' } }), undefined)
  const call = runtimeRecord({ type: 'tool/call', data: { name: 'shell', callId: 'one', arguments: 'private command' } })
  assert.equal(call.fields.item_id, 'one')
  assert.ok(!JSON.stringify(call).includes('private command'))
  assert.deepEqual(runtimeRecord({ type: 'assistant/message', data: { message: { content: 'private answer' } } }).fields, { turn: undefined, step: undefined })
})

test('native tool failure keeps the error and call identity', () => {
  const result = runtimeRecord({ type: 'tool/result', data: { error: { code: 'E_TOOL' }, message: { content: [{
    toolCallId: 'one', isError: true, content: [{ type: 'text', text: 'command exited 127' }],
  }] } } })
  assert.equal(result.fields.status, 'failed')
  assert.equal(result.fields.item_id, 'one')
  assert.equal(result.fields.error, 'command exited 127')
})
