import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { freezeMessage, MessageId, HarnessError } from '@deepseek-ai/dsh-llm'
import { matrixEventMessageId } from './message-id.js'
import { checkpointInput } from './session-receipt.js'
import { traceCarrier } from './native-trace.js'

const TASK = 'mcp__teamharness__task'
const NON_CANONICAL = new Set(['task', 'mcp__teamharness__taskflow', 'mcp__teamharness__projectflow', 'mcp__teamharness__filesync'])

export function nativeCall(payload, signal) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const name of ['traceparent', 'tracestate', 'baggage']) {
      const value = traceCarrier()[name]
      if (value) env['AT_OTEL_' + name.toUpperCase()] = value
    }
    const child = spawn(process.env.TEAMHARNESS_PYTHON || 'python3', [join(process.env.AGENTTEAMS_PLUGIN_DIR, 'mcp/common/task_native.py')],
      { signal, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => {
      try {
        const result = JSON.parse(output)
        if (code !== 0) {
          const failure = new Error(result.message || error || 'Native Task bridge failed')
          failure.effect = result.effect
          throw failure
        }
        resolve(result)
      } catch (failure) { reject(failure) }
    })
    child.stdin.on('error', reject)
    child.stdin.end(JSON.stringify(payload))
  })
}

export async function preparePublicTask(frame, call = nativeCall) {
  if (!frame) return undefined
  const context = { role: frame.role, sourceEvent: frame.meta.event_id,
    sources: frame.meta.event_id?.startsWith('$') ? await call({ operation: 'sources', meta: frame.meta }) : [] }
  const event = frame.meta.teamharness_coordination
  let phase
  if (event) {
    const current = { ...event }
    if (['handoff', 'task_submitted', 'main_task_ready'].includes(event.kind)) {
      phase = { eventId: event.id, nativeEventId: frame.meta.event_id }
      const admission = await call({ operation: 'admit_event', ...phase })
      if (admission.active !== true) return { context, phase, inactive: true }
      if (event.kind === 'handoff') current.pending_task_ids = admission.pending_task_ids
    }
    const prepared = await call({ operation: 'prepare_event', event: current })
    if (prepared.ok === false) {
      if (phase && prepared.retryable) await call({ operation: 'admit_event', ...phase, action: 'retry' })
      throw new Error('Public Task context is unavailable; no model turn was started')
    }
    Object.assign(context, prepared)
    if (event.kind === 'assistant_digest') return undefined
  }
  const state = { context, phase, pending: [], call }
  if (['manager', 'leader', 'team_leader'].includes(frame.role)) {
    context.roster = await call({ operation: 'roster', role: frame.role, ...(frame.role !== 'manager' ? { team: frame.team } : {}) })
  }
  if (frame.role === 'manager') {
    const key = createHash('sha256').update(frame.sessionId).digest('hex')
    state.deliveryPath = join(process.env.DSH_HOME || process.env.HOME, 'agentteams-context', key + '.json')
    state.middle = existsSync(state.deliveryPath) ? JSON.parse(readFileSync(state.deliveryPath, 'utf8')) : {}
    state.delivery = await call({ operation: 'delivery_context', room: frame.meta.room_id, middle: state.middle })
  }
  return state
}

export async function persistDeliveryContext(state, agent, sessions, persistence) {
  if (!state.delivery?.facts.length) return
  const id = MessageId(matrixEventMessageId('task-delivery:' + JSON.stringify(state.delivery.acknowledgements), 1))
  const message = freezeMessage({ id, role: 'user', source: { kind: 'plugin', plugin: 'agentteams.task-delivery' },
    content: [{ type: 'text', text: state.delivery.facts.join('\n\n') }] })
  const existing = agent.session.events.find(event => event.type === 'user/message' && event.data.id === id)
  if (existing && !isDeepStrictEqual(existing.data, message)) throw new Error('Native delivery context identity changed')
  if (!existing) agent.session.append('user/message', message, { surfaceOp: 'append' })
  await sessions.flush(agent.session)
  const saved = await persistence.loadStored(agent.session.id)
  if (!saved?.events.some(event => event.type === 'user/message' && isDeepStrictEqual(event.data, message))) {
    throw new Error('Native sent-delivery context is not durable')
  }
  const middle = await state.call({ operation: 'ack_delivery_context', middle: state.middle,
    acknowledgements: state.delivery.acknowledgements })
  await mkdir(join(state.deliveryPath, '..'), { recursive: true })
  await writeFile(state.deliveryPath + '.tmp', JSON.stringify(middle))
  await rename(state.deliveryPath + '.tmp', state.deliveryPath)
  state.delivery = undefined
}

