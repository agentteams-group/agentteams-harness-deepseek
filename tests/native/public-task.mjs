import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'

const { nativeCall, preparePublicTask, installPublicTask, persistRefreshedInputs, persistDeliveryContext } = await import(
  process.env.AGENTTEAMS_PUBLIC_TASK_MODULE ?? new URL('../../plugins/teamharness/adapters/deepseek-harness/public-task.js', import.meta.url).href)

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
    for (const name of ['mcp__teamharness__task', 'mcp__teamharness__taskflow', 'business_read']) {
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
  assert.deepEqual(calls.map(call => call.operation), ['sources', 'admit_event'])
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
