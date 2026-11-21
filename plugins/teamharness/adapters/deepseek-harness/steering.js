import { createServer } from 'node:net'

// The bridge owns the private socket directory and authenticates Matrix controls.
// A receipt means the native inbox was flushed, not that a tool was cancelled.
export async function openSteering(path, agent, { message, flush, beforeSteer = async () => {} }) {
  if (!path) return { close: async () => {} }
  const accepted = new Map()
  let pending = Promise.resolve()
  const server = createServer(socket => {
    let input = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      input += chunk
      if (!input.includes('\n')) return
      socket.pause()
      pending = pending.catch(() => {}).then(async () => {
        const request = JSON.parse(input.slice(0, input.indexOf('\n')))
        if (typeof request.event_id !== 'string' || typeof request.body !== 'string' || !request.body.trim()) {
          throw new Error('Invalid steering input')
        }
        if (accepted.has(request.event_id)) {
          if (accepted.get(request.event_id) !== request.body) throw new Error('Steering event changed')
          return true
        }
        if (agent.status === 'idle') return false
        await beforeSteer(request)
        agent.steer(message(request))
        await flush()
        accepted.set(request.event_id, request.body)
        return true
      })
      pending.then(ok => socket.end(JSON.stringify({ accepted: ok }) + '\n'),
        error => socket.end(JSON.stringify({ error: String(error) }) + '\n'))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  return { close: async () => {
    await new Promise(resolve => server.close(resolve))
    await pending.catch(() => {})
  } }
}
