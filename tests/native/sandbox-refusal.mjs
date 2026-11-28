import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as shellEnvironment from '@deepseek-ai/dsh-shell-env'
import * as bashTools from '@deepseek-ai/dsh-tool-bash'
import * as filesystemTools from '@deepseek-ai/dsh-tool-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'

const { installExecutionGuard } = await import(process.env.AGENTTEAMS_MANAGED_NATIVE_MODULE ??
  new URL('../../plugins/teamharness/adapters/deepseek-harness/managed-native.js', import.meta.url).href)

for (const outcome of ['same-mode', 'rejected', 'unavailable', 'empty-justification', 'filesystem-denied', 'unobserved-edit']) for (const tool of outcome === 'filesystem-denied' ? ['write'] : outcome === 'unobserved-edit' ? ['edit'] : ['bash', 'write']) test(`native ${tool} ${outcome} refusal settles without blocking the next call`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sandbox-refusal-'))
  const ctx = new Context()
  let scoped
  try {
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(SessionStore).await()
    await ctx.plugin(ApprovalService, { policy: 'ask' }).await()
    ctx.on('approval/request', () => outcome)
    await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
    await ctx.plugin(shellEnvironment).await()
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root }).await()
    await ctx.plugin(LocalSubprocessRuntime).await()
    await ctx.plugin(LocalSandboxProvider, {}).await()
    await ctx.plugin(SandboxBashExecutor, {}).await()
    await ctx.plugin(SandboxedFileSystem, { cwd: root }).await()
    const session = ctx.get('sessions').create('sandbox-fixture', { meta: { cwd: root } })
    session.append('sandbox/mode', { mode: 'workspace-write' })
    session.append('turn/start', { turn: 1 })
    const agent = { session }
    scoped = createScope(ctx, agent)
    await scoped.ctx.plugin(bashTools).await()
    await scoped.ctx.plugin(filesystemTools).await()
    let pending = false
    const receipts = []
    installExecutionGuard(ctx, agent, { event_key: 'fixture' }, async () => {}, (action, fields) => {
      if (action.endsWith('begin_tools')) {
        assert.equal(pending, false, 'a known refusal must not fence subsequent work')
        pending = true
        return fields.calls[0].id
      }
      if (action.endsWith('finish_tools')) { receipts.push(...fields.results); pending = false }
    })
    const tools = ctx.get('tools')
    const run = (callId, corrected = false) => tools.execute({ agent, callId, name: tool,
      arguments: { ...(tool === 'bash' ? { command: 'printf touched > must-not-exist.txt', description: 'Write a fixture file' }
        : tool === 'edit' ? { file_path: join(root, 'missing.txt'), old_string: 'before', new_string: 'after' }
        : { file_path: outcome === 'filesystem-denied' && !corrected ? join('/etc', 'must-not-exist-' + root.split('/').at(-1)) : join(root, 'must-not-exist.txt'), content: 'touched' }),
        ...(['filesystem-denied', 'unobserved-edit'].includes(outcome) ? {} : {
          sandbox_permissions: outcome === 'same-mode' ? 'workspace-write' : 'danger-full-access', justification: outcome === 'empty-justification' ? '' : 'Exercise a non-widening native request' }) },
      signal: new AbortController().signal })
    const refused = await run('refused')
    assert.equal(refused.isError, true, JSON.stringify(refused))
    if (['filesystem-denied', 'unobserved-edit'].includes(outcome)) {
      assert.equal(refused.error.info.name, 'FsError')
      assert.equal(refused.error.info.code, outcome === 'filesystem-denied' ? 'FS_SANDBOX_DENIED' : 'FS_STALE_VERSION')
      assert.equal(receipts.length, 1, 'the completed native filesystem failure must have a terminal receipt')
      assert.equal(receipts[0].status, 'error')
      assert.equal(receipts[0].effect, undefined, 'a general filesystem failure must not claim no partial effects')
      const next = await run('next-call', outcome === 'filesystem-denied')
      if (outcome === 'filesystem-denied') {
        assert.equal(next.isError, false, JSON.stringify(next))
        assert.equal(await readFile(join(root, 'must-not-exist.txt'), 'utf8'), 'touched')
      }
      assert.equal(receipts.length, 2)
      return
    }
    assert.equal(refused.error.message, outcome === 'empty-justification' ? 'invalid justification: expected a non-empty sentence' : outcome === 'same-mode'
      ? 'sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "workspace-write" mode'
      : outcome === 'rejected' ? `the user rejected escalating this ${tool === 'bash' ? 'command' : 'operation'} to "danger-full-access"`
      : 'sandbox escalation to "danger-full-access" requires approval, but no approval channel is available')
    if (outcome === 'same-mode') assert.ok(refused.content.some(block => block.text?.includes('omit sandbox_permissions')))
    await assert.rejects(readFile(join(root, 'must-not-exist.txt')), { code: 'ENOENT' })
    assert.equal(receipts[0]?.effect, 'none')
    assert.equal(receipts[0]?.error_code, 'SANDBOX_ESCALATION_REJECTED')
    await run('next-refusal')
    assert.equal(receipts.length, 2)
  } finally {
    await scoped?.dispose()
    for (const plugin of [SandboxedFileSystem, SandboxBashExecutor, LocalSandboxProvider, LocalSubprocessRuntime, SandboxPolicyService, shellEnvironment, ToolRuntime, ApprovalService, SessionStore, SystemPrompt]) await ctx.registry.delete(plugin)
    await rm(root, { recursive: true, force: true })
  }
})
