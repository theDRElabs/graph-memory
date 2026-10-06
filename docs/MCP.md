# MCP Server Setup

The graph is usable through five MCP tools. Any MCP-compatible agent (OpenCode, Claude Desktop, etc.) can call them.

## 1. Install dependencies

```bash
cd /path/to/graph-memory
npm install
```

## 2. Register the server

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "graph-memory": {
      "type": "local",
      "command": ["node", "/absolute/path/to/graph-memory/scripts/mcp-server.mjs"],
      "enabled": true
    }
  }
}
```

Restart OpenCode. The tools appear as `graph_query`, `graph_search`, `graph_add_episode`, `graph_invalidate`, `graph_stats`.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "graph-memory": {
      "command": "node",
      "args": ["/absolute/path/to/graph-memory/scripts/mcp-server.mjs"]
    }
  }
}
```

## 3. The tools

| Tool | What it does | Key args |
|---|---|---|
| `graph_query` | Walk N hops from a seed entity, optionally "as of" a date | `seed`, `hops`, `all`, `as_of` |
| `graph_search` | Ranked full-text search (FTS5, substring fallback) | `query`, `top` |
| `graph_add_episode` | File a new episode, rebuild the graph | `episode` (object with id/source/date/entities/relations) |
| `graph_invalidate` | Retire a fact from a date onward | `subject`, `predicate`, `object`, `invalid_at`, `superseded_by?` |
| `graph_stats` | Counts of episodes/nodes/edges + whether errors.log is non-empty | — |

## 4. Environment variables

| Variable | Purpose |
|---|---|
| `GRAPH_DIR` | Point at a different graph directory (default: repo root) |
| `GRAPH_RESEND_API_KEY` + `GRAPH_EMAIL_TO` | Enable approval-digest emails after assemble |

## 5. Testing the server without an agent

```bash
node -e "
import('@modelcontextprotocol/sdk/client/index.js').then(async ({Client}) => {
  const {StdioClientTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const t = new StdioClientTransport({command: 'node', args: ['scripts/mcp-server.mjs']});
  const c = new Client({name: 't', version: '0'}, {capabilities: {}});
  await c.connect(t);
  console.log((await c.listTools()).tools.map(x => x.name).join(', '));
  console.log((await c.callTool({name: 'graph_stats', arguments: {}})).content[0].text);
  await c.close();
});
"
```

## Notes

- The server shells out to the existing CLI scripts (`graph-assemble.mjs`, `graph-query.mjs`, `graph-search.mjs`) — it doesn't duplicate their logic.
- Every `graph_add_episode` / `graph_invalidate` triggers a full rebuild. On a large graph this is still fast (<1s for thousands of edges).
