"""Preserve MCP terminal errors and reconnect expired Streamable HTTP sessions."""
import sys
from pathlib import Path

path = Path(sys.argv[1]) / "node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js"
source = path.read_text()
old = "if (result.isError === true) throw new Error(text);"
terminal = 'if (result.isError === true) throw new HarnessError(text, "MCP_TOOL_RESULT_ERROR");'
if source.count(old) == 2:
    source = 'import { HarnessError } from "@deepseek-ai/dsh-llm";\n' + source.replace(old, terminal)
else:
    assert source.count(terminal) == 2, "Revalidate the native MCP terminal-error compatibility fix"

source = source.replace('import { StreamableHTTPClientTransport }', 'import { StreamableHTTPClientTransport, StreamableHTTPError }')
start = source.index('async function callToolUncached(') if 'async function callToolUncached(' in source else source.index('function callToolUncached(')
end = source.index('\n/**', start)
original = source[start:end]
assert original.count('client.request(') == 1, "Revalidate the native MCP session recovery boundary"
replacement = original
if not original.startswith('async function'):
    replacement = original.replace('function callToolUncached(', 'async function callToolUncached(', 1)
    replacement = replacement.replace('\n\treturn client.request(', '\n\tconst transport = client.transport;\n\tconst session = transport instanceof StreamableHTTPClientTransport ? transport.sessionId : undefined;\n\ttry {\n\treturn await client.request(', 1)
    replacement = replacement[:-2] + '''
    } catch (error) {
        // An MCP session-bound HTTP 404 rejects this request before dispatch.
        // Close the stale generation so the native supervisor reinitializes it.
        if (session && client.transport === transport && !exec.signal?.aborted
            && error instanceof StreamableHTTPError && error.code === 404) {
            await client.close();
            throw new HarnessError("MCP session expired before tool dispatch. The client is reconnecting; retry the tool.", "MCP_SESSION_EXPIRED");
        }
        throw error;
    }
}
'''
if '"MCP_HTTP_ERROR"' not in replacement:
    assert replacement.count('        throw error;') == 1, "Revalidate native MCP HTTP error propagation"
    replacement = replacement.replace('        throw error;', '''        // A returned HTTP failure is a terminal error response, not evidence
        // of no effects. A disconnected/timed-out request has no such receipt.
        if (error instanceof StreamableHTTPError) {
            throw new HarnessError(error.message, "MCP_HTTP_ERROR");
        }
        throw error;''', 1)
source = source[:start] + replacement + source[end:]
path.write_text(source)
