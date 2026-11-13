import { randomUUID } from 'node:crypto'

const KEY = 'org.agentteams.approval'

/** Human replies stay bound to the owning Matrix turn, even during a blocked tool. */
export class MatrixInteractions {
  constructor({ url, token, room, sender, request = fetch }) {
    Object.assign(this, { url: url.replace(/\/$/, ''), token, room, sender, request })
  }

  async api(path, body, signal) {
    const response = await this.request(`${this.url}/_matrix/client/v3${path}`, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
    })
    if (!response.ok) throw new Error(`Matrix interaction HTTP ${response.status}`)
    return response.json()
  }

  send(content) {
    return this.api(`/rooms/${encodeURIComponent(this.room)}/send/m.room.message/${randomUUID()}`, content)
  }

  async wait(content, accept, signal) {
    const timeout = AbortSignal.timeout(300_000)
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
    let since = (await this.api('/sync?timeout=0', undefined, stop)).next_batch
    await this.send(content)
    while (!stop.aborted) {
      const batch = await this.api(`/sync?timeout=20000&since=${encodeURIComponent(since)}`, undefined, stop)
      since = batch.next_batch
      for (const event of batch.rooms?.join?.[this.room]?.timeline?.events ?? []) {
        if (event.type !== 'm.room.message' || event.sender !== this.sender) continue
        const result = accept(event.content ?? {})
        if (result !== undefined) return result
      }
    }
    throw stop.reason
  }

  async approval(req, id) {
    const call = req.agent.session.events.findLast(e => e.type === 'tool/call' && e.data.callId === req.callId)
    const data = {
      version: 1, runtime: 'deepseek-harness', request_id: id,
      context_id: randomUUID(), status: 'pending', tool_name: req.toolName,
      parameters: call?.data.arguments, risk_details: req.reason, expires_at: Date.now() + 300_000,
    }
    this.approvals.set(id, data)
    try {
      return await this.wait({ msgtype: 'm.text', body: `Tool approval: ${req.toolName}`, [KEY]: data }, content => {
        const text = (content.body ?? '').trim().replace(/^(?:@\S+\s+)+/, '')
        if (text === `/agentteams-approval approve ${id} ${data.context_id}`) return 'allowed-once'
        if (text === `/agentteams-approval deny ${id} ${data.context_id}`) return 'rejected'
      }, req.signal)
    } catch {
      return 'cancelled'
    }
  }

  async decided(id, outcome) {
    const data = this.approvals.get(id)
    if (!data) return
    this.approvals.delete(id)
    const status = { 'allowed-once': 'approved', rejected: 'rejected', cancelled: 'cancelled', unavailable: 'cancelled' }[outcome]
    await this.send({ msgtype: 'm.text', body: `Approval ${status}`, [KEY]: { ...data, status } })
  }

  async ask(req) {
    const id = randomUUID()
    const questions = req.questions.map(q => ({
      id: q.id, question: q.question, multi_select: q.multiSelect === true,
      options: q.options?.map(o => ({ id: o.label, label: o.label, description: o.description })),
    }))
    return this.wait({ msgtype: 'm.text', body: questions.map(q => q.question).join('\n'),
      'org.agentteams.run': { version: '1', blocks: [{ type: 'confirmation', tool_name: 'ask_human',
        confirmation_id: id, questions, requested_of: this.sender, expires_at: Date.now() + 300_000 }] },
    }, content => {
      const answer = content['com.agentteams.answer']
      if (answer?.confirmation_id !== id || !Array.isArray(answer.responses)) return
      if (answer.responses.length !== req.questions.length) return
      const answers = []
      for (const question of req.questions) {
        const response = answer.responses.find(r => r.id === question.id)
        if (!response || !Array.isArray(response.selected) || (!question.multiSelect && response.selected.length > 1)) return
        if (response.selected.some(value => !question.options?.some(o => o.label === value))) return
        if (!response.selected.length && !(typeof response.custom === 'string' && response.custom.trim())) return
        answers.push({ id: question.id, selected: response.selected, custom: response.custom })
      }
      return { answers }
    }, req.signal)
  }

  approvals = new Map()
  deliveries = new Set()

  async flush() {
    await Promise.all(this.deliveries)
  }
}

export function installMatrixInteractions(ctx, options) {
  const transport = new MatrixInteractions(options)
  ctx.on('approval/request', (req, next) => {
    const events = req.agent.session.events
    const decided = new Set(events.filter(e => e.type === 'approval/decided').map(e => e.data.id))
    const asked = events.filter(e => e.type === 'approval/asked' && !decided.has(e.data.id)
      && !transport.approvals.has(e.data.id) && e.data.toolName === req.toolName
      && e.data.callId === req.callId && e.data.reason === req.reason)
    // The native answerer API omits its audit ID. Ambiguous requests without
    // call IDs must fail closed rather than approving another concurrent call.
    return asked.length === 1 ? transport.approval(req, asked[0].data.id) : next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'approval/decided') {
      const delivery = transport.decided(event.data.id, event.data.outcome)
      transport.deliveries.add(delivery)
      void delivery.catch(error => console.error('Matrix approval receipt:', error.message))
    }
  })
  ctx.get('userQuestions')?.registerProvider({ ask: req => transport.ask(req) })
  return transport
}
