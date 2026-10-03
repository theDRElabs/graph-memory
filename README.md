# graph-memory

**A persistent knowledge graph for AI coding agents, so they stop starting from scratch every session.**

Agents forget. They re-derive facts you told them last week, repeat the mistakes you already corrected, and burn tokens rediscovering things. This stores what worked, what didn't, and how things relate — as a graph, with timestamps.

Built and used alongside [`opencode-config`](https://github.com/theDRElabs/opencode-config) on a 3GB RAM Android phone, where wasted tokens are wasted money.

## How it works

Knowledge is stored as **entities** (tools, repos, people, concepts) connected by **relations** (dependencies, conflicts, ownership). Facts are time-stamped: when something becomes false it's marked invalid rather than deleted, so you can always see what was believed and when.

```
episodes/  ──assemble──>  nodes.jsonl   (canonical entities)
                        edges.jsonl   (relationships, with provenance + validity windows)
                        errors.log    (dangling refs, self-loops, type conflicts)
```

## Files

| File | What it is |
|---|---|
| `episodes/` | Raw facts extracted from source documents — append-only, never edited |
| `resolve.json` | Entity deduplication — maps aliases to canonical names |
| `nodes.jsonl` | Derived list of all canonical entities (rebuilt from episodes) |
| `edges.jsonl` | Derived list of all relationships with provenance and validity windows |
| `errors.log` | Quality issues surfaced during assembly |
| `scripts/` | Assembly and query tools |

Only `episodes/` and `resolve.json` are hand-written. Everything else is derived — fix the episode, reassemble.

## Quick start

```bash
node scripts/graph-assemble.mjs                        # rebuild the graph from episodes
node scripts/graph-query.mjs "Vercel" --hops=2         # active facts related to Vercel within 2 hops
node scripts/graph-query.mjs "Vercel" --hops=2 --all   # include invalidated (historical) facts
```

Zero dependencies — plain Node, no install step, no lockfile. It runs on a phone.

## Adding knowledge

Create an episode JSON file in `episodes/`:

```json
{
  "id": "2026-08-26-my-source",
  "source": "~/projects/my-project/README.md",
  "date": "2026-08-26",
  "entities": [
    { "name": "My Tool", "type": "TOOL", "description": "does one thing well" }
  ],
  "relations": [
    { "subject": "My Tool", "predicate": "depends on", "object": "Node.js" }
  ]
}
```

Then reassemble. Aliases go in `resolve.json` so "my tool" and "MyTool" resolve to the same node instead of forking into two.

## Entity types

`PERSON`, `ORG`, `TOOL`, `REPO`, `EVENT`, `CONCEPT`, `ARTIFACT`, `LOCATION`

## Temporal facts

Every fact carries `valid_at` and `invalid_at`. When reality changes, add an entry to `invalidations.json` and rerun assemble — the old fact stays in the graph as history, and queries return active facts only unless you pass `--all`.

This is the part that matters most in practice: an agent can see that something *used to* work and why you stopped trusting it, instead of silently re-learning the same lesson.

## Setup

Cloned into `~/.config/opencode/graph/` as part of the `opencode-config` install. It has its own git repo so graph history is independent of harness history.

## License

[MIT](./LICENSE)
