import assert from 'node:assert/strict'
import test from 'node:test'
import { installExecutionGuard, commitMatrixSource } from '../plugins/teamharness/adapters/deepseek-harness/managed-native.js'

test('the model waits for input persistence and fresh ownership; independent tools checkpoint in execution order', async () => {
  const handlers = {}, order = [], ctx = { on: (name, handler) => { handlers[name] = handler } }
  const agent = {}
  const identity = { event_key: 'source' }
  installExecutionGuard(ctx, agent, identity, async () => order.push('read'), (action, fields) => {
    assert.deepEqual(fields.identity, identity)
    order.push(action)
    if (action.endsWith('begin_tools')) return fields.calls[0].id
    if (action.endsWith('finish_tools')) assert.equal(fields.results[0].id, fields.operation_id)
  })
  await handlers['agent/request']({}, async () => order.push('model'))
  await Promise.all(['one', 'two'].map(callId => handlers['tools/execute']({agent, callId, name: 'write', arguments: {}}, async () => {
    order.push(callId)
    return { content: [{ type: 'text', text: callId }], isError: false }
  })))
  assert.deepEqual(order, ['read','matrix.message.current','model','read','matrix.message.begin_tools','one','matrix.message.finish_tools',
    'read','matrix.message.begin_tools','two','matrix.message.finish_tools'])
})

test('an uncertain native tool result keeps its operation outstanding', async () => {
  const handlers = {}, actions = [], agent = {}
  installExecutionGuard({ on: (name, handler) => { handlers[name] = handler } }, agent, { event_key: 'source' }, async () => {}, action => actions.push(action))
  await assert.rejects(handlers['tools/execute']({agent, callId:'id', name:'write', arguments:{}}, async () => ({isError: true, content: []})), /unconfirmed/)
  assert.deepEqual(actions, ['matrix.message.begin_tools'])
})

test('missing or different durable user input prevents native commit', async () => {
  const row = {type:'user/message', seq:0, data:{id:'input', content:[{type:'text',text:'hello'}]}}
  let saved, commits = 0
  const input = {room_id:'!r',event_id:'$e',input:{sender:'@a',content:{body:'hello'}}}
  const rpc = (action, fields) => {
    if (action === 'matrix.native.get') return { input, current:false }
    if (action === 'matrix.native.current') return false
    if (action === 'matrix.native.commit') {
      assert.match(fields.native_digest, /^[a-f0-9]{64}$/)
      assert.ok(fields.native_ref.includes('input'))
      commits++
    }
  }
  const commit = () => commitMatrixSource({ id:'s' }, row, {loadStored: async () => saved}, 'key', input, rpc)
  await assert.rejects(commit(), /physical/)
  saved = { meta:{id:'s'}, events:[{...row, data:{...row.data,id:'other'}}] }
  await assert.rejects(commit(), /physical/)
  saved.events = [row]
  await commit()
  assert.equal(commits, 1)
})
