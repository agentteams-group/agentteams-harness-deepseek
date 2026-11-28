import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const activeTrace = new AsyncLocalStorage()
export const traceCarrier = () => activeTrace.getStore()?.carrier || {}
const now = () => Math.round((performance.timeOrigin + performance.now()) * 1e6)

export class NativeTrace {
  constructor(options) {
    this.options = options
    this.pending = new Map()
    this.captureContent = ['true', '1'].includes((process.env.AGENTTEAMS_OTEL_CAPTURE_CONTENT || 'true').toLowerCase())
    this.root = randomUUID()
    this.enabled = ['true', '1'].includes(process.env.AGENTTEAMS_OTEL_ENABLED?.toLowerCase())
  }

  async start() {
    if (!this.enabled) return
    this.child = spawn(process.env.AGENTTEAMS_TELEMETRY_PYTHON || '/opt/venv/agentteams/bin/python3',
      [fileURLToPath(new URL('./native-trace.py', import.meta.url))], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENTTEAMS_OTEL_RUNTIME: 'deepseek-harness' },
      })
    this.child.stderr.resume()
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const value = JSON.parse(line), pending = this.pending.get(value.id)
        if (pending) { this.pending.delete(value.id); pending.resolve(value) }
      } catch { this.disable() }
    })
    this.child.on('error', () => this.disable())
    this.child.on('exit', () => this.disable())
    this.child.stdin.on('error', () => this.disable())
    const response = await this.request({ operation: 'start', id: this.root, kind: 'turn', ...this.options })
    this.carrier = response.carrier || {}
  }

  disable() {
    if (this.enabled && !this.closed) process.stderr.write('[agentteams-telemetry] Native DSH trace export is unavailable\n')
    this.enabled = false
    for (const { resolve } of this.pending.values()) resolve({})
    this.pending.clear()
  }

  run(operation) {
    return activeTrace.run({ id: this.root, carrier: this.carrier || {} }, operation)
  }

  async request(value) {
    if (!this.enabled) return {}
    return new Promise(resolve => {
      const timeout = setTimeout(() => { this.disable(); this.child.kill() }, 5000)
      this.pending.set(value.id, { resolve: response => { clearTimeout(timeout); resolve(response) } })
      this.child.stdin.write(JSON.stringify(value) + '\n')
    })
  }

  async span(kind, name, fields = {}, attributes = {}, eventIds = [], input) {
    const id = randomUUID()
    const response = await this.request({ operation: 'start', id, kind, name, parent: this.root,
      fields, attributes, eventIds, ...(this.captureContent ? { input } : {}), timeNs: now() })
    return { id, carrier: response.carrier || {} }
  }

  async end(span, attributes = {}, error, output) {
    return this.request({ operation: 'end', id: span.id, attributes, ...(this.captureContent ? { output } : {}),
      ...(error ? { error: String(error.code || error.name || 'NativeFailure') } : {}), timeNs: now() })
  }

  install(ctx, state) {
    const telemetry = this
    ctx.on('llm/stream', (options, next) => (async function* () {
      const text = options.messages.filter(message => message.role === 'user').flatMap(message =>
        message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
      const eventIds = (state?.context.sources || []).filter(source => text.includes(`[Message ${source.eventId}]`)).map(source => source.eventId)
      const span = await telemetry.span('model', 'chat ' + options.model, {}, {
        'langfuse.observation.type': 'generation', 'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': options.provider, 'gen_ai.request.model': options.model,
      }, eventIds, options.messages)
      const output = []
      let usage, error, finish, iterator
      try {
        iterator = activeTrace.run(span, () => next()[Symbol.asyncIterator]())
        while (true) {
          const item = await activeTrace.run(span, () => iterator.next())
          if (item.done) break
          if (telemetry.captureContent) output.push(item.value)
          if (item.value.type === 'usage') usage = item.value.usage
          if (item.value.type === 'finish') finish = item.value.reason
          yield item.value
        }
      } catch (failure) { error = failure; throw failure }
      finally {
        let closeError
        try { await iterator?.return?.() } catch (failure) { closeError = failure }
        const attributes = {}
        if (usage) {
          attributes['gen_ai.usage.input_tokens'] = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
          attributes['gen_ai.usage.output_tokens'] = usage.outputTokens
          if (usage.cacheReadTokens !== undefined) attributes['gen_ai.usage.cache_read.input_tokens'] = usage.cacheReadTokens
          if (usage.cacheWriteTokens !== undefined) attributes['gen_ai.usage.cache_write.input_tokens'] = usage.cacheWriteTokens
        }
        if (finish?.kind) attributes['gen_ai.response.finish_reasons'] = [finish.kind]
        await telemetry.end(span, attributes, error || closeError || (finish?.kind === 'error' ? { code: finish.error?.code || 'NativeModelError' } : undefined), { stream: output })
        if (closeError && !error) throw closeError
      }
    })())
    ctx.on('tools/execute', async (execution, next) => {
      const span = await telemetry.span('tool', execution.name, {}, {
        'langfuse.observation.type': 'tool', 'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': execution.name, 'gen_ai.tool.call.id': execution.callId,
      }, [], execution.arguments)
      let error, output
      try {
        const result = await activeTrace.run(span, next)
        output = result
        if (result.isError) error = { code: result.error?.info?.code || 'NativeToolError' }
        return result
      } catch (failure) { error = failure; output = { error: { type: failure.name, message: failure.message } }; throw failure }
      finally { await telemetry.end(span, {}, error, output) }
    })
  }

  async close(error) {
    if (!this.child || this.closed) return
    await this.end({ id: this.root }, {}, error)
    await this.request({ operation: 'flush', id: randomUUID() })
    this.closed = true
    this.child.stdin.end()
  }
}
