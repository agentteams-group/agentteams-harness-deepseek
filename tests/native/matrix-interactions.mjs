import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
const { installMatrixInteractions } = await import(process.env.AGENTTEAMS_INTERACTIONS_MODULE
  ?? new URL('../../plugins/teamharness/adapters/deepseek-harness/matrix-interactions.js', import.meta.url).href)

for (const [action, expected, requester, admin] of [
  ['approve', 'allowed-once', '@owner', undefined],
  ['deny', 'rejected', '@owner', undefined],
  ['approve', 'allowed-once', '@agent', '@owner'],
]) {
  test(`native DSH approval ${action} by ${admin ? 'admin' : 'owner'} gates execution and records the committed receipt`, async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(ApprovalService, { policy: 'ask' }).await()
    const sent = []
    let pending
    let syncs = 0
    const transport = installMatrixInteractions(ctx, {
      url: 'http://matrix.test', token: 'test', room: '!room', sender: requester, admin,
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
        const content = { body: syncs === 2 ? body.replace(pending.context_id, 'stale') : `@worker ${body}` }
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
    const outcome = await ctx.approval.request({ agent: { session }, toolName: 'bash', reason: 'test gate' })
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
        confirmation_id: card.confirmation_id,
        responses: [{ id: 'multi', selected: ['甲', '乙'] }, { id: 'free', selected: [], custom: '补充内容' }],
      } } : {}
      return Response.json({ next_batch: String(++syncs), rooms: { join: { '!room': { timeline: { events: [{ type: 'm.room.message', sender: '@owner', content }] } } } } })
    },
  })
  assert.deepEqual(await ctx.userQuestions.ask({ questions: [
    { id: 'multi', question: '选择范围', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] },
    { id: 'free', question: '补充说明' },
  ] }), { answers: [{ id: 'multi', selected: ['甲', '乙'], custom: undefined }, { id: 'free', selected: [], custom: '补充内容' }] })
  await ctx.registry.delete(UserQuestionService)
})