export async function persistPhaseReceipt(state, agent, sessions, persistence) {
  if (!state.finalReceipt) return
  const id = MessageId(matrixEventMessageId('task-phase:' + state.phaseReceiptId, 1))
  const message = freezeMessage({ id, role: 'user', source: { kind: 'plugin', plugin: 'agentteams.task-phase' },
    content: [{ type: 'text', text: state.finalReceipt }] })
  const existing = agent.session.events.find(event => event.type === 'user/message' && event.data.id === id)
  if (existing && !isDeepStrictEqual(existing.data, message)) throw new Error('Native phase receipt changed')
  if (!existing) agent.session.append('user/message', message, { surfaceOp: 'append' })
  await sessions.flush(agent.session)
  const stored = await persistence.loadStored(agent.session.id)
  if (!stored?.events.some(event => event.type === 'user/message' && isDeepStrictEqual(event.data, message))) {
    throw new Error('Native completed Task receipt is not durable')
  }
}

export async function persistRefreshedInputs(state, agent, sessions, persistence) {
  if (!state.pending.length) return
  for (const source of state.pending) {
    const id = MessageId(matrixEventMessageId('task-refreshed-input:' + source.eventId, 1))
    const message = freezeMessage({ id, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: `[Message ${source.eventId}]\n${source.body}` }] })
    let row = agent.session.events.find(event => event.type === 'user/message' && event.data.id === id)
    if (row && !isDeepStrictEqual(row.data, message)) throw new Error('Native refreshed input identity changed')
    if (!row) row = agent.session.append('user/message', message, { surfaceOp: 'append' })
    await checkpointInput(agent.session, row, { id, eventId: source.eventId, roomId: source.roomId,
      workspace: process.env.HOME, flush: async session => {
        await sessions.flush(session)
        const stored = await persistence.loadStored(session.id)
        const saved = stored?.events.find(event => event.type === 'user/message' && event.data.id === id)
        if (!saved || !isDeepStrictEqual(saved.data, message)) throw new Error('Native refreshed Human input is not durable')
      } })
  }
  state.pending = []
  delete state.context.inputRefreshPending
}

export async function installPublicTask(agentCtx, state) {
  if (!state || state.inactive) return
  const tools = agentCtx.get('tools')
  const schema = await state.call({ operation: 'schema', role: state.context.role })
  const restrict = Boolean(state.context.planning || state.context.review || state.context.completion)
  const denied = tools.schemas().map(tool => tool.name).filter(name => name !== TASK && (restrict || NON_CANONICAL.has(name)))
  if (denied.length) tools.restrict({ deny: denied })
  const skill = readFileSync(join(process.env.AGENTTEAMS_PLUGIN_DIR, 'skills/team/task-management/SKILL.md'), 'utf8')
  const receipts = new Map()
  agentCtx.get('systemPrompt').section({ name: 'teamharness:public-task', order: 21,
    text: () => [`Use ${TASK} for the common Task operations described below.`, skill, state.context.fact,
      state.context.context ? JSON.stringify(state.context.context) : '',
      state.context.roster ? '[Registered public team identities]\n' + JSON.stringify(state.context.roster) : '',
      '[Task input references]\n' + JSON.stringify(state.context.sources), ...receipts.values()].filter(Boolean).join('\n\n') })
  const definition = { name: TASK, description: schema.description, parameters: schema.inputSchema,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(arguments_, execution) {
      let response
      try {
        response = await state.call({ operation: 'task', arguments: arguments_, context: state.context }, execution.signal)
      } catch (error) {
        if (error.effect === 'none') throw new HarnessError(error.message, 'TASK_NO_EFFECT')
        throw error
      }
      Object.assign(state.context, response.contextUpdate || {})
      state.pending.push(...(response.refreshedInputs || []))
      if (response.result.ok === false) throw new HarnessError(JSON.stringify(response.result),
        response.result.effect === 'none' ? 'TASK_NO_EFFECT' : 'TASK_UNKNOWN_EFFECT')
      if (response.fact) {
        receipts.set(response.receiptId || JSON.stringify(response.refreshedInputs.map(input => input.eventId)), response.fact)
      }
      if (response.phaseComplete === true) {
        state.finalReceipt = response.fact
        state.phaseReceiptId = response.receiptId
        execution.concludeTurn()
      }
      if (response.refreshedInputs?.length) return { ok: true, outcome: 'input_changed', noTaskRegistered: true, taskSystemContext: response.fact }
      return response.result
    },
  }
  state.nativeExecute = definition.execute
  tools.register(definition)
  agentCtx.on('agent/turn-stopping', async ({ agent }) => {
    await persistPhaseReceipt(state, agent, agentCtx.get('sessions'), agentCtx.get('sessionPersistence'))
  })
  agentCtx.on('agent/pre-step', async (request, next) => {
    const agent = request.agent || agentCtx.agent
    await persistRefreshedInputs(state, agent, agentCtx.get('sessions'), agentCtx.get('sessionPersistence'))
    await persistDeliveryContext(state, agent, agentCtx.get('sessions'), agentCtx.get('sessionPersistence'))
    return next()
  })
}
