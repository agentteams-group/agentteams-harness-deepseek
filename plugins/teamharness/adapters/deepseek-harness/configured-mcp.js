import { createHash } from 'node:crypto'
import * as managed from './mcp-policy.js'

export function nativeServerName(assetName) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(assetName) ? assetName : 'at_' + createHash('sha256').update(assetName).digest('hex').slice(0, 24)
}

export async function installConfiguredMcp(ctx, record) {
  const model = record.desired?.model
  for (const server of record.desired?.mcpServers || []) {
    if (server.name === 'teamharness') throw new Error('Reserved MCP server name')
    const endpoint = new URL(server.url)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('Assigned MCP server requires an HTTP URL without embedded credentials')
    }
    const headers = {}
    if (model && new URL(model.gatewayUrl).origin === endpoint.origin) {
      // runtime_env projects the credential into the SDK environment before
      // matrix_bridge removes the original credential binding from the child.
      const credential = process.env.DEEPSEEK_API_KEY
      if (!credential) throw new Error('Assigned MCP gateway credential is unavailable')
      headers.Authorization = `Bearer ${credential}`
    }
    await ctx.plugin(managed.forAsset(server.name), { serverName: nativeServerName(server.name), transport: 'streamable-http',
      url: endpoint.href, headers, failOnStartupError: true }).await()
  }
}
