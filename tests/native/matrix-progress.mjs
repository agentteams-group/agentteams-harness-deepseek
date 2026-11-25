import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
const { installMatrixInteractions } = await import(process.env.AGENTTEAMS_INTERACTIONS_MODULE
  ?? new URL('../../plugins/teamharness/adapters/deepseek-harness/matrix-interactions.js', import.meta.url).href)

test('native session tool events publish exact IDs, arguments, results and edits without entering model input', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  const sent = []
  const transport = installMatrixInteractions(ctx, {
    url: 'http://matrix.test', token: 'private-matrix-token', room: '!task', sender: '@owner',
    request: async (_url, options) => {
      if (options.method === 'GET') return Response.json({errcode: 'M_NOT_FOUND'}, {status: 404})
      sent.push(JSON.parse(options.body)); return Response.json({event_id: '$' + sent.length})
    },
  })
  const session = ctx.sessions.create('progress-test', {meta: {cwd: '/tmp'}})
  transport.bindProgress(session, 'deepseek:task:one:1')
  session.append('turn/start', {turn: 1})
  session.append('assistant/message', {turn: 1, step: 1, message: {role: 'assistant', content: [
    {type: 'reasoning', text: '检查页面交互。'}, {type: 'tool-call', id: 'read-1', name: 'read', arguments: '{}'},
  ]}}, {surfaceOp: 'append'})
  session.append('tool/call', {turn: 1, step: 1, callId: 'read-1', name: 'read', arguments: '{"path":"index.html","token":"private-matrix-token"}'})
  session.append('tool/call', {turn: 1, step: 1, callId: 'read-2', name: 'read', arguments: '{"path":"missing.html"}'})
  const result = (id, text, isError) => ({turn: 1, step: 1, message: {role: 'user', source: {kind: 'tool', callId: id},
    content: [{type: 'tool-result', toolCallId: id, isError, content: [{type: 'text', text}]}]}})
  session.append('tool/result', result('read-2', 'not found; Authorization: Bearer unknown-private-token', true), {surfaceOp: 'append'})
  session.append('tool/result', result('read-1', '<html>ok</html>', false), {surfaceOp: 'append'})
  session.append('turn/end', {turn: 1, reason: {kind: 'completed'}})
  await transport.flush()
  assert.equal(sent.length, 6)
  const blocks = sent.map(content => (content['m.new_content'] ?? content)['org.agentteams.run'].blocks[0])
  assert.equal(blocks[0].type, 'thinking')
  assert.equal(blocks[0].content, '检查页面交互。')
  assert.deepEqual(blocks.slice(1,5).map(block => [block.tool_call_id, block.status]), [
    ['read-1','running'], ['read-2','running'], ['read-2','failed'], ['read-1','succeeded'],
  ])
  assert.deepEqual(blocks[4].arguments, {path: 'index.html', token: '[REDACTED]'})
  assert.equal(blocks[4].result[0].text, '<html>ok</html>')
  assert.equal(sent[3]['m.relates_to'].event_id, '$3')
  assert.equal(sent[4]['m.relates_to'].event_id, '$2')
  assert.ok(!JSON.stringify(sent).includes('unknown-private-token'))
  for (const outer of sent) {
    const content = outer['m.new_content'] ?? outer
    assert.equal(content['org.agentteams.progress_only'], true)
    assert.equal(content['org.agentteams.run'].run_id, 'deepseek:task:one:1')
    assert.deepEqual(content['m.mentions'], {user_ids: []})
    assert.ok(!JSON.stringify(outer).includes('private-matrix-token'))
  }
  assert.equal(blocks[5].kind, 'quiet')
  assert.ok(!session.events.some(event => event.data?.['org.agentteams.run']))
  await ctx.registry.delete(SessionStore)
})

test('progress refuses encrypted rooms and does not reinterpret display failure as a native result', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  let sent = 0
  const transport = installMatrixInteractions(ctx, {url:'http://matrix.test', token:'test', room:'!private', sender:'@owner',
    request: async (_url, options) => {
      if (options.method === 'GET') return Response.json({algorithm:'m.megolm.v1.aes-sha2'})
      sent++; return Response.json({event_id:'$leak'})
    }})
  const session = ctx.sessions.create('encrypted-progress', {meta:{cwd:'/tmp'}})
  transport.bindProgress(session, 'own-run')
  session.append('tool/call', {turn:1,step:1,callId:'private',name:'read',arguments:'{"path":"private.txt"}'})
  await transport.flush()
  assert.equal(sent, 0)
  assert.equal(session.events.at(-1).type, 'tool/call')
  await ctx.registry.delete(SessionStore)
})
