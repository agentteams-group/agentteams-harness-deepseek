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

test('DSH tool dispatch reserves before a real body and keeps ambiguous results for verification', async () => {
  const { ToolRuntime, defineContentToolFixture } = await import('@deepseek-ai/dsh-tools')
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { installExecutionGuard } = await import(process.env.AGENTTEAMS_MANAGED_NATIVE_MODULE ??
    new URL('../../plugins/teamharness/adapters/deepseek-harness/managed-native.js', import.meta.url).href)
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
    const tools = ctx.get('tools'), effects = []
    installExecutionGuard(ctx, undefined, {event_key:'source'}, async () => {}, (action, fields) => {
      if (action.endsWith('begin_tools')) { effects.push('reserve:' + fields.calls[0].id); return 'op' }
      effects.push('confirm:' + fields.results[0].id)
    })
    tools.register(defineContentToolFixture({
      name:'checked_write',description:'Fixture effect', parameters:{},
      async execute(_args, execution) {
        effects.push('body:' + execution.callId)
        if (execution.callId === 'uncertain') throw new Error('Lost upstream response')
        return [{type:'text',text:'written'}]
      },
    }))
    const run = callId => tools.execute({callId, name:'checked_write', arguments:{}, signal:new AbortController().signal})
    assert.equal((await run('known')).isError, false)
    assert.equal((await run('uncertain')).isError, true)
    assert.deepEqual(effects, ['reserve:known','body:known','confirm:known','reserve:uncertain','body:uncertain'])
  } finally {
    await ctx.registry.delete(ToolRuntime)
    await ctx.registry.delete(SystemPrompt)
  }
})
