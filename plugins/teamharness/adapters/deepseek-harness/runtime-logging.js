// Keep native session metadata; your Python bridge redacts and stores it.
export function runtimeRecord(event) {
  const data = event.data ?? {}
  const fields = { turn: data.turn, step: data.step }
  if (event.type === 'request/header') return { event: 'model.begin', fields }
  if (event.type === 'assistant/message') return { event: 'model.end', fields }
  if (event.type === 'tool/call') {
    return { event: 'tool.begin', fields: { ...fields, item_id: data.callId, tool_name: data.name } }
  }
  if (event.type === 'tool/result') {
    const result = data.message?.content?.[0] ?? {}
    const failed = Boolean(result.isError || data.error)
    const error = failed ? (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 4096) : undefined
    return { event: 'tool.end', fields: { ...fields, item_id: result.toolCallId, status: failed ? 'failed' : 'completed', error, error_code: data.error?.code } }
  }
  if (event.type === 'turn/end' && data.reason?.kind === 'error') {
    return { event: 'turn.failed', fields: { ...fields, layer: 'agent_turn', error: data.reason.error?.message, error_code: data.reason.error?.code } }
  }
}
