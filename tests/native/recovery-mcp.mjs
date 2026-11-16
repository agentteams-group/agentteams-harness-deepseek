// Actual DSH subprocess scrubber and MCP transport; Task HTTP server is a fixture.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('native Task MCP retains supervisor ownership and credential-file scope after env scrubbing', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-mcp-'))
  const plugin = '/opt/agentteams/plugins/teamharness'
  const runtime = join(root, 'runtime.yaml')
  const token = join(root, 'token')
  await writeFile(token, 'native-fixture-token', { mode: 0o600 })
  await writeFile(runtime, await readFile(join(plugin, 'adapters/deepseek-harness/fixtures/runtime.yaml')))
  const execution = { instance_id: 'actual-native-start', process_id: 'supervisor-start', generation: 2,
    checkpoint: { version: 3, completed_steps: ['one'] } }
  const calls = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer native-fixture-token')
      assert.equal(request.headers['x-agentteams-process-id'], 'supervisor-start')
      calls.push(request.method)
      let result
      if (request.method === 'GET') {
        assert.equal(request.url, '/api/v1/tasks/recoverable')
        result = { instance_id: execution.instance_id, tasks: [{ team_id: 'dsh-smoke-team', etag: '"fixture-v1"',
          task: { task_id: 'stable', status: 'in_progress', execution } }] }
      } else {
        assert.equal(request.url, '/api/v1/tasks/stable/execution?team=dsh-smoke-team')
        assert.equal(request.headers['if-match'], '"fixture-v1"')
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks))
        assert.equal(body.action, 'checkpoint')
        assert.equal(body.process_id, execution.process_id)
        assert.equal(body.instance_id, execution.instance_id)
        assert.equal(body.checkpoint.version, 4)
        result = { execution: { ...execution, checkpoint: body.checkpoint } }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  Object.assign(process.env, { AGENTTEAMS_PROCESS_ID: execution.process_id, AGENTTEAMS_AUTH_TOKEN_FILE: token,
    AGENTTEAMS_CONTROLLER_URL: `http://127.0.0.1:${server.address().port}`, AGENTTEAMS_AGENT_ROLE: 'worker',
    AGENTTEAMS_PLUGIN_DIR: plugin, TEAMHARNESS_WORKSPACE: root, TEAMHARNESS_RUNTIME_CONFIG: runtime,
    TEAMHARNESS_PYTHON: '/usr/bin/python3', PYTHONPATH: '/opt/agentteams/scripts/lib' })
  // Use the real adapter's explicit env and the SDK's real scrubber, exactly
  // as its stdio factory does. Credential-shaped file paths are scrubbed too.
  assert.equal(scrubbedParentEnv().AGENTTEAMS_AUTH_TOKEN_FILE, undefined)
  const config = await readFile(join(plugin, 'adapters/deepseek-harness/cordis.patch.yml'), 'utf8')
  const envYaml = config.split('        env:\n')[1].split('        failOnStartupError:')[0]
  const env = parse(envYaml, { customTags: [{ tag: 'tag:yaml.org,2002:js',
    resolve: expression => Function('process', `return (${expression})`)(process) }] })
  const transport = new StdioClientTransport({ command: process.env.TEAMHARNESS_PYTHON, args: ['mcp/server.py'],
    cwd: plugin, env: { ...scrubbedParentEnv(), ...env } })
  const client = new Client({ name: 'recovery-native-scope-test', version: '1' })
  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'taskflow', arguments: { action: 'checkpoint_task',
      payload: { task_id: 'stable', checkpoint: { version: 4, completed_steps: ['one'], remaining_steps: ['two'] } } } }, undefined, { timeout: 10000 })
    const body = JSON.parse(result.content.find(item => item.type === 'text').text)
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.synced, true)
    assert.equal(body.execution.checkpoint.version, 4)
    assert.deepEqual(calls, ['GET', 'POST'])
  } finally {
    await client.close()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
