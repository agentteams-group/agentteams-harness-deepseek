import assert from 'node:assert/strict'
import test from 'node:test'
import { installExecutionGuard, commitMatrixSource } from '../plugins/teamharness/adapters/deepseek-harness/managed-native.js'

test('a failed receipt commit preserves the native return and fences queued tools and inference', async () => {
  for (const identity of [{event_key:'source'}, {task_id:'task',team_id:'team'}]) {
    const handlers = {}, agent = {}, actions = []
    const failure = new Error('Receipt connection unavailable')
    installExecutionGuard({on:(name, handler) => {handlers[name] = handler}}, agent, identity, async () => {}, (action) => {
      actions.push(action)
      if (action === 'admit_tools') return {task:{execution:{state:'active',runtime:'deepseek-harness'}}}
      if (action.endsWith('begin_tools')) return 'operation'
      if (action.endsWith('finish_tools')) throw failure
    })
    const original = {content:[{type:'text',text:'Original completed operation result'}],isError:false}
    let executions = 0
    const call = callId => handlers['tools/execute']({agent,callId,name:'external',arguments:{}}, async () => {
      executions++
      return original
    })
    const first = call('first')
    const queued = assert.rejects(call('queued'), error => error === failure)
    assert.equal(await first, original)
    await queued
    await assert.rejects(handlers['agent/request']({}, async () => assert.fail('must not infer')), error => error === failure)
    assert.equal(executions, 1)
    assert.equal(actions.filter(action => action.endsWith('begin_tools')).length, 1)
  }
})

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
  const failure = {isError: true, error:{message:'Upstream connection lost'},content: []}
  assert.deepEqual(await handlers['tools/execute']({agent, callId:'id', name:'write', arguments:{}}, async () => failure),failure)
  assert.deepEqual(actions, ['matrix.message.begin_tools'])
})

test('a registered file write precondition refusal is recorded without settling unknown writes', async () => {
  const handlers = {}, calls = [], receipts = [], agent = {}
  const fileWrite = {}
  let activeWrite = fileWrite
  const tools = { get: (name, scope) => name === 'write' ? (scope ? activeWrite : fileWrite) : undefined }
  installExecutionGuard({ on: (name, handler) => { handlers[name] = handler }, get: () => tools },
    agent, { event_key: 'source' }, async () => {}, (action, fields) => {
      if (action.endsWith('begin_tools')) { calls.push(fields.calls[0]); return fields.calls[0].id }
      if (action.endsWith('finish_tools')) receipts.push(fields.results[0])
    })
  const refused = { isError: true, error: { info: { code: 'FS_NOT_OBSERVED' } }, content: [] }
  const write = (callId, result, signal) => handlers['tools/execute'](
    { agent, callId, name: 'write', arguments: {}, signal }, async () => result)

  assert.deepEqual(await write('known', refused), refused)
  assert.deepEqual(calls[0].pre_effect_error_codes, ['FS_NOT_OBSERVED'])
  assert.deepEqual(receipts[0], { id: 'known', content: [], isError: true,
    status: 'error', effect: 'none', error_code: 'FS_NOT_OBSERVED' })
  const ambiguous = {isError:true,error:{message:'Unconfirmed native write'},content:[]}
  assert.deepEqual(await write('unknown', ambiguous),ambiguous)
  await assert.rejects(write('aborted', refused, AbortSignal.abort()), /unconfirmed/)
  activeWrite = {}
  assert.deepEqual(await write('shadowed', refused),refused)
  assert.equal(calls.at(-1).pre_effect_error_codes, undefined)
  assert.equal(receipts.length, 1)
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
  const read = {}
  installExecutionGuard({ on: (name, handler) => { handlers[name] = handler }, get: () => ({get: name => name === 'read' ? read : undefined}) }, agent, {event_key:'source'}, async () => {}, (action, fields) => {
    if (action.endsWith('begin_tools')) return fields.calls[0].id
    if (action.endsWith('finish_tools')) receipts.push(fields.results[0])
  })
  const error = {isError:true, content:[{type:'text',text:'File not found'}]}
  assert.deepEqual(await handlers['tools/execute']({agent,callId:'read-error',name:'read',arguments:{}}, async () => error), error)
  await handlers['tools/execute']({agent,callId:'next',name:'read',arguments:{}}, async () => ({content:[]}))
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].isError, true)
})

