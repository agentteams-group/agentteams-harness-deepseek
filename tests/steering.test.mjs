import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSteering } from '../plugins/teamharness/adapters/deepseek-harness/steering.js'

test('native steering is ordered, persisted and deduplicated without cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'at-steer-'))
  const path = join(directory, 'control.sock')
  const received = []
  let flushed = 0
  const persistedSources = []
  const agent = { status: 'running', steer: message => received.push(message) }
  const server = await openSteering(path, agent, {
    message: request => ({ id: request.event_id, text: request.body }),
    flush: async () => { flushed++ },
    beforeSteer: async request => {
      persistedSources.push(request.event_id)
      if (request.event_id === '$race') agent.status = 'idle'
    },
  })
  const send = request => new Promise((resolve, reject) => {
    const socket = connect(path)
    let response = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', part => { response += part })
    socket.on('end', () => resolve(JSON.parse(response)))
  })
  try {
    for (const event_id of ['$one', '$two', '$one']) {
      assert.deepEqual(await send({ event_id, body: event_id }), { accepted: true })
    }
    assert.deepEqual(received, [{ id: '$one', text: '$one' }, { id: '$two', text: '$two' }])
    assert.equal(flushed, 2)
    assert.deepEqual(persistedSources, ['$one', '$two'])
    assert.deepEqual(await send({ event_id: '$race', body: 'persisted before native completion' }), { accepted: false })
    assert.equal(flushed, 2)
    assert.deepEqual(persistedSources, ['$one', '$two', '$race'])
    agent.status = 'idle'
    assert.deepEqual(await send({ event_id: '$late', body: 'late' }), { accepted: false })
    assert.equal(received.length, 2)
  } finally {
    await server.close()
    await rm(directory, { recursive: true })
  }
})
