import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointInput } from '../plugins/teamharness/adapters/deepseek-harness/session-receipt.js'

test('a read checkpoint waits for the actual native input flush, not the answer', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-receipt-'))
  try {
    const event = { type: 'user/message', data: { id: 'native-input' } }
    let saved
    const flush = () => new Promise(resolve => { saved = resolve })
    const checkpoint = checkpointInput({}, event, { id: 'native-input', eventId: '$input', roomId: '!room:hs', workspace, flush })
    await assert.rejects(readdir(join(workspace, '.agentteams/dsh-checkpoints')))
    saved()
    assert.equal(await checkpoint, true)
    const directory = join(workspace, '.agentteams/dsh-checkpoints')
    const [name] = await readdir(directory)
    assert.deepEqual(JSON.parse(await readFile(join(directory, name))), { receipts: [{ room_id: '!room:hs', event_id: '$input' }] })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('failed persistence and unrelated queued input never create read evidence', async () => {
  const options = { id: 'native-input', eventId: '$input', roomId: '!room:hs', workspace: '/unused', flush: async () => { throw new Error('save failed') } }
  assert.equal(await checkpointInput({}, { type: 'user/message', data: { id: 'other' } }, options), false)
  await assert.rejects(checkpointInput({}, { type: 'user/message', data: { id: 'native-input' } }, options), /save failed/)
})
