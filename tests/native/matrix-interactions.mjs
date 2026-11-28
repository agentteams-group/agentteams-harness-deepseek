import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
const { installMatrixInteractions } = await import(process.env.AGENTTEAMS_INTERACTIONS_MODULE
  ?? new URL('../../plugins/teamharness/adapters/deepseek-harness/matrix-interactions.js', import.meta.url).href)
process.env.AGENTTEAMS_MATRIX_USER_ID = '@worker'

test('Agent automatic mode grants through the native answerer without changing the sandbox', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await()
  const { effectiveSandboxMode, setSandboxMode } = await import('@deepseek-ai/dsh-sandbox-policy')
  const transport = installMatrixInteractions(ctx, {
    url: 'http://matrix.test', token: 'test', room: '!room', sender: '@owner', approvalMode: 'allow',
    request: async () => { throw new Error('Automatic approval must not ask Matrix') },
  })
  const session = ctx.sessions.create('automatic-mode', { meta: { cwd: '/tmp' } })
  setSandboxMode(session, 'workspace-write')
  session.append('turn/start', { turn: 1 })
  const outcome = await ctx.approval.request({ agent: { session }, toolName: 'bash', reason: 'test gate' })
  await transport.flush()
  assert.equal(outcome, 'allowed-once')
  assert.equal(effectiveSandboxMode(session.events), 'workspace-write')
  assert.equal(session.events.at(-1).data.outcome, 'allowed-once')
  await ctx.registry.delete(ApprovalService)
  await ctx.registry.delete(SessionStore)
})

for (const [action, expected, requester, admin, approvalMode] of [
  ['approve', 'allowed-once', '@owner', undefined],
  ['deny', 'rejected', '@owner', undefined],
  ['approve', 'allowed-once', '@agent', '@owner'],
  ['deny', 'rejected', '@owner', undefined, 'allow'],
]) {
  test(`native DSH approval ${action} by ${admin ? 'admin' : 'owner'} ${approvalMode ?? 'default'} gates execution and records the committed receipt`, async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(ApprovalService, { policy: 'ask' }).await()
    const sent = []
    let pending
    let syncs = 0
    const transport = installMatrixInteractions(ctx, {
      url: 'http://matrix.test', token: 'test', room: '!room', sender: requester, admin, approvalMode,
      request: async (url, options) => {
        if (options.method === 'PUT') {
          const content = JSON.parse(options.body)
          sent.push(content)
          if (content['org.agentteams.approval'].status === 'pending') pending = content['org.agentteams.approval']
          return Response.json({ event_id: '$event' })
        }
        syncs++
        if (!pending) return Response.json({ next_batch: 'initial' })
        const body = `/agentteams-approval ${action} ${pending.request_id} ${pending.context_id}`
        // Wrong room, sender and context are ignored before the valid answer.
        const content = { body: 'Human decision', 'com.agentteams.answer': {
          kind: 'tool_approval', agent_id: syncs === 3 ? '@other' : '@worker', confirmation_id: pending.request_id,
          context_id: syncs === 2 ? 'stale' : pending.context_id,
          answer: action === 'approve' ? 'approved' : 'rejected',
        } }
        return Response.json({ next_batch: String(syncs), rooms: { join: {
          '!other': { timeline: { events: [{ type: 'm.room.message', sender: '@owner', content: { body } }] } },
          '!room': { timeline: { events: [
            { type: 'm.room.message', sender: '@intruder', content: { body } },
            { type: 'm.room.message', sender: '@owner', content },
          ] } },
        } } })
      },
    })
    const session = ctx.sessions.create('approval-test', { meta: { cwd: '/tmp' } })
    session.append('turn/start', { turn: 1 })
    const outcome = await ctx.approval.request({ agent: { session }, toolName: 'bash', reason: approvalMode === 'allow' ? 'AgentTeams MCP approval policy' : 'test gate' })
    let executed = false
    if (outcome === 'allowed-once') executed = true
    await transport.flush()
    assert.equal(outcome, expected)
    assert.equal(executed, action === 'approve')
    assert.equal(session.events.at(-1).type, 'approval/decided')
    assert.equal(session.events.at(-1).data.outcome, expected)
    assert.equal(sent.at(-1)['org.agentteams.approval'].status, action === 'approve' ? 'approved' : 'rejected')
    assert.equal(sent[0]['org.agentteams.approval'].request_id, session.events.find(e => e.type === 'approval/asked').data.id)
    await ctx.registry.delete(ApprovalService)
    await ctx.registry.delete(SessionStore)
  })
}