test('native image read failures settle without blocking alternatives or treating foreign tools as reads', async () => {
  for (const identity of [{event_key:'source'}, {task_id:'task',team_id:'team'}]) {
    const handlers = {}, receipts = [], agent = {}, native = {}
    let definition = native
    installExecutionGuard({on: (name, handler) => {handlers[name] = handler}, get: () => ({get: name => name === 'read_image' ? definition : undefined})},
      agent, identity, async () => {}, (action, fields) => {
        if (action === 'admit_tools') return {task:{execution:{state:'active',runtime:'deepseek-harness'}}}
        if (action.endsWith('begin_tools')) return fields.calls[0].id
        if (action.endsWith('finish_tools')) receipts.push(fields.results[0])
      })
    const failure = {isError:true,error:{message:'Current route does not accept image input'},content:[{type:'text',text:'Image input unavailable'}]}
    const call = (id, signal) => handlers['tools/execute']({agent,callId:id,name:'read_image',arguments:{},signal}, async () => failure)
    assert.equal(await call('image'),failure)
    assert.equal(receipts.length,1)
    assert.equal(receipts[0].status,'error')
    assert.equal(receipts[0].effect,undefined)
    await handlers['tools/execute']({agent,callId:'alternative',name:'browser-check',arguments:{}},async()=>({content:[]}))
    assert.equal(receipts.length,2)
    definition = {}
    await call('foreign')
    assert.equal(receipts.length,2)
    definition = native
    await assert.rejects(call('cancelled',AbortSignal.abort()),/unconfirmed/)
    assert.equal(receipts.length,2)
  }
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
  assert.deepEqual(await invoke('mcp__teamharness__task'),refusal)
  assert.equal(receipts.length, 0)
  assert.deepEqual(await invoke('external_tool'),refusal)
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
  assert.equal((await handlers['tools/execute']({agent,callId:'write',name:'write',arguments:{}},async()=>({isError:true,content:[]}))).isError,true)
  await assert.rejects(handlers['agent/request']({},async()=>{modelCalls++}),/unconfirmed/)
  assert.equal(modelCalls,0)
})


test('only a native non-widening sandbox denial can settle without an effect', async () => {
  const handlers = {}, agent = {}, bash = {}, receipts = [], calls = []
  let active = bash
  const tools = { get: name => name === 'bash' ? active : undefined }
  const policy = { resolve: () => ({ mode: 'workspace-write' }) }
  const ctx = { on: (name, handler) => { handlers[name] = handler },
    get: name => name === 'tools' ? tools : name === 'sandboxPolicy' ? policy : undefined }
  installExecutionGuard(ctx, agent, { event_key: 'input' }, async () => {}, (action, fields) => {
    if (action.endsWith('begin_tools')) { calls.push(fields.calls[0]); return fields.calls[0].id }
    if (action.endsWith('finish_tools')) receipts.push(...fields.results)
  })
  const message = 'sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "workspace-write" mode'
  const refused = { isError: true, error: { message }, content: [{ type: 'text', text: 'Error: ' + message }] }
  const run = (callId, result, signal) => handlers['tools/execute']({ agent, callId, name: 'bash',
    arguments: { sandbox_permissions: 'workspace-write', justification: 'same mode' }, signal }, async () => result)
  await run('refused', refused)
  assert.deepEqual(calls[0].pre_effect_error_codes, ['SANDBOX_ESCALATION_REJECTED'])
  assert.equal(receipts[0]?.effect, 'none')
  assert.equal(receipts[0]?.error_code, 'SANDBOX_ESCALATION_REJECTED')
  // A copied display string, a replaced definition and cancellation remain unknown.
  await run('display-only', { isError: true, content: refused.content })
  active = {}
  await run('shadowed', refused)
  active = bash
  await assert.rejects(run('cancelled', refused, AbortSignal.abort()), /unconfirmed/)
  assert.equal(receipts.length, 1)
})


test('a bound MCP server error is terminal without claiming no effects; transport errors remain fenced', async () => {
  const handlers = {}, receipts = [], agent = {}
  installExecutionGuard({ on: (name, handler) => { handlers[name] = handler } }, agent, {event_key:'source'}, async () => {}, (action, fields) => {
    if (action.endsWith('begin_tools')) return fields.calls[0].id
    if (action.endsWith('finish_tools')) receipts.push(fields.results[0])
  }, () => false, execution => execution.name === 'owned')
  const returned = {isError:true,error:{info:{code:'MCP_TOOL_RESULT_ERROR'}},content:[{type:'text',text:'Script failed after browser navigation'}]}
  const call = (name, result, signal) => handlers['tools/execute']({agent,callId:name,name,arguments:{},signal}, async () => result)
  await call('owned', returned)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].status, 'error')
  assert.equal(receipts[0].effect, undefined)
  await call('foreign', returned)
  await call('owned', {isError:true,error:{message:'Connection lost'},content:[]})
  await assert.rejects(call('owned', returned, AbortSignal.abort()), /unconfirmed/)
  assert.equal(receipts.length, 1)
})


test('a nested confirmed MCP error does not make its completed parent unknown', async () => {
  const handlers = {}, receipts = [], agent = {}
  installExecutionGuard({on: (name, handler) => { handlers[name] = handler }}, agent, {event_key:'source'}, async () => {}, (action, fields) => {
    if (action.endsWith('begin_tools')) return fields.calls[0].id
    if (action.endsWith('finish_tools')) receipts.push(fields.results[0])
  }, () => false, execution => execution.name === 'owned-mcp')
  await handlers['tools/execute']({agent,callId:'parent',name:'run_code',arguments:{}}, async () => {
    await handlers['tools/execute']({agent,callId:'child',rootCallId:'parent',parent:'token',name:'owned-mcp',arguments:{}}, async () => (
      {isError:true,error:{info:{code:'MCP_TOOL_RESULT_ERROR'}},content:[]}))
    return {content:[{type:'text',text:'handled server failure'}]}
  })
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].id, 'parent')
})
