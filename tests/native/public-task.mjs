import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'

const { nativeCall, preparePublicTask, installPublicTask, persistRefreshedInputs, persistDeliveryContext, persistPhaseReceipt, savePendingHandoffs, appendConfirmedHandoffs } = await import(
  process.env.AGENTTEAMS_PUBLIC_TASK_MODULE ?? new URL('../../plugins/teamharness/adapters/deepseek-harness/public-task.js', import.meta.url).href)

test('assistant control input does not bind a business Task roster or tools', async () => {
  const calls = []
  const state = await preparePublicTask({ role: 'team_leader', team: 'DeepSeek Harness 验收',
    meta: { event_id: '$assistant', room_id: '!assistant:test',
      teamharness_coordination: { id: 'assistant-notice', kind: 'assistant_digest' } } }, async request => {
    calls.push(request.operation)
    if (request.operation === 'sources') return []
    if (request.operation === 'prepare_event') return {}
    assert.fail('Assistant input must not load Task roster or schema: ' + request.operation)
  })
  assert.equal(state, undefined)
  assert.deepEqual(calls, ['prepare_event'])
  await installPublicTask({ get() { assert.fail('Assistant input must not install Task tools') } }, state)
})

test('verified execution keeps its authenticated actor without binding another Human source', async () => {
  const state = await preparePublicTask({ role: 'worker', meta: { event_id: '$assignment',
    agent_matrix_user_id: '@own:test', teamharness_coordination: { kind: 'task_assigned', task_id: 'own' } } },
  async request => {
    assert.equal(request.operation, 'prepare_event')
    return { execution: 'own' }
  })
  assert.equal(state.context.actor, '@own:test')
  assert.deepEqual(state.context.sources, [])
})

test('verified planning requires an overview before any Task mutation', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
  const agent = {}
  const scoped = createScope(ctx, agent)
  try {
    let calls = 0
    const state = { context: { role: 'team_leader', planning: ['main'], sources: [] }, pending: [],
      call: async request => {
        if (request.operation === 'schema') return nativeCall(request)
        calls++
        return { result: { ok: true }, refreshedInputs: [] }
      } }
    await installPublicTask(scoped.ctx, state)
    await assert.rejects(() => state.nativeExecute({ action: 'plan', mainTaskId: 'main', overview: ' ' },
      { signal: new AbortController().signal }), /overview/)
    assert.equal(calls, 0)
  } finally {
    await scoped.dispose()
    await ctx.registry.delete(ToolRuntime)
    await ctx.registry.delete(SystemPrompt)
  }
})

test('native terminal tool and stored receipt retain sent facts with silent presentation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-terminal-facts-'))
  const ctx = new Context()
  let scoped
  try {
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'native'), compression: 'none' }).await()
    const sessions = ctx.get('sessions'), persistence = ctx.get('sessionPersistence')
    const session = sessions.create('session-terminal', { meta: { cwd: root } })
    const agent = { session }
    scoped = createScope(ctx, agent)
    const outcome = { phaseComplete: true, receiptId: 'saved', fact: 'Saved immutable result.',
      result: { task: { id: 'own', status: 'completed', spec: 'Do not repeat this full snapshot' } },
      extraReceipts: [{ receiptId: 'sent', fact: 'Already notified downstream. Matrix event $sent.' }] }
    const state = { context: { role: 'worker', execution: 'own', sources: [],
      context: { task: { id: 'own', spec: 'Own duty' }, inputs: [{ files: [{ name: 'input.json', preview: 'Never inject preview' }] }] } },
      pending: [], call: request => request.operation === 'task' ? outcome : nativeCall(request) }
    await installPublicTask(scoped.ctx, state)
    const result = await scoped.ctx.get('tools').execute({ agent, callId: 'submit', name: 'mcp__teamharness__task',
      arguments: { action: 'submit', taskId: 'own', summary: 'Done' }, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.concludesTurn, true)
    assert.equal(state.displayText, 'NO_REPLY')
    const text = result.content.find(block => block.type === 'text').text
    assert.match(text, /Already notified downstream/)
    assert.doesNotMatch(text, /Do not repeat this full snapshot/)
    const prompt = await scoped.ctx.get('systemPrompt').assemble({ scope: agent })
    assert.doesNotMatch(prompt.sections.map(section => section.text).join('\n'), /Never inject preview/)
    await persistPhaseReceipt(state, agent, sessions, persistence)
    const stored = await persistence.loadStored(session.id)
    assert.ok(stored.events.some(event => event.type === 'user/message' &&
      JSON.stringify(event.data).includes('Matrix event $sent')))
  } finally {
    await scoped?.dispose()
    await ctx.registry.delete(ToolRuntime)
    await ctx.registry.delete(SystemPrompt)
    await ctx.registry.delete(JsonlSessionPersistence)
    await ctx.registry.delete(SessionStore)
    await rm(root, { recursive: true, force: true })
  }
})

