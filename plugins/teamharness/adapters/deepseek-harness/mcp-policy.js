import * as native from '@deepseek-ai/dsh-mcp-client'
import { recoveryCall } from './managed-native.js'
import { MCP_APPROVAL_REASON } from './matrix-interactions.js'

export const name = 'agentteams-managed-mcp'
export const Config = native.Config
export const inject = native.inject

const ownedTools = new WeakSet()
export function isManagedMcpTool(definition) { return Boolean(definition && ownedTools.has(definition)) }

// Keep the registering server's identity, including for native hashed names.
// Native MCP still owns discovery, calls, reconnects and disposal.
export async function apply(ctx, config, assetName = config.serverName) {
  const tools = ctx.get('tools')
  const registered = new Map()
  const registry = new Proxy(tools, {
    get(target, key) {
      if (key === 'register') return definition => {
        const dispose = target.register(definition)
        const actual = target.get(definition.name)
        registered.set(definition.name, actual)
        ownedTools.add(actual)
        return () => {
          if (registered.get(definition.name) === actual) registered.delete(definition.name)
          ownedTools.delete(actual)
          dispose()
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!registered.has(execution.name) || tools.get(execution.name, execution.agent) !== registered.get(execution.name)) return next()
    const policy = recoveryCall('mcp_approval', { server_name: assetName })
    if (policy === 'ask') return { kind: 'ask', reason: MCP_APPROVAL_REASON }
    return next()
  })
  const scoped = new Proxy(ctx, {
    get(target, key) {
      if (key === 'tools') return registry
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return native.apply(scoped, config)
}

export function forAsset(assetName) {
  return { name, Config, inject, apply: async (ctx, config) => apply(ctx, config, assetName) }
}
