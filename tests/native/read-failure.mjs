// Real DSH filesystem tools; only model capabilities and Core receipts are fixtures.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import * as filesystemTools from '@deepseek-ai/dsh-tool-fs'

const { installExecutionGuard } = await import(process.env.AGENTTEAMS_MANAGED_NATIVE_MODULE ??
  new URL('../../plugins/teamharness/adapters/deepseek-harness/managed-native.js', import.meta.url).href)

class Attachments extends Service {
  constructor(ctx) { super(ctx, 'attachments'); this.imageLimits = {mediaTypes:['image/png']} }
  saveImage() { assert.fail('A text-only model must reject before reading or storing an image') }
}
class TextModel extends Service {
  constructor(ctx) { super(ctx, 'llm') }
  async resolveModelInfo() { return {inputModalities:['text']} }
}

for (const identity of [{event_key:'fixture'}, {task_id:'task',team_id:'team'}]) {
  test(`native image capability failure permits a different reader (${identity.event_key ? 'message' : 'task'})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-read-failure-'))
    const ctx = new Context()
    let scoped
    try {
      await writeFile(join(root,'evidence.txt'),'Browser DOM checks passed')
      for (const plugin of [SystemPrompt, SessionStore, TextModel, Attachments]) await ctx.plugin(plugin).await()
      await ctx.plugin(ToolRuntime,{mode:'native'}).await()
      await ctx.plugin(SandboxPolicyService,{mode:'workspace-write',workspaceRoot:root}).await()
      await ctx.plugin(LocalSandboxProvider,{}).await()
      await ctx.plugin(SandboxedFileSystem,{cwd:root}).await()
      const session = ctx.get('sessions').create('read-fixture',{meta:{cwd:root}})
      session.append('sandbox/mode',{mode:'workspace-write'})
      session.append('turn/start',{turn:1})
      const agent = {session,options:{provider:'fixture',model:'text-only'}}
      scoped = createScope(ctx,agent)
      await scoped.ctx.plugin(filesystemTools).await()
      let pending = false
      const receipts = []
      installExecutionGuard(ctx,agent,identity,async()=>{},(action,fields)=>{
        if (action === 'admit_tools') return {task:{execution:{state:'active',runtime:'deepseek-harness'}}}
        if (action.endsWith('begin_tools')) { assert.equal(pending,false);pending=true;return fields.calls[0].id }
        if (action.endsWith('finish_tools')) { receipts.push(...fields.results);pending=false }
      })
      const tools = ctx.get('tools')
      const call = (name,file) => tools.execute({agent,callId:name,name,arguments:{file_path:join(root,file)},signal:new AbortController().signal})
      const image = await call('read_image','screenshot.png')
      assert.equal(image.isError,true)
      assert.match(image.error.message,/does not declare image input/)
      assert.equal(receipts.length,1)
      assert.equal(receipts[0].status,'error')
      assert.equal(receipts[0].effect,undefined)
      const text = await call('read','evidence.txt')
      assert.equal(text.isError,false,JSON.stringify(text))
      assert.equal(receipts.length,2)
      assert.equal(pending,false)
    } finally {
      await scoped?.dispose()
      for (const plugin of [SandboxedFileSystem,LocalSandboxProvider,SandboxPolicyService,ToolRuntime,Attachments,TextModel,SessionStore,SystemPrompt]) await ctx.registry.delete(plugin)
      await rm(root,{recursive:true,force:true})
    }
  })
}
