import { recoveryCall } from './managed-native.js'

export function progressRunId(identity, room, eventId) {
  if (identity?.task_id) return recoveryCall('task_run_id', identity)
  if (identity?.event_key) return `deepseek:message:${identity.event_key}:${identity.generation}`
  return `deepseek:message:${room}:${eventId}`
}

/** Display native events through the shared run-block contract, never as agent input. */
export class MatrixProgress {
  constructor(transport, session, runId, taskPhase) {
    Object.assign(this, { transport, session, runId, taskPhase })
    this.closed = false
    this.calls = new Map()
    this.queue = Promise.resolve()
    this.secrets = [transport.token, ...Object.entries(process.env)
      .filter(([key]) => /(?:TOKEN|PASSWORD|API_KEY|SECRET)$/.test(key)).map(([, value]) => value)]
      .filter(value => typeof value === 'string' && value.length >= 8)
  }

  safe(value, key = '') {
    if (/(?:^|_)(?:token|password|api_key|secret|authorization)$/i.test(key)) return '[REDACTED]'
    if (Array.isArray(value)) return value.map(item => this.safe(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.safe(item, name)]))
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object') return JSON.stringify(this.safe(parsed))
      } catch {}
      for (const secret of this.secrets) value = value.split(secret).join('[REDACTED]')
      return value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
        .replace(/((?:access_token|api_key|apiKey|password|secret|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"[REDACTED]"')
        .replace(/(https?:\/\/)[^/\s@]+@/g, '$1[REDACTED]@')
    }
    return value
  }

  bounded(value) {
    const safe = this.safe(value), text = JSON.stringify(safe)
    const bytes = Buffer.from(text)
    return bytes.length > 4096 ? { preview: bytes.subarray(0, 4093).toString('utf8').replace(/\uFFFD$/, '') + '…', truncated: true } : safe
  }

  observe(session, event) {
    if (session !== this.session) return
    this.queue = this.queue.then(() => this.publish(event)).catch(error => {
      console.error('Matrix native progress delivery failed:', error.message)
    })
  }

  async send(block, previous) {
    // DSH is a raw Matrix client: never leak progress if room encryption changes.
    try {
      await this.transport.api(`/rooms/${encodeURIComponent(this.transport.room)}/state/m.room.encryption/`)
      throw new Error('Native progress requires an unencrypted Matrix room')
    } catch (error) {
      if (error.status !== 404 || error.code !== 'M_NOT_FOUND') throw error
    }
    const content = { msgtype: 'm.notice', body: block.type === 'thinking' ? block.content : block.tool_name ? `${block.tool_name} · ${block.status}` : '执行过程',
      'org.agentteams.progress_only': true, 'm.mentions': { user_ids: [] },
      'org.agentteams.run': { version: '1', run_id: this.runId, blocks: [block] } }
    return this.transport.send(previous ? { ...content, 'm.new_content': content,
      'm.relates_to': { rel_type: 'm.replace', event_id: previous } } : content)
  }

  async finish(kind) {
    if (this.closed) return
    await this.send({ type: 'error', kind, title: { quiet: '已处理', failed: '执行失败', cancelled: '已停止' }[kind] })
    this.closed = true
  }

  async publish({ type, data }) {
    if (type === 'turn/end') {
      const kind = data.reason?.kind === 'completed' ? 'quiet' : data.reason?.kind === 'error' ? 'failed' : 'cancelled'
      await this.finish(kind)
    } else if (type === 'assistant/message') {
      const summary = (data.message?.content ?? []).filter(block => block.type === 'reasoning' && block.text)
        .map(block => block.text).join('\n\n')
      if (summary) await this.send({ type: 'thinking', content: this.safe(summary).slice(0, 4096) })
    } else if (type === 'tool/call' && !this.calls.has(data.callId)) {
      let args
      try { args = JSON.parse(data.arguments) } catch { args = { raw: data.arguments } }
      const block = { type: 'tool_call', tool_name: data.name, tool_call_id: data.callId,
        arguments: this.bounded(args && typeof args === 'object' && !Array.isArray(args) ? args : { value: args }),
        status: 'running', started_at: Date.now() }
      const receipt = await this.send(block)
      this.calls.set(data.callId, { block, eventId: receipt.event_id })
    } else if (type === 'tool/result') {
      for (const result of data.message?.content ?? []) {
        const call = this.calls.get(result.toolCallId)
        if (!call || result.type !== 'tool-result') continue
        await this.send({ ...call.block, status: result.isError ? 'failed' : 'succeeded',
          result: this.bounded(result.content), finished_at: Date.now() }, call.eventId)
      }
    }
  }
}
