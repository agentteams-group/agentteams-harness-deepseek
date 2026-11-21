import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'

export function recoveryCall(action, fields) {
  const child = spawnSync('python3', ['-m', 'task_recovery_rpc'], {
    input: JSON.stringify({ ...fields, action, runtime: 'deepseek-harness', device_delivery: true }),
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })
  if (child.error) throw child.error
  const response = JSON.parse(child.stdout)
  if (child.status !== 0) throw new Error(response.message || response.error || 'Worker recovery call failed')
  return response.value
}

export async function commitMatrixSource(session, event, persistence, eventKey, expected, rpc = recoveryCall) {
  // load() can return DSH's live session. loadStored() reads and decodes the
  // committed JSONL (including zstd/packed sessions) from physical storage.
  const physical = await persistence.loadStored(session.id)
  const row = physical?.events.find(record => record.seq === event.seq)
  if (physical?.meta.id !== session.id || row?.type !== 'user/message' || !isDeepStrictEqual(row.data, event.data)) {
    throw new Error('Missing matching physical DSH user message')
  }
  const snapshot = rpc('matrix.native.get', { event_key: eventKey })
  if (expected.room_id !== snapshot.input.room_id || expected.event_id !== snapshot.input.event_id ||
      !isDeepStrictEqual(expected.input, snapshot.input.input)) throw new Error('Matrix source changed during native persistence')
  const fields = { snapshot, native_ref: session.id + '/' + row.data.id,
    native_digest: createHash('sha256').update(JSON.stringify(row.data)).digest('hex') }
  if (!rpc('matrix.native.current', fields)) rpc('matrix.native.commit', { event_key: eventKey, ...fields })
}

export function checkExecution(identity, rpc = recoveryCall) {
  const message = Boolean(identity.event_key)
  const result = rpc(message ? 'matrix.message.current' : 'current', { identity })
  if (!message && (result.task.execution.state !== 'active' || result.task.execution.runtime !== 'deepseek-harness')) {
    throw new Error('Task execution lost ownership')
  }
  return result
}

export function installExecutionGuard(ctx, agent, identity, beforeRequest, rpc = recoveryCall) {
  const message = Boolean(identity.event_key)
  ctx.on('agent/request', async (_request, next) => {
    await beforeRequest()
    checkExecution(identity, rpc)
    return next()
  })
  if (!message) return
  // DSH can schedule independent tools concurrently. The shared execution has
  // a single in-flight operation, so reserve one before each top-level body.
  let queue = Promise.resolve()
  let active
  let uncertain
  ctx.on('tools/execute', (execution, next) => {
    if (execution.agent !== agent) throw new Error('Untracked nested Agent tool execution')
    if (execution.parent) {
      if (!active || execution.rootCallId !== active) throw new Error('Native tool parent lost ownership')
      return Promise.resolve().then(next).then(result => {
        if (!result || result.isError || execution.signal?.aborted) uncertain = true
        return result
      }, error => { uncertain = true; throw error })
    }
    const run = queue.then(async () => {
      await beforeRequest()
      const call = { id: execution.callId, name: execution.name, arguments: execution.arguments }
      const operation_id = rpc('matrix.message.begin_tools', { identity, calls: [call] })
      active = execution.rootCallId || call.id
      uncertain = false
      try {
        const result = await next()
        const rejectedWithoutEffect = call.name === 'mcp__teamharness__task' && result?.error?.info?.code === 'TASK_NO_EFFECT'
        if (uncertain || !result || (result.isError && call.name !== 'read' && !rejectedWithoutEffect) || execution.signal?.aborted || !Array.isArray(result.content)) {
          throw new Error('Native tool result is unconfirmed')
        }
        rpc('matrix.message.finish_tools', { identity, operation_id, results: [{ id: call.id, content: result.content, isError: result.isError === true }] })
        return result
      } finally {
        active = undefined
      }
    })
    queue = run.catch(() => {})
    return run
  })
}