test('real DSH scope shadows old MCP Task, restricts legacy tools and preserves the common receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-task-'))
  const ctx = new Context()
  const original = { path: process.env.PATH, home: process.env.HOME }
  let scoped
  try {
    await mkdir(join(root, 'bin'))
    await writeFile(join(root, 'bin/agt'), '#!/usr/bin/python3\nimport json,sys\nassert sys.argv[1:3]==["task","submit"]\nprint(json.dumps({"task":{"id":sys.argv[3],"status":"submitted","submissionId":"saved"},"notification":{"status":"queued","recipient":"leader","eventId":"notice"}}))\n', { mode: 0o700 })
    process.env.PATH = join(root, 'bin') + ':' + original.path
    process.env.HOME = root
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
    const tools = ctx.get('tools')
    let oldCalls = 0
    for (const name of ['task', 'mcp__teamharness__task', 'mcp__teamharness__taskflow', 'business_read']) {
      tools.register(defineContentToolFixture({ name, description: 'Own native fixture', parameters: {},
        async execute() { oldCalls++; return [{ type: 'text', text: 'legacy' }] } }))
    }
    const key = {}, agent = key
    scoped = createScope(ctx, key)
    const state = { context: { role: 'worker', execution: 'own', sources: [] }, pending: [], call: nativeCall }
    await installPublicTask(scoped.ctx, state)
    const native = scoped.ctx.get('tools')
    assert.equal(tools.get('mcp__teamharness__task', key).execute, state.nativeExecute)
    const names = native.schemas(key).map(tool => tool.name)
    assert.ok(names.includes('mcp__teamharness__task'))
    assert.ok(names.includes('business_read'))
    assert.ok(!names.includes('task'))
    assert.ok(tools.schemas().some(tool => tool.name === 'task'))
    assert.ok(!names.includes('mcp__teamharness__taskflow'))
    assert.ok(tools.schemas().some(tool => tool.name === 'mcp__teamharness__taskflow'))
    const execute = arguments_ => native.execute({ agent, callId: 'own-call', name: 'mcp__teamharness__task',
      arguments: arguments_, signal: new AbortController().signal })
    const response = await execute({ action: 'submit', taskId: 'own', summary: 'Own native fixture' })
    assert.equal(response.isError, false, JSON.stringify(response))
    assert.equal(response.concludesTurn, true)
    assert.match(state.finalReceipt, /Delivery and acceptance are not yet confirmed/)
    const result = JSON.parse(response.content.find(block => block.type === 'text').text)
    assert.equal(result.task.submissionId, 'saved')
    const prompt = await scoped.ctx.get('systemPrompt').assemble({ scope: key })
    assert.match(prompt.sections.map(section => section.text).join('\n'), /Use mcp__teamharness__task for the common Task operations/)
    assert.match(prompt.sections.map(section => section.text).join('\n'), /Delivery and acceptance are not yet confirmed/)
    assert.equal(oldCalls, 0)
    assert.equal((await execute({ action: 'submit', taskId: 'foreign', summary: 'wrong' })).isError, true)
    assert.equal((await execute({ action: 'get', taskId: 'own', _nativeSource: {} })).isError, true)
  } finally {
    await scoped?.dispose()
    await ctx.registry.delete(ToolRuntime)
    await ctx.registry.delete(SystemPrompt)
    process.env.PATH = original.path
    process.env.HOME = original.home
    await rm(root, { recursive: true, force: true })
  }
})

