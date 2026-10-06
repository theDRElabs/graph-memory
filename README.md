# graph-memory

**A persistent memory for AI coding agents — so yours stops starting from scratch every session.**

Your AI agent forgets. It re-derives facts you told it last week, repeats mistakes you already corrected, and burns tokens rediscovering things. This repo is the fix: a small knowledge graph that stores *what worked, what didn't, and how things relate* — with timestamps, so the agent can tell what's true **now** from what used to be true.

It is designed to be used through **MCP** (Model Context Protocol), which gives the agent five tools to read and write memory.

## What's in the box

- 🧠 **Knowledge graph** — entities (tools, repos, people, concepts) connected by relations, each fact time-stamped
- 🔍 **`graph_search`** — ranked full-text search (SQLite FTS5) over names, descriptions, aliases, and predicates
- 🗺️ **`graph_query`** — walk the graph N hops out from any entity, optionally "as of" a date
- 📥 **`capture.mjs`** — scan text for candidate facts, write drafts for your review
- ✅ **Approval digest** — every assemble tells you what's waiting; emails you via Resend if configured
- 🛡️ **Safety rails** — atomic writes, single-writer lock, malformed-episode guards, contradiction detection, superseded-by validation
- 🧪 **Tests + CI** — 10 automated tests, GitHub Actions on every push

## Quick start

```bash
npm install                                    # installs the MCP SDK
node scripts/graph-assemble.mjs                # build the graph from episodes/
node scripts/graph-search.mjs "Vercel"         # search it
node scripts/graph-query.mjs "Vercel" --hops=2 # walk it
npm test                                       # run the test suite
```

Then wire the MCP server into your agent — see [docs/MCP.md](docs/MCP.md).

## How it works (the 30-second version)

```
episodes/            the source of truth — raw facts, append-only
   │  graph-assemble.mjs  (the librarian — rebuilds everything from scratch)
   ▼
nodes.jsonl          every entity, with aliases + confidence
edges.jsonl          every relation, with timestamps + confidence
errors.log           problems found this run (contradictions, dangling refs, ...)
```

Only `episodes/` and `resolve.json` are hand-written. Everything else is derived — fix the episode, re-run assemble, and the graph heals.

**Facts are never deleted.** When a fact stops being true, it gets `invalid_at` set — it stays in the graph as history, and normal queries hide it.

## Everyday use — talk to your agent

You don't run the scripts yourself. You tell your AI agent things in plain language, and it uses the MCP tools:

| You say | Agent does |
|---|---|
| "Remember that the phone OOMs on parallel Termux jobs" | `graph_add_episode` |
| "What did we decide about phone builds?" | `graph_search` |
| "Show me everything related to Termux, one hop out" | `graph_query` |
| "That fact about X is outdated now" | `graph_invalidate` |
| "Check memory health" | `graph_stats` |

## Adding knowledge

Three ways, easiest first:

1. **Tell the agent** — it files an episode via `graph_add_episode`.
2. **Capture from text** — pipe notes/transcripts through the heuristic extractor:
   ```bash
   cat notes.txt | node scripts/capture.mjs
   ```
   Candidates land in `episodes/candidates/` as drafts. Approve by moving the file into `episodes/`, or tell the agent "approve the stdin one."
3. **Hand-write an episode** — see the format in [Adding knowledge](#adding-knowledge-1) below.

## Adding knowledge (episode format)

```json
{
  "id": "2026-08-26-my-source",
  "source": "~/projects/my-project/README.md",
  "date": "2026-08-26",
  "schema_version": "1",
  "entities": [
    { "name": "My Tool", "type": "TOOL", "description": "does one thing well" }
  ],
  "relations": [
    { "subject": "My Tool", "predicate": "depends on", "object": "Node.js" }
  ]
}
```

Then run assemble. Aliases go in `resolve.json` so "my tool" and "MyTool" resolve to one node.

Entity types: `PERSON`, `ORG`, `TOOL`, `REPO`, `EVENT`, `CONCEPT`, `ARTIFACT`, `LOCATION`.

## Retiring facts (invalidations)

Add to `invalidations.json` (see `invalidations.example.json`):

```json
{
  "my-tool|depends-on|node.js": {
    "invalid_at": "2026-09-15",
    "superseded_by": "my-tool|depends-on|bun"
  }
}
```

Re-run assemble. The old fact stays as history; queries return active facts only unless you pass `--all`. Superseded-by chains are validated (missing targets and cycles get flagged).

## Confidence & contradiction detection

Every node and edge gets a `confidence` score (0–1): starts at 0.5, +0.2 if confirmed by 2+ episodes, +0.2 if all supporting episodes recorded a `valid_at`. If two active facts disagree (same subject + predicate, different object), assemble logs a `CONTRADICTION` in `errors.log` so you can untangle it.

## Approval digest emails

After every assemble, pending candidates are listed. To also get them by email (via [Resend](https://resend.com)), set:

```bash
export GRAPH_RESEND_API_KEY=re_...
export GRAPH_EMAIL_TO=you@example.com
```

Without these vars it just prints to the terminal.

## Safety rails

- **Atomic writes** — catalogs are written to a temp file then renamed; a crash never leaves a half-written file
- **Lockfile** — only one assemble runs at a time; stale locks from dead processes are reclaimed
- **No crash on bad input** — one malformed episode is rejected and logged; the rest still builds
- **Errors reset each run** — `errors.log` always reflects the *latest* assemble
- **Deterministic** — same episodes in, same graph out (append-only `episodes/` + sorted output)

## Setup

Cloned into `~/.config/opencode/graph/` as part of the `opencode-config` install. See [docs/MCP.md](docs/MCP.md) for wiring the MCP server into OpenCode.

## License

[MIT](./LICENSE)
