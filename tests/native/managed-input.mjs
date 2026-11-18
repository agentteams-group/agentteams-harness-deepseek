import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { freezeMessage } from '@deepseek-ai/dsh-llm'

const { commitMatrixSource } = await import(process.env.AGENTTEAMS_MANAGED_NATIVE_MODULE ??
  new URL('../../plugins/teamharness/adapters/deepseek-harness/managed-native.js', import.meta.url).href)

test('native DSH appends a late source without inference and proves disk readback before confirming it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worker-source-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' }).await()
    const sessions = ctx.get('sessions'), persistence = ctx.get('sessionPersistence')
    const session = sessions.create('session-task-fixture', { meta: { cwd: root } })
    const input = { room_id:'!room', event_id:'$late', input: { sender:'@leader', content:{body:'assignment'} } }
    const native = freezeMessage({ id:'matrix-late', role:'user', source:{kind:'user'}, content:[{type:'text', text:JSON.stringify(input)}] })
    session.append('user/message', native, { surfaceOp: 'append' })
    await sessions.flush(session)
    const row = session.events.at(-1)
    const actions = []
    await commitMatrixSource(session, row, persistence, 'key', input, (action, fields) => {
      actions.push(action)
      if (action.endsWith('.get')) return {input}
      if (action.endsWith('.commit')) {
        assert.equal(fields.native_ref, 'session-task-fixture/matrix-late')
        assert.match(fields.native_digest, /^[a-f0-9]{64}$/)
      }
    })
    assert.deepEqual(actions, ['matrix.native.get','matrix.native.current','matrix.native.commit'])
    assert.equal(session.events.filter(event => event.type === 'turn/start').length, 0)
    const file = persistence.locate((await persistence.loadStored(session.id)).meta).path
    await rm(file)
    await assert.rejects(commitMatrixSource(session, row, persistence, 'key', input), /physical/)
  } finally {
    await ctx.registry.delete(JsonlSessionPersistence)
    await ctx.registry.delete(SessionStore)
    await rm(root, {recursive:true, force:true})
  }
})
