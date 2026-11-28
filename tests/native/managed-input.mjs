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
    const failed = await run('uncertain')
    assert.equal(failed.isError, true)
    assert.equal(failed.error.message, 'Lost upstream response')
    assert.deepEqual(effects, ['reserve:known','body:known','confirm:known','reserve:uncertain','body:uncertain'])
    tools.register(defineContentToolFixture({
      name:'read', description:'Unregistered reader fixture', parameters:{},
      async execute() { throw new Error('File not found') },
    }))
    const failedRead = await tools.execute({callId:'read-error',name:'read',arguments:{},signal:new AbortController().signal})
    assert.equal(failedRead.isError, true)
    // A tool name alone does not prove this is the installed native reader.
    assert.deepEqual(effects.slice(-2), ['body:uncertain','reserve:read-error'])
  } finally {
    await ctx.registry.delete(ToolRuntime)
    await ctx.registry.delete(SystemPrompt)
  }
})

test('native dispatch retains a completed return when the Core receipt connection fails', async () => {
  const { ToolRuntime, defineContentToolFixture } = await import('@deepseek-ai/dsh-tools')
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { installExecutionGuard } = await import(process.env.AGENTTEAMS_MANAGED_NATIVE_MODULE)
  const ctx = new Context()
  let effects = 0
  try {
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime, {mode:'native'}).await()
    const tools = ctx.get('tools')
    tools.register(defineContentToolFixture({name:'fixture_effect',description:'Fixture effect',parameters:{},
      async execute() {effects++; return [{type:'text',text:'Original native return'}]}}))
    installExecutionGuard(ctx, undefined, {event_key:'source'}, async () => {}, action => {
      if (action.endsWith('begin_tools')) return 'operation'
      if (action.endsWith('finish_tools')) throw new Error('Receipt connection failed')
    })
    const invoke = callId => tools.execute({callId,name:'fixture_effect',arguments:{},signal:new AbortController().signal})
    const result = await invoke('first')
    assert.equal(result.isError,false)
    assert.deepEqual(result.content,[{type:'text',text:'Original native return'}])
    const blocked = await invoke('next')
    assert.equal(blocked.isError,true)
    assert.match(blocked.error.message,/Receipt connection failed/)
    assert.equal(effects,1)
  } finally {
    await ctx.registry.delete(ToolRuntime)
    await ctx.registry.delete(SystemPrompt)
  }
})


test('scoped native filesystem refusal settles as no effect and keeps the original file', async () => {
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local')
  const filesystemTools = await import('@deepseek-ai/dsh-tool-fs')
  const observationPolicy = await import('@deepseek-ai/dsh-fs-observation-policy')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const { writeFile, readFile } = await import('node:fs/promises')
  const { installExecutionGuard } = await import(process.env.AGENTTEAMS_MANAGED_NATIVE_MODULE)
  const root = await mkdtemp(join(tmpdir(), 'dsh-scoped-refusal-'))
  const ctx = new Context()
  let scoped
  try {
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime, {mode:'native'}).await()
    await ctx.plugin(LocalFileSystem, {cwd:root}).await()
    await ctx.plugin(observationPolicy).await()
    const agent = {session:{header:{cwd:root}}}
    scoped = createScope(ctx, agent)
    await scoped.ctx.plugin(filesystemTools).await()
    const target = join(root,'existing.txt')
    await writeFile(target,'original')
    const receipts = [], reservations = []
    assert.equal(ctx.get('tools').get('write'),undefined)
    assert.ok(ctx.get('tools').get('write',agent))
    const baseline = await ctx.get('tools').execute({agent,callId:'baseline',name:'write',arguments:{file_path:target,content:'replacement'},signal:new AbortController().signal})
    assert.equal(baseline.error?.info?.code,'FS_NOT_OBSERVED',JSON.stringify(baseline))
    installExecutionGuard(ctx, agent, {event_key:'fixture'},async()=>{},(action,fields)=>{
      if(action.endsWith('begin_tools')) { reservations.push(fields.calls[0]); return 'op' }
      if(action.endsWith('finish_tools')) receipts.push(...fields.results)
    })
    const result = await ctx.get('tools').execute({agent,callId:'refused',name:'write',arguments:{file_path:target,content:'replacement'},signal:new AbortController().signal})
    assert.equal(result.error?.info?.code,'FS_NOT_OBSERVED',JSON.stringify(result))
    assert.equal(await readFile(target,'utf8'),'original')
    assert.deepEqual(reservations[0].pre_effect_error_codes,['FS_NOT_OBSERVED'])
    assert.equal(receipts[0].effect,'none')
    assert.equal(receipts[0].error_code,'FS_NOT_OBSERVED')
  } finally {
    await scoped?.dispose()
    await ctx.registry.delete(ToolRuntime)
    await ctx.registry.delete(SystemPrompt)
    await ctx.registry.delete(LocalFileSystem)
    await rm(root,{recursive:true,force:true})
  }
})