test('native cancellation never grants execution', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await()
  const controller = new AbortController()
  const sent = []
  const transport = installMatrixInteractions(ctx, {
    url: 'http://matrix.test', token: 'test', room: '!room', sender: '@owner',
    request: async (_url, options) => {
      if (options.method === 'PUT') {
        sent.push(JSON.parse(options.body))
        if (sent.length === 1) queueMicrotask(() => controller.abort())
        return Response.json({ event_id: '$event' })
      }
      return Response.json({ next_batch: 'initial' })
    },
  })
  const session = ctx.sessions.create('cancel-test', { meta: { cwd: '/tmp' } })
  session.append('turn/start', { turn: 1 })
  assert.equal(await ctx.approval.request({ agent: { session }, toolName: 'bash', signal: controller.signal }), 'cancelled')
  await transport.flush()
  assert.equal(sent.at(-1)['org.agentteams.approval'].status, 'cancelled')
  await ctx.registry.delete(ApprovalService)
  await ctx.registry.delete(SessionStore)
})

test('native question service receives exact multi-select and custom answers', async () => {
  const ctx = new Context()
  await ctx.plugin(UserQuestionService).await()
  let card
  let syncs = 0
  installMatrixInteractions(ctx, {
    url: 'http://matrix.test', token: 'test', room: '!room', sender: '@owner',
    request: async (_url, options) => {
      if (options.method === 'PUT') {
        card = JSON.parse(options.body)['org.agentteams.run'].blocks[0]
        return Response.json({ event_id: '$question' })
      }
      const content = card ? { 'com.agentteams.answer': {
        kind: 'ask_user', agent_id: syncs === 2 ? '@other' : '@worker',
        confirmation_id: card.confirmation_id,
        responses: [{ id: 'multi', selected: ['甲', '乙'], ...(syncs === 1 ? { custom: {} } : {}) }, { id: 'free', selected: [], custom: '补充内容' }],
      } } : {}
      return Response.json({ next_batch: String(++syncs), rooms: { join: { '!room': { timeline: { events: [{ type: 'm.room.message', sender: '@owner', content }] } } } } })
    },
  })
  assert.deepEqual(await ctx.userQuestions.ask({ questions: [
    { id: 'multi', question: '选择范围', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] },
    { id: 'free', question: '补充说明' },
  ] }), { answers: [{ id: 'multi', selected: ['甲', '乙'], custom: undefined }, { id: 'free', selected: [], custom: '补充内容' }] })
  assert.ok(syncs >= 4, 'invalid custom values and another Agent target must not resume the question')
  await ctx.registry.delete(UserQuestionService)
})

test('question receipt failure does not discard an accepted native answer', async () => {
  const ctx = new Context()
  await ctx.plugin(UserQuestionService).await()
  let card
  installMatrixInteractions(ctx, {
    url: 'http://matrix.test', token: 'test', room: '!room', sender: '@owner',
    request: async (_url, options) => {
      if (options.method === 'PUT') {
        const block = JSON.parse(options.body)['org.agentteams.run'].blocks[0]
        if (block.status !== 'pending') throw new Error('receipt transport unavailable')
        card = block
        return Response.json({ event_id: '$question' })
      }
      return Response.json({ next_batch: 'next', rooms: { join: { '!room': { timeline: { events: card ? [{
        type: 'm.room.message', sender: '@owner', content: { 'com.agentteams.answer': {
          confirmation_id: card.confirmation_id, responses: [{ id: 'free', selected: [], custom: 'Continue' }],
        } },
      }] : [] } } } } })
    },
  })
  assert.deepEqual(await ctx.userQuestions.ask({ questions: [{ id: 'free', question: 'Explain' }] }),
    { answers: [{ id: 'free', selected: [], custom: 'Continue' }] })
  await ctx.registry.delete(UserQuestionService)
})