test('native DSH user-message flush and physical readback precede releasing input refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-refresh-'))
  const ctx = new Context()
  const home = process.env.HOME
  try {
    process.env.HOME = root
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'native'), compression: 'none' }).await()
    const sessions = ctx.get('sessions'), persistence = ctx.get('sessionPersistence')
    const session = sessions.create('session-public-task', { meta: { cwd: root } })
    const state = { pending: [{ eventId: '$late', roomId: '!fixture:test', userId: '@human:test', body: 'Own corrected Human input' }],
      context: { inputRefreshPending: true } }
    await persistRefreshedInputs(state, { session }, sessions, persistence)
    assert.equal(state.context.inputRefreshPending, undefined)
    const saved = await persistence.loadStored(session.id)
    const row = saved.events.find(event => event.type === 'user/message')
    assert.equal(row.data.role, 'user')
    assert.match(row.data.content[0].text, /\[Message \$late\]\nOwn corrected Human input/)
    state.pending = [{ eventId: '$unsaved', roomId: '!fixture:test', userId: '@human:test', body: 'Do not acknowledge this' }]
    state.context.inputRefreshPending = true
    await assert.rejects(persistRefreshedInputs(state, { session }, sessions, { loadStored: async () => undefined }), /not durable/)
    assert.equal(state.context.inputRefreshPending, true)
  } finally {
    await ctx.registry.delete(JsonlSessionPersistence)
    await ctx.registry.delete(SessionStore)
    process.env.HOME = home
    await rm(root, { recursive: true, force: true })
  }
})

test('canonical phase admission is required before planning and inactive phases do not prepare', async () => {
  const calls = []
  const frame = { role: 'leader', meta: { event_id: '$source', room_id: '!fixture:test', sender_id: '@manager:test',
    teamharness_coordination: { kind: 'handoff', id: 'a'.repeat(32) } } }
  const call = async payload => {
    calls.push(payload)
    if (payload.operation === 'sources') return []
    if (payload.operation === 'admit_event') return { active: false }
    assert.fail('inactive phase started preparation')
  }
  assert.equal((await preparePublicTask(frame, call)).inactive, true)
  assert.deepEqual(calls.map(call => call.operation), ['admit_event'])
})


test('delivery context uses native plugin message and only acknowledges durable SDK data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-delivery-'))
  const ctx = new Context()
  const home = process.env.HOME
  try {
    process.env.HOME = root
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'native'), compression: 'none' }).await()
    const sessions = ctx.get('sessions'), persistence = ctx.get('sessionPersistence')
    const session = sessions.create('session-delivery', { meta: { cwd: root } })
    let acknowledgements = 0
    const state = { delivery: { facts: ['Verified original room received accepted artifacts.'], acknowledgements: ['sent-1'] },
      middle: {}, deliveryPath: join(root, 'context/cursor.json'), call: async payload => {
        assert.equal(payload.operation, 'ack_delivery_context'); acknowledgements++; return { sent: ['sent-1'] }
      } }
    await assert.rejects(persistDeliveryContext(state, { session }, sessions, { loadStored: async () => undefined }), /not durable/)
    assert.equal(acknowledgements, 0)
    await persistDeliveryContext(state, { session }, sessions, persistence)
    assert.equal(acknowledgements, 1)
    const saved = await persistence.loadStored(session.id)
    const rows = saved.events.filter(event => event.type === 'user/message')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].data.source.kind, 'plugin')
    assert.match(rows[0].data.content[0].text, /accepted artifacts/)
  } finally {
    await ctx.registry.delete(JsonlSessionPersistence)
    await ctx.registry.delete(SessionStore)
    process.env.HOME = home
    await rm(root, { recursive: true, force: true })
  }
})

