// Exercise real DSH reconnect, real HTTP MCP sessions, and owned tool receipts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
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
import { installConfiguredMcp } from '../../plugins/teamharness/adapters/deepseek-harness/configured-mcp.js'
import { isManagedMcpTool } from '../../plugins/teamharness/adapters/deepseek-harness/mcp-policy.js'

test('an expired session is reinitialized and the rejected call never executes twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'at-session-reset-'))
  const previous = { runtime: process.env.TEAMHARNESS_RUNTIME_CONFIG, key: process.env.DEEPSEEK_API_KEY }
  process.env.TEAMHARNESS_RUNTIME_CONFIG = join(root, 'runtime.yaml')
  process.env.DEEPSEEK_API_KEY = 'fixture-key'
  await writeFile(process.env.TEAMHARNESS_RUNTIME_CONFIG, stringify({ member: { runtime:'deepseek-harness', runtimeName:'dev' }, desired:{ mcpServers:[{name:'browser',approvals:{tools:'*',mode:'allow'}}] }}))
  const sessions = new Map(), servers = [], receipts = []
  let effects = 0, rejected = 0, initialized = 0
  async function newSession() {
    initialized++
    const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}})
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'navigate',description:'Local fixture navigation',inputSchema:{type:'object',properties:{}}}]}))
    server.setRequestHandler(CallToolRequestSchema,async()=>{effects++;return {content:[{type:'text',text:'navigated'}]}})
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID()})
    servers.push(server);await server.connect(transport)
    return transport
  }
  const http = createServer(async(request,response)=>{
    try {
      let body='';for await(const chunk of request)body+=chunk
      const message=body?JSON.parse(body):undefined
      const id=request.headers['mcp-session-id']
      let transport=sessions.get(id)
      if (id && !transport) {if(message?.method==='tools/call')rejected++;response.writeHead(404).end('Session not found');return}
      if (!transport && message?.method==='initialize')transport=await newSession()
      if (!transport) {response.writeHead(400).end();return}
      await transport.handleRequest(request,response,message)
      if(transport.sessionId)sessions.set(transport.sessionId,transport)
    } catch {if(!response.headersSent)response.writeHead(500);response.end()}
  })
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve))
  const ctx=new Context()
  let plugin
  try {
    await ctx.plugin(SystemPrompt).await();await ctx.plugin(ToolRuntime,{mode:'native'}).await()
    const endpoint=`http://127.0.0.1:${http.address().port}`
    await installConfiguredMcp({plugin:(...args)=>{plugin=ctx.plugin(...args);return plugin}},{desired:{model:{gatewayUrl:endpoint},mcpServers:[{name:'browser',url:endpoint}]}})
    const tools=ctx.get('tools'), name=tools.schemas().find(t=>t.name.startsWith('mcp__')).name
    let pending=false
    installExecutionGuard(ctx,undefined,{event_key:'fixture'},async()=>{},(action,fields)=>{
      if(action.endsWith('begin_tools')){assert.equal(pending,false);pending=true;return fields.calls[0].id}
      if(action.endsWith('finish_tools')){receipts.push(fields.results[0]);pending=false}
    },()=>false,execution=>isManagedMcpTool(tools.get(execution.name,execution.agent)))
    const call=callId=>tools.execute({callId,name,arguments:{},signal:new AbortController().signal})
    assert.equal((await call('first')).isError,false);assert.equal(effects,1)
    const old=tools.get(name);sessions.clear()
    const expired=await call('expired')
    assert.equal(expired.isError,true);assert.equal(expired.error.info.code,'MCP_SESSION_EXPIRED')
    assert.equal(rejected,1);assert.equal(effects,1)
    assert.equal(receipts.at(-1).effect,'none');assert.equal(pending,false)
    const deadline=Date.now()+7000
    while(tools.get(name)===old && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50))
    assert.notEqual(tools.get(name),old,'native supervisor never replaced stale client')
    assert.equal((await call('retry')).isError,false)
    assert.equal(effects,2);assert.equal(initialized,2)
    assert.equal(receipts.length,3)
  } finally {
    await plugin?.dispose();await ctx.registry.delete(ToolRuntime);await ctx.registry.delete(SystemPrompt)
    await Promise.all(servers.map(server=>server.close()))
    http.closeAllConnections();await new Promise(resolve=>http.close(resolve))
    for(const [key,value] of [['TEAMHARNESS_RUNTIME_CONFIG',previous.runtime],['DEEPSEEK_API_KEY',previous.key]]){if(value===undefined)delete process.env[key];else process.env[key]=value}
    await rm(root,{recursive:true,force:true})
  }
})
