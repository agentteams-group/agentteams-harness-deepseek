import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { matrixEventMessageId } from './message-id.js'
import { executeAttempt } from './turn.js'
import { openSteering } from './steering.js'
import { checkpointInput } from './session-receipt.js'
import { installMatrixInteractions } from './matrix-interactions.js'
import { runtimeRecord } from './runtime-logging.js'
import { checkExecution, commitMatrixSource, installExecutionGuard, recoveryCall } from './managed-native.js'
import { bindNativeTaskHistory, installPublicTask, preparePublicTask } from './public-task.js'
import { NativeTrace } from './native-trace.js'
import { progressRunId } from './matrix-progress.js'


export const name = 'agentteams-headless-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'sessionPersistence']

export const Config = z.object({
  task: z.string().required(),
  sessionId: z.string().default(''),
  resume: z.boolean().default(false),
  eventId: z.string().default(''),
  attempt: z.number().step(1).min(1).default(1),
})

function messageId(eventId, attempt) {
  if (!eventId) return MessageId(randomUUID())
  return MessageId(matrixEventMessageId(eventId, attempt))
}
function userMessage(task, id, source = { kind: 'user' }) {
  return freezeMessage({
    id,
    role: 'user',
    content: [{ type: 'text', text: task }],
    source,
  })
}

async function openAgent(ctx, sessionId, resume, selection, publicTask) {
  const options = {
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await installPublicTask(agentCtx, publicTask)
    },
  }
  const agents = ctx.get('agents')
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('agentteams-headless-runner: sessionPersistence is required')
  }
  const header = (await persistence.list()).find(header => header.id === sessionId)
  const cwd = publicTask?.context.execution ? publicTask.context.context.outputDirectory : process.cwd()
  const persisted = Boolean(header)
  if (persisted && header.cwd !== cwd) {
    const error = new Error('Native Task session has a different authoritative output directory')
    error.code = 'AGENTTEAMS_SESSION_MISSING'
    throw error
  }
  if (persisted) {
    return agents.resume({ ...options, resumeSessionId: sessionId })
  }
  if (resume) {
    const error = new Error(`requested resume for missing DSH session ${sessionId}`)
    error.code = 'AGENTTEAMS_SESSION_MISSING'
    throw error
  }
  return agents.create({ ...options, sessionId, meta: { cwd } })
}

