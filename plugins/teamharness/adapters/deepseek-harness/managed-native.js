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
  const result = rpc(message ? 'matrix.message.current' : 'admit_tools', { identity })
  if (!message && (result.task.execution.state !== 'active' || result.task.execution.runtime !== 'deepseek-harness')) {
    throw new Error('Task execution lost ownership')
  }
  return result
}

export function installExecutionGuard(ctx, agent, identity, beforeRequest, rpc = recoveryCall, isCanonicalTask = () => false, isManagedMcp = () => false) {
  const message = Boolean(identity.event_key)
  const tools = ctx.get?.('tools')
  const fileWrite = tools?.get('write', agent)
  const nativeReadTools = new Map(['read', 'read_image'].map(name => [name, tools?.get(name, agent)]))
  const nativeSandboxTools = new Map(['bash', 'write', 'edit'].map(name => [name, tools?.get(name, agent)]))
  const sandboxPolicy = ctx.get?.('sandboxPolicy')
  const terminalMcpFailure = (execution, result) => result?.isError === true
    && ['MCP_TOOL_RESULT_ERROR', 'MCP_SESSION_EXPIRED', 'MCP_HTTP_ERROR'].includes(result.error?.info?.code) && isManagedMcp(execution)
  // A completed local reader can report validation/capability failures as a
  // plain Error. Bind to its native definition rather than parsing the text.
  const terminalReadFailure = (execution, result) => result?.isError === true
    && nativeReadTools.get(execution.name)
    && tools.get(execution.name, agent) === nativeReadTools.get(execution.name)
  // The native filesystem provider's typed failure is a completed local
  // operation. It may have partial effects; do not infer effect=none from it.
  const terminalFileFailure = (execution, result) => result?.isError === true
    && ['write', 'edit'].includes(execution.name) && nativeSandboxTools.get(execution.name)
    && tools.get(execution.name, agent) === nativeSandboxTools.get(execution.name)
    && result.error?.info?.name === 'FsError'
  let receiptFailure
  ctx.on('agent/request', async (_request, next) => {
    if (receiptFailure) throw receiptFailure
    await beforeRequest()
    checkExecution(identity, rpc)
    return next()
  })
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
        if (!result || (result.isError && !terminalMcpFailure(execution, result) && !terminalFileFailure(execution, result) && !terminalReadFailure(execution, result)) || execution.signal?.aborted) uncertain = true
        return result
      }, error => { uncertain = true; throw error })
    }
    const run = queue.then(async () => {
      if (receiptFailure) throw receiptFailure
      await beforeRequest()
      if (!message) checkExecution(identity, rpc)
      if (isCanonicalTask(execution)) return next()
      const call = { id: execution.callId, name: execution.name, arguments: execution.arguments }
      if (isManagedMcp(execution)) call.pre_effect_error_codes = ['MCP_SESSION_EXPIRED']
      // DSH's local writer refuses an unobserved overwrite before modifying the target.
      if (call.name === 'write' && fileWrite && tools.get(call.name, agent) === fileWrite) {
        call.pre_effect_error_codes = ['FS_NOT_OBSERVED']
      }
      // Native escalation validation/decisions happen before shell or file
      // dispatch. Bind refusals to the actual scoped body and native policy.
      const requestedMode = call.arguments?.sandbox_permissions
      const sandboxTool = nativeSandboxTools.get(call.name)
      const currentMode = sandboxPolicy?.resolve?.({ session: agent?.session })?.mode
      const sandboxRequest = sandboxTool && tools.get(call.name, agent) === sandboxTool
        && ['workspace-write', 'danger-full-access'].includes(requestedMode)
        && typeof call.arguments?.justification === 'string' && currentMode
      if (sandboxRequest) call.pre_effect_error_codes = [...(call.pre_effect_error_codes ?? []), 'SANDBOX_ESCALATION_REJECTED']
      const operation_id = rpc(message ? 'matrix.message.begin_tools' : 'begin_tools', { identity, calls: [call] })
      active = execution.rootCallId || call.id
      uncertain = false
      try {
        let result = await next()
        let code = result?.error?.info?.code
        const subject = call.name === 'bash' ? 'command' : 'operation'
        const refusalMessages = sandboxRequest ? [
          'invalid escalation: sandbox_permissions requires a justification',
          'invalid escalation: justification is only valid together with sandbox_permissions',
          'invalid justification: expected a non-empty sentence',
          `sandbox escalation to "${requestedMode}" is not strictly wider than this call's current "${currentMode}" mode`,
          `sandbox escalation to "${requestedMode}" requires approval, but no approval service is composed`,
          `sandbox escalation to "${requestedMode}" requires approval, but the call has no agent to route it through`,
          `the user rejected escalating this ${subject} to "${requestedMode}"`,
          `approval for escalating to "${requestedMode}" was cancelled`,
          `sandbox escalation to "${requestedMode}" requires approval, but no approval channel is available`,
        ] : []
        if (!code && refusalMessages.includes(result?.error?.message)) code = 'SANDBOX_ESCALATION_REJECTED'
        const refused = result?.isError === true && call.pre_effect_error_codes?.includes(code)
        const mcpFailure = terminalMcpFailure(execution, result)
        const fileFailure = terminalFileFailure(execution, result)
        const readFailure = terminalReadFailure(execution, result)
        if (uncertain || !result || (result.isError && !readFailure && !refused && !mcpFailure && !fileFailure)
            || execution.signal?.aborted || !Array.isArray(result.content)) {
          // Keep the native failure available in durable session history. The
          // outstanding operation still fences the next inference/tool request.
          if (result?.isError && Array.isArray(result.content) && !execution.signal?.aborted) return result
          throw new Error('Native tool result is unconfirmed')
        }
        if (code === 'SANDBOX_ESCALATION_REJECTED' && requestedMode === currentMode) {
          result = { ...result, content: [...result.content, { type: 'text', text:
            'This call did not execute. To use the existing permissions, omit sandbox_permissions and justification. '
            + 'Do not request broader access merely to correct this argument.' }] }
        }
        const receipt = { id: call.id, content: result.content, isError: result.isError === true }
        if (mcpFailure || fileFailure || readFailure) receipt.status = 'error'
        if (refused) Object.assign(receipt, { status: 'error', effect: 'none', error_code: code })
        try {
          rpc(message ? 'matrix.message.finish_tools' : 'finish_tools', { identity, operation_id, results: [receipt] })
        } catch (error) {
          // Let DSH persist the real tool/result before stopping the turn.
          // A receipt failure must neither replace that evidence nor permit
          // another tool/model request while Core still holds the operation.
          receiptFailure = error
        }
        return result
      } finally {
        active = undefined
      }
    })
    queue = run.catch(() => {})
    return run
  })
}