test('delayed dispatch is recorded once in the closed submitting session without an agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-late-handoff-'))
  const ctx = new Context()
  const id = 'session-task-' + '1'.repeat(32)
  const eventId = 'a'.repeat(32)
  const receiptId = JSON.stringify(['dispatch', eventId, 'matrix:$sent'])
  try {
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'store'), compression: 'none' }).await()
    const sessions = ctx.get('sessions'), persistence = ctx.get('sessionPersistence')
    const session = sessions.prepare(id, { meta: { cwd: root } })
    const leave = sessions.enter(session)
    sessions.announce(session)
    const phase = { finalReceipt: '已提交此阶段成果。', phaseReceiptId: 'submission-receipt' }
    await persistPhaseReceipt(phase, { session }, sessions, persistence)
    leave()
    const result = { task: { id: 'child', mainTaskId: 'main', submissionId: 'revision' },
      notification: { status: 'queued', eventId }, secretSnapshot: 'do not copy' }
    await savePendingHandoffs(root, id, root, phase.phaseReceiptId, result, [])
    const pending = JSON.parse(await readFile(join(root, 'sessions', '.task-handoffs', id + '.json'), 'utf8'))
    assert.equal(pending.result.secretSnapshot, undefined)
    const confirmed = [{ receiptId, fact: '已通知下游。Matrix 事件 $sent。' }]
    await appendConfirmedHandoffs(sessions, persistence, id, pending, confirmed)
    const first = (await persistence.loadStored(id)).events
    await appendConfirmedHandoffs(sessions, persistence, id, pending, confirmed)
    const events = (await persistence.loadStored(id)).events
    const sent = events.filter(row => row.type === 'user/message' && row.data.source.plugin === 'agentteams.task-handoff')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].data.content[0].text, confirmed[0].fact)
    assert.deepEqual(events, first)
    assert.equal(events.filter(row => row.type === 'user/message').at(-1).seq, sent[0].seq)
    await assert.rejects(appendConfirmedHandoffs(sessions, persistence, id,
      { ...pending, phaseReceiptId: 'another-submission' }, confirmed), /submission/)
  } finally {
    await ctx.registry.delete(JsonlSessionPersistence)
    await ctx.registry.delete(SessionStore)
    await rm(root, { recursive: true, force: true })
  }
})


test('ordinary followup keeps the transport room without claiming an execution', async () => {
  const state = await preparePublicTask({ role: 'worker', meta: {
    event_id: '$followup', room_id: '!task:test', sender_id: '@leader:test',
  } }, async request => {
    assert.equal(request.operation, 'sources')
    return []
  })
  assert.equal(state.context.sourceRoom, '!task:test')
  assert.equal(state.context.execution, undefined)
})

test('ordinary task-room followup reads authoritative task context', async () => {
  const previous = process.env.AGENTTEAMS_CONTROLLER_URL
  process.env.AGENTTEAMS_CONTROLLER_URL = 'http://controller.test'
  try {
    const calls = []
    const task = { task: { id: 'main', spec: 'latest requirement' }, currentExecution: { id: 'node' } }
    const state = await preparePublicTask({ role: 'worker', meta: {
      event_id: '$followup', room_id: '!task:test', sender_id: '@leader:test',
    } }, async request => {
      calls.push(request.operation)
      if (request.operation === 'sources') return []
      assert.equal(request.operation, 'room_context')
      assert.equal(request.room, '!task:test')
      return { context: task, fact: 'Task system context' }
    })
    assert.deepEqual(calls, ['sources', 'room_context'])
    assert.deepEqual(state.context.context, task)
    assert.equal(state.context.execution, undefined)
  } finally {
    if (previous === undefined) delete process.env.AGENTTEAMS_CONTROLLER_URL
    else process.env.AGENTTEAMS_CONTROLLER_URL = previous
  }
})