async function run(ctx, config, io) {
  await ctx.get('loader')?.await()
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  if (defaultModel === undefined || sessions === undefined || agents === undefined) return

  let interactions
  if (process.env.TEAMHARNESS_MATRIX_ROOM_ID && process.env.TEAMHARNESS_MATRIX_SENDER) {
    interactions = installMatrixInteractions(ctx, {
      url: process.env.AGENTTEAMS_MATRIX_URL,
      token: process.env.AGENTTEAMS_WORKER_MATRIX_TOKEN,
      room: process.env.TEAMHARNESS_MATRIX_ROOM_ID,
      sender: process.env.TEAMHARNESS_MATRIX_SENDER,
      admin: process.env.AGENTTEAMS_ADMIN_USER?.startsWith('@')
        ? process.env.AGENTTEAMS_ADMIN_USER
        : process.env.AGENTTEAMS_ADMIN_USER && process.env.AGENTTEAMS_MATRIX_DOMAIN
          ? `@${process.env.AGENTTEAMS_ADMIN_USER}:${process.env.AGENTTEAMS_MATRIX_DOMAIN}` : undefined,
    })
  }

  const selection = defaultModel.currentSelection()
  const sessionId = SessionId(config.sessionId || `session-${randomUUID()}`)
  const identity = JSON.parse(process.env.TEAMHARNESS_EXECUTION_IDENTITY || 'null')
  const frame = JSON.parse(process.env.TEAMHARNESS_NATIVE_TASK_CONTEXT || 'null')
  if (frame) {
    frame.sessionId = sessionId
    frame.team = parse(readFileSync(process.env.TEAMHARNESS_RUNTIME_CONFIG, 'utf8')).team?.name
  }
  if (frame && !frame.meta.teamharness_coordination && identity?.task_id && process.env.TEAMHARNESS_DSH_ATTACH_ONLY !== 'true') {
    const current = checkExecution(identity).task
    if (current.task_plan_id) frame.meta.teamharness_coordination = { kind: 'task_assigned', task_id: current.task_id,
      main_task_id: current.main_task_id, project_id: current.project_id || '', delivery_id: current.notifyTxn }
  }
  const trace = new NativeTrace({ sessionId, metadata: { room_id: frame?.meta.room_id || process.env.TEAMHARNESS_MATRIX_ROOM_ID,
    event_id: frame?.meta.event_id || config.eventId, task_id: identity?.task_id || frame?.meta.teamharness_coordination?.task_id,
    main_task_id: frame?.meta.teamharness_coordination?.main_task_id, team_id: identity?.team_id || process.env.AGENTTEAMS_TEAM_NAME,
    execution_generation: identity?.generation }, carrier: frame?.meta.otel_carrier || {},
    fields: { ...(frame?.meta.teamharness_coordination ? {
      'agentteams.coordination.id': frame.meta.teamharness_coordination.id,
      'agentteams.coordination.kind': frame.meta.teamharness_coordination.kind,
    } : {}) } })
  await trace.start()
  try {
    const publicTask = process.env.TEAMHARNESS_DSH_ATTACH_ONLY === 'true' ? undefined : await trace.run(() => preparePublicTask(frame))
    const generation = publicTask?.context.context?.generation
    if (Number.isInteger(generation) && generation > 0 && !identity) {
      await trace.request({ operation: 'enrich', id: trace.root, fields: { 'agentteams.execution.generation': generation } })
    }
    trace.install(ctx, publicTask)
    if (publicTask?.inactive) {
      await trace.close()
      io.stdout.write('NO_REPLY\n')
      io.exit(0)
      return
    }
    const { agent } = await trace.run(() => openAgent(ctx, sessionId, config.resume, selection, publicTask))
    bindNativeTaskHistory(publicTask, agent.session)
    if (frame?.meta.teamharness_coordination?.kind !== 'assistant_digest') {
      interactions?.bindProgress(agent.session, progressRunId(identity, process.env.TEAMHARNESS_MATRIX_ROOM_ID, config.eventId))
    }
    await agent.whenIdle()
    // Reconcile explicitly selected platform permissions on resumed sessions too.
    if (process.env.DSH_PERMISSION_MODE) {
      ctx.get('permissionPresets').set(agent.session, process.env.DSH_PERMISSION_MODE)
    }

    const sourceKey = process.env.TEAMHARNESS_MATRIX_SOURCE_KEY
    if (identity && sourceKey) {
      const source = recoveryCall('matrix.native.get', { event_key: sourceKey }).input
      const current = checkExecution(identity)
      if (identity.event_key ? identity.event_key !== sourceKey :
          source.work?.task_id !== identity.task_id || source.work?.team_id !== identity.team_id ||
          source.room_id !== current.task.room_id) throw new Error('Matrix source belongs to a different execution')
      const body = source.input
      if (source.room_id !== process.env.TEAMHARNESS_MATRIX_ROOM_ID || source.event_id !== process.env.TEAMHARNESS_SOURCE_EVENT_ID ||
          body.sender !== process.env.TEAMHARNESS_MATRIX_SENDER) throw new Error('Unmatched Matrix source')
      const native = userMessage(JSON.stringify({ room_id: source.room_id, event_id: source.event_id, ...body }), messageId('agentteams-source-v1:' + source.event_id, 1),
        { kind: 'plugin', plugin: 'agentteams.matrix-source' })
      const existing = agent.session.events.find(event => event.type === 'user/message' && event.data.id === native.id)
      if (existing && JSON.stringify(existing.data.content) !== JSON.stringify(native.content)) throw new Error('Different native Matrix source')
      if (!existing) agent.session.append('user/message', native, { surfaceOp: 'append' })
      const row = existing || agent.session.events.at(-1)
      await checkpointInput(agent.session, row, {
        id: native.id, eventId: source.event_id, roomId: source.room_id, workspace: process.env.HOME,
        flush: async session => {
          await sessions.flush(session)
          await commitMatrixSource(session, row, ctx.get('sessionPersistence'), sourceKey, source)
        },
      })
      if (process.env.TEAMHARNESS_DSH_ATTACH_ONLY === 'true') {
        await trace.close()
        io.stdout.write('attached\n')
        io.exit(0)
        return
      }
    }
    const id = messageId(config.eventId, config.attempt)
    const receipt = {
      id, eventId: config.eventId, roomId: process.env.TEAMHARNESS_MATRIX_ROOM_ID,
      workspace: process.env.HOME, flush: async session => {
        await sessions.flush(session)
        const saved = await ctx.get('sessionPersistence').loadStored(session.id)
        const expected = session.events.find(event => event.type === 'user/message' && event.data.id === id)
        const physical = saved?.events.find(event => event.type === 'user/message' && event.data.id === id)
        if (!physical || !isDeepStrictEqual(physical.data, expected?.data)) throw new Error('Native Matrix input is not durable')
      },
      sourceEventIds: JSON.parse(process.env.TEAMHARNESS_SESSION_SOURCE_EVENT_IDS || '[]'),
    }
    let receiptCheckpoint = Promise.resolve()
    if (identity) installExecutionGuard(ctx, agent, identity, () => receiptCheckpoint, recoveryCall,
      execution => Boolean(publicTask?.nativeExecute) && ctx.get('tools').get(execution.name, agent)?.execute === publicTask.nativeExecute)
    else ctx.on('agent/request', async (_request, next) => { await receiptCheckpoint; return next() })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && process.env.AGENTTEAMS_LOG_CAPTURED === '1') {
        const record = runtimeRecord(event)
        if (record) io.stderr.write('[agentteams-native-event] ' + JSON.stringify(record) + '\n')
      }
      if (identity || session !== agent.session || event.type !== 'user/message' || event.data.id !== id) return
      receiptCheckpoint = Promise.resolve().then(() => checkpointInput(session, event, receipt))
      return receiptCheckpoint
    })
    const existingInput = agent.session.events.find(event => event.type === 'user/message' && event.data.id === id)
    if (existingInput && !identity) await checkpointInput(agent.session, existingInput, receipt)
    const steering = await openSteering(process.env.TEAMHARNESS_DSH_CONTROL_SOCKET, agent, {
      message: request => userMessage(request.body, messageId(request.event_id, 1)),
      flush: () => sessions.flush(agent.session),
      beforeSteer: async request => {
        if (!request.source_key) return
        const source = recoveryCall('matrix.native.get', { event_key: request.source_key }).input
        if (source.room_id !== process.env.TEAMHARNESS_MATRIX_ROOM_ID ||
            source.input.sender !== process.env.TEAMHARNESS_MATRIX_SENDER ||
            source.event_id !== request.event_id) throw new Error('Steering source changed')
        const native = userMessage(JSON.stringify(source), messageId('agentteams-source-v1:' + request.event_id, 1),
          { kind: 'plugin', plugin: 'agentteams.matrix-source' })
        if (!agent.session.events.some(event => event.type === 'user/message' && event.data.id === native.id)) {
          agent.session.append('user/message', native, { surfaceOp: 'append' })
        }
        const row = agent.session.events.find(event => event.type === 'user/message' && event.data.id === native.id)
        await sessions.flush(agent.session)
        await commitMatrixSource(agent.session, row, ctx.get('sessionPersistence'), request.source_key, source)
      },
    })
    let outcome
    try {
      outcome = await trace.run(() => executeAttempt({
        getEvents: () => agent.session.events,
        id,
        firstSeq: agent.session.seq,
        eventId: config.eventId,
        followup: () => agent.followup(userMessage((frame?.meta.event_id?.startsWith('$') ? `[Message ${frame.meta.event_id}]\n` : '') + config.task, id)),
        whenIdle: () => agent.whenIdle(),
        flush: () => sessions.flush(agent.session),
      }))
    } finally {
      await steering.close()
    }

    await receiptCheckpoint.catch(() => {})
    await interactions?.flush()
    io.stdout.write((publicTask?.displayText ?? outcome?.text ?? '') + '\n')
    if (outcome?.reason?.kind === 'error') {
      io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
    }
    await trace.close(outcome?.reason?.kind === 'error' ? { code: outcome.reason.error.code } : undefined)
    io.exit(outcome?.reason?.kind === 'completed' ? 0 : 1)
  } catch (error) {
    await interactions?.flush()
    await trace.close(error)
    throw error
  }
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('agentteams-headless-runner: ctx.appExit is required')
  }
  const io = { stdout: process.stdout, stderr: process.stderr, exit }
  void run(ctx, config, io).catch((error) => {
    io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(error?.code === 'AGENTTEAMS_SESSION_MISSING' ? 75 : 1)
  })
}
