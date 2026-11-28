import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { Config } from '@deepseek-ai/dsh-llm-pi-ai'

test('explicit Responses route uses the native adapter without DeepSeek-only fields', async () => {
  const source = await readFile(process.env.AGENTTEAMS_DSH_PATCH ?? new URL('../../plugins/teamharness/adapters/deepseek-harness/cordis.patch.yml', import.meta.url), 'utf8')
  const original = { ...process.env }
  try {
    Object.assign(process.env, { DSH_MODEL_API: 'openai-responses', TEAMHARNESS_DSH_MODEL: 'gateway-model', DEEPSEEK_BASE_URL: 'http://gateway.example/v1' })
    const rows = parse(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: expression => Function('ctx', 'return (' + expression + ')')({ headlessStartup: { task: 'fixture' } }) }] })
    const selected = rows.find(row => row.id === 'agent-default-model').config
    assert.equal(selected.provider, 'agentteams-gateway')
    assert.equal(selected.model, 'gateway-model')
    assert.equal(rows.find(row => row.id === 'llm-deepseek').disabled, true)
    const adapter = rows.find(row => row.id === 'llm-pi-ai')
    assert.equal(adapter.disabled, false)
    const config = Config(adapter.config)
    assert.equal(config.providers['agentteams-gateway'].api, 'openai-responses')
    assert.equal(config.providers['agentteams-gateway'].apiKeyEnv, 'DEEPSEEK_API_KEY')
    assert.equal(config.providers['agentteams-gateway'].models[0].id, selected.model)
    assert.equal(config.providers['agentteams-gateway'].thinking, undefined)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original)
  }
})

// Exercise the installed provider's actual HTTP serializer, not a hand-built payload.
// The local endpoint deliberately returns 400 after capturing the request; no model runs.
test('Responses wire keeps optional tool arguments optional with explicit non-strict tools', async () => {
  const { createServer } = await import('node:http')
  const { openAIResponsesApi } = await import('@earendil-works/pi-ai/api/openai-responses.lazy')
  const bodies = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    bodies.push(JSON.parse(Buffer.concat(chunks)))
    response.writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'Wire capture complete', type: 'invalid_request_error' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const source = await readFile(process.env.AGENTTEAMS_DSH_PATCH ?? new URL('../../plugins/teamharness/adapters/deepseek-harness/cordis.patch.yml', import.meta.url), 'utf8')
    const rows = parse(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: expression => Function('ctx', 'return (' + expression + ')')({ headlessStartup: { task: 'fixture' } }) }] })
    const route = rows.find(row => row.id === 'llm-pi-ai').config
    route.providers['agentteams-gateway'].models[0].id = 'fixture'
    const compat = Config(route).providers['agentteams-gateway'].models[0].compat
    const model = { id: 'fixture', name: 'Fixture', api: 'openai-responses', provider: 'fixture',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }
    const parameters = { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] }, justification: { type: 'string' } }, required: ['command', 'description'] }
    const context = { messages: [{ role: 'user', content: 'Inspect request serialization', timestamp: 0 }],
      tools: [{ name: 'bash', description: 'Native-style optional escalation arguments', parameters }] }
    for (const current of [model, { ...model, compat }]) {
      const result = await openAIResponsesApi().streamSimple(current, context, { apiKey: 'fixture', maxTokens: 32 }).result()
      assert.equal(result.stopReason, 'error')
    }
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0].tools[0].strict, undefined, 'baseline demonstrates the missing strict flag')
    assert.equal(bodies[1].tools[0].strict, false, 'Responses must receive an explicit non-strict declaration')
    assert.deepEqual(bodies[1].tools[0].parameters.required, ['command', 'description'])
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
