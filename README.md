# Graph Memory System

Persistent knowledge graph for this opencode environment. Aligned with
anthropics/claude-cookbooks `capabilities/knowledge_graph` pipeline and
Zep/Graphiti temporal-fact semantics (facts invalidated, never deleted).

## Files

| File | Role | Mutated by |
|---|---|---|
| `episodes/*.json` | Ground truth. Raw Extract-stage output per source document. Append-only, never edited after write. | Extraction (LLM stage) |
| `resolve.json` | Entity-resolution clusters: canonical name + aliases + type/description. | Resolution (LLM stage) |
| `nodes.jsonl` | Derived projection: canonical entities. | `scripts/graph-assemble.mjs` only |
| `edges.jsonl` | Derived projection: typed directed triples with provenance + validity window. | `scripts/graph-assemble.mjs` only |
| `invalidations.json` | Manual overlay marking superseded facts (`invalid_at`, `superseded_by`). Survives rebuilds. | Human/agent curation |
| `errors.log` | Compounding quality log: dangling refs, self-loop drops, type conflicts, over-merge risks. | Scripts + manual notes |

## Episode contract

```json
{
  "id": "2026-08-22-build-lessons",
  "source": "~/projects/termux-setup/BUILD-LESSONS.md",
  "date": "2026-08-22",
  "entities": [
    { "name": "Vercel personal access token", "type": "TOOL",
      "description": "one-line description",
      "aliases": ["vercel pat"] }
  ],
  "relations": [
    { "subject": "...", "predicate": "short-verb-phrase", "object": "...",
      "valid_at": "optional override, defaults to episode date" }
  ]
}
```

Entity types: PERSON, ORG, TOOL, REPO, EVENT, CONCEPT, ARTIFACT, LOCATION.

Discipline (cookbook guidelines):
- Only entities central to the content; skip incidental mentions.
- Every relation must connect two declared entities (relation-only names are
  flagged as DANGLING-REF in errors.log).
- Predicates are short verb phrases.

## Commands

```bash
node scripts/graph-assemble.mjs                      # rebuild projections from episodes/
node scripts/graph-query.mjs "seed name" --hops=2    # active facts only
GRAPH_DIR=/tmp/other node scripts/...                # operate on alternate store
# query flags: --all (include invalidated), --hops=N
```

Query output format: `(subject) --[predicate]--> (object)` lines plus a type
legend, ready to paste into context. Answers built on it should cite edges.

## Guards (what errors.log entries mean)

- `DANGLING-REF` — relation endpoint never declared anywhere. Fix: declare the
  entity or extend resolve.json. Exists because unresolved names otherwise
  vanish silently (documented cookbook failure mode).
- `SELF-LOOP ... dropped` — both endpoints resolved to one entity. Either an
  extraction error or a genuine over-merge; review before re-adding.
- `OVER-MERGE-RISK` — cluster with >4 aliases; check distinctness using
  descriptions as disambiguation context.
- `TYPE-CONFLICT` — same entity claimed as two types.

## Temporal semantics

Edges carry `valid_at`, `invalid_at`, `superseded_by`. Contradicted facts are
never deleted: add an entry to `invalidations.json` keyed `"s|p|o"`, rerun
assemble. Queries default to active facts; `--all` recovers history
("what did we believe then").
