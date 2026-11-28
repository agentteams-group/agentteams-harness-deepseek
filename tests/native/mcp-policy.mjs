// Real MCP transport and DSH tool registry; no model or external credential.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { stringify } from 'yaml'
import { installExecutionGuard } from '../../plugins/teamharness/adapters/deepseek-harness/managed-native.js'
import * as managed from '../../plugins/teamharness/adapters/deepseek-harness/mcp-policy.js'
import { nativeServerName, installConfiguredMcp } from '../../plugins/teamharness/adapters/deepseek-harness/configured-mcp.js'

test('assigned MCP retains server policy for hashed names and reloads it before each call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-mcp-policy-'))
  const path = join(root, 'runtime.yaml')
  const previousCredential = process.env.DEEPSEEK_API_KEY
  const previousSourceCredential = process.env.AGENTTEAMS_WORKER_GATEWAY_KEY
  process.env.DEEPSEEK_API_KEY = 'fixture-projected-native-key'
  delete process.env.AGENTTEAMS_WORKER_GATEWAY_KEY
  const previous = process.env.TEAMHARNESS_RUNTIME_CONFIG
  process.env.TEAMHARNESS_RUNTIME_CONFIG = path
  const serverName = 'github-' + 'a'.repeat(42)
  const config = mode => stringify({ member: { runtime: 'deepseek-harness', runtimeName: 'dev' },
    desired: { mcpServers: [{ name: serverName, approvals: { tools: '*', mode } }] } })
  await writeFile(path, config('ask'))
  let effects = 0
  let serverFailure = false
  let transportFailure = false
  const mcp = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'record_delivery_' + 'b'.repeat(45), description: 'Fixture effect', inputSchema: { type: 'object', properties: {} } },
  ] }))
  mcp.setRequestHandler(CallToolRequestSchema, async () => {
    effects++
    if (serverFailure) return { isError: true, content: [{ type: 'text', text: 'Script failed after partial work' }] }
    return { content: [{ type: 'text', text: 'done' }] }
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'fixture-session' })
  await mcp.connect(transport)
  const http = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-projected-native-key')
      if (transportFailure === 'http') { response.writeHead(503).end(); return }
      if (transportFailure === 'disconnect') { request.socket.destroy(); return }
      let body = ''
      for await (const chunk of request) body += chunk
      await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined)
    } catch { response.writeHead(500).end() }
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
    let plugin
    const endpoint = `http://127.0.0.1:${http.address().port}`
    await installConfiguredMcp({ plugin: (...args) => { plugin = ctx.plugin(...args); return plugin } }, {
      credentials: { gatewayKeyEnv: 'AGENTTEAMS_WORKER_GATEWAY_KEY' },
      desired: { model: { gatewayUrl: endpoint }, mcpServers: [{ name: serverName, url: endpoint }] },
    })
    const tools = ctx.get('tools')
    const name = tools.schemas().find(tool => tool.name.startsWith('mcp__')).name
    assert.equal(name.length, 64)
    assert.ok(!name.startsWith(`mcp__${serverName}__`))
    const call = callId => tools.execute({ callId, name, arguments: {}, signal: new AbortController().signal })
    // No owning agent/approval surface: an explicit ask must fail closed.
    assert.equal((await call('requires-approval')).isError, true)
    assert.equal(effects, 0)
    await writeFile(path, config('allow'))
    const approved = await call('auto-approved')
    assert.equal(approved.isError, false, JSON.stringify(approved))
    assert.equal(effects, 1)
    await writeFile(path, config('ask'))
    assert.equal((await call('ask-again')).isError, true)
    assert.equal(effects, 1)
    await writeFile(path, config('allow'))
    const receipts = []
    let pending = false
    installExecutionGuard(ctx, undefined, {event_key: 'fixture'}, async () => {}, (action, fields) => {
      if (action.endsWith('begin_tools')) {
        assert.equal(pending, false)
        pending = true
        return fields.calls[0].id
      }
      if (action.endsWith('finish_tools')) {
        receipts.push(fields.results[0])
        pending = false
      }
    }, () => false, execution => managed.isManagedMcpTool(tools.get(execution.name, execution.agent)))
    serverFailure = true
    const failed = await call('server-error')
    assert.equal(failed.isError, true)
    assert.equal(failed.error.info?.code, 'MCP_TOOL_RESULT_ERROR', JSON.stringify(failed))
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].status, 'error')
    assert.equal(receipts[0].effect, undefined, 'failure can include partial effects')
    serverFailure = false
    assert.equal((await call('after-server-error')).isError, false)
    assert.equal(receipts.length, 2)
    transportFailure = 'http'
    const httpFailed = await call('returned-http-error')
    assert.equal(httpFailed.isError, true)
    assert.equal(httpFailed.error.info?.code, 'MCP_HTTP_ERROR')
    assert.equal(receipts.length, 3)
    assert.equal(receipts[2].status, 'error')
    assert.equal(receipts[2].effect, undefined, 'an HTTP error does not prove no partial effects')
    assert.equal(pending, false)
    transportFailure = 'disconnect'
    assert.equal((await call('lost-transport')).isError, true)
    assert.equal(receipts.length, 3, 'transport failure has no confirmed server terminal result')
    assert.equal(pending, true)
    await plugin.dispose()
  } finally {
    await ctx.registry.delete(ToolRuntime)
    await ctx.registry.delete(SystemPrompt)
    await mcp.close()
    await new Promise(resolve => http.close(resolve))
    if (previousCredential === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousCredential
    if (previousSourceCredential === undefined) delete process.env.AGENTTEAMS_WORKER_GATEWAY_KEY
    else process.env.AGENTTEAMS_WORKER_GATEWAY_KEY = previousSourceCredential
    if (previous === undefined) delete process.env.TEAMHARNESS_RUNTIME_CONFIG
    else process.env.TEAMHARNESS_RUNTIME_CONFIG = previous
    await rm(root, { recursive: true, force: true })
  }
})
