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

test('a returned read failure is recorded and can be followed by another native tool', async () => {
  const handlers = {}, receipts = [], agent = {}
  installExecutionGuard({ on: (name, handler) => { handlers[name] = handler } }, agent, {event_key:'source'}, async () => {}, (action, fields) => {
    if (action.endsWith('begin_tools')) return fields.calls[0].id
    if (action.endsWith('finish_tools')) receipts.push(fields.results[0])
  })
  const error = {isError:true, content:[{type:'text',text:'File not found'}]}
  assert.deepEqual(await handlers['tools/execute']({agent,callId:'read-error',name:'read',arguments:{}}, async () => error), error)
  await handlers['tools/execute']({agent,callId:'next',name:'read',arguments:{}}, async () => ({content:[]}))
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].isError, true)
})

test('a forged Task name and effect-free code cannot bypass a native journal', async () => {
  const handlers = {}, receipts = [], agent = {}
  installExecutionGuard({ on: (name, handler) => { handlers[name] = handler } }, agent, { event_key: 'source' }, async () => {}, (action, fields) => {
    if (action.endsWith('begin_tools')) return fields.calls[0].id
    if (action.endsWith('finish_tools')) receipts.push(fields.results[0])
  })
  const refusal = { isError: true, content: [{ type: 'text', text: 'Wrong Task identity; CLI not invoked' }],
    error: { info: { code: 'TASK_NO_EFFECT' } } }
  const invoke = name => handlers['tools/execute']({ agent, callId: name, name, arguments: {} }, async () => refusal)
  await assert.rejects(invoke('mcp__teamharness__task'), /unconfirmed/)
  assert.equal(receipts.length, 0)
  await assert.rejects(invoke('external_tool'), /unconfirmed/)
  assert.equal(receipts.length, 0)
})


test('Task execution admits the public checkpoint and journals business effects', async () => {
  const handlers = {}, actions = [], agent = {}
  const rpc = (action, fields) => {
    actions.push(action)
    if (action === 'admit_tools') return { task: { execution: { state: 'active', runtime: 'deepseek-harness' } } }
    if (action === 'begin_tools') return 'business-op'
    if (action === 'finish_tools') assert.equal(fields.operation_id, 'business-op')
  }
  installExecutionGuard({ on: (name, handler) => { handlers[name] = handler } }, agent,
    { task_id: 'own', team_id: 'team' }, async () => {}, rpc,
    execution => execution.nativeFixtureDefinition === true)
  await handlers['agent/request']({}, async () => actions.push('model'))
  await handlers['tools/execute']({agent,callId:'write',name:'write',arguments:{}}, async () => { actions.push('write'); return {content:[]} })
  await handlers['tools/execute']({agent,callId:'submit',name:'mcp__teamharness__task',arguments:{},nativeFixtureDefinition:true},
    async () => {actions.push('canonical'); return {content:[]} })
  assert.deepEqual(actions, ['admit_tools','model','admit_tools','begin_tools','write','finish_tools','admit_tools','canonical'])
})

test('uncertain Task business effects block the next model admission', async () => {
  const handlers = {}, agent = {}; let pending = false, modelCalls = 0
  const rpc = action => {
    if (action === 'admit_tools') {
      if (pending) throw new Error('unconfirmed operation')
      return {task:{execution:{state:'active',runtime:'deepseek-harness'}}}
    }
    if (action === 'begin_tools') { pending = true; return 'op' }
    assert.fail('Uncertain result must not finish')
  }
  installExecutionGuard({on:(name,handler)=>{handlers[name]=handler}},agent,{task_id:'own'},async()=>{},rpc)
  await assert.rejects(handlers['tools/execute']({agent,callId:'write',name:'write',arguments:{}},async()=>({isError:true,content:[]})),/unconfirmed/)
  await assert.rejects(handlers['agent/request']({},async()=>{modelCalls++}),/unconfirmed/)
  assert.equal(modelCalls,0)
})
