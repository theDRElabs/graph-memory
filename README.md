# Graph Memory

A persistent knowledge graph for OpenCode. It remembers facts, decisions, and relationships across sessions so the AI doesn't start from scratch every time.

## What it does

Stores knowledge as **entities** (tools, repos, people, concepts) connected by **relations** (dependencies, conflicts, ownership). Facts are time-stamped — when something becomes false, it's marked invalid rather than deleted, so you can see what was believed and when.

## What's in here

| File | What it does |
|------|-------------|
| `episodes/` | Raw facts extracted from source documents — append-only, never edited |
| `resolve.json` | Entity deduplication — maps aliases to canonical names |
| `nodes.jsonl` | Derived list of all canonical entities (rebuilt from episodes) |
| `edges.jsonl` | Derived list of all relationships with provenance and validity windows |
| `errors.log` | Quality issues — dangling references, self-loops, type conflicts |
| `scripts/` | Assembly and query tools |

## Quick start

```bash
# Rebuild the graph from episodes
node scripts/graph-assemble.mjs

# Query: show facts related to "Vercel" within 2 hops
node scripts/graph-query.mjs "Vercel" --hops=2

# Include invalidated (historical) facts
node scripts/graph-query.mjs "Vercel" --hops=2 --all
```

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

Then run `node scripts/graph-assemble.mjs` to rebuild.

## Entity types

PERSON, ORG, TOOL, REPO, EVENT, CONCEPT, ARTIFACT, LOCATION

## Temporal facts

Facts have `valid_at` and `invalid_at` dates. When something changes, add an entry to `invalidations.json` and rerun assemble. The old fact stays in the graph as historical — queries default to active facts only.

## Backed up

This graph has its own git repo. It's cloned into `~/.config/opencode/graph/` as part of the full OpenCode config backup.
