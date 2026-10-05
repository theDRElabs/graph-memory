# graph-memory — Modernization Plan

Goal: bring graph-memory up to modern agentic-engineering standards while keeping its strengths (temporal facts, provenance, zero heavy deps, rebuild-from-episodes).

## Confirmed gaps to fix (from audit)

### G1. No MCP server interface
OpenCode agents cannot call the graph as tools.
- Add a small MCP server (Node, stdio transport) exposing tools:
  `graph_query(seed, hops, all)`, `graph_search(query)` (semantic), `graph_add_episode(json)`, `graph_invalidate(fact_id)`, `graph_stats()`.
- Register it in `opencode.jsonc` as an MCP server entry.
- Keep CLI scripts as thin wrappers over the same library code.

### G2. No semantic / ranked retrieval
Queries only match node aliases by exact string.
- Add ranking: recency + provenance count + hop distance as a baseline scorer.
- Add semantic search via SQLite FTS5 over node name/description/aliases/edge predicates (cheap, zero-dep, works on phone). Optional later: embedding-based retrieval behind a flag.
- Deterministic ordering, token-budgeted output (cap results).

### G3. No automatic capture
Facts only enter via hand-written episode JSON.
- Add an extraction hook: scan `runs/` transcripts / session logs and produce candidate episode JSONs for human/agent approval before landing in `episodes/`.
- Provide `graph_add_episode` tool + validation schema (zod or hand-rolled) rejecting malformed episodes.

### G4. No automatic extraction / dedup intelligence
- Add a documented LLM-prompt template for fact extraction (entity types, predicates, temporal fields) stored in `scripts/` or docs, runnable when an LLM is available; deterministic fallback parser for structured inputs.

### G5. Flat JSONL storage, no concurrency safety
- Move derived artifacts behind a storage layer with atomic writes (write-temp-then-rename) and a simple lockfile around assemble.
- Keep JSONL as the canonical on-disk format for diffability (episodes stay git-tracked); index into SQLite for query instead of parsing JSONL per query.

### G6. No tests / CI
- Add a test suite (node:test) for: alias resolution, collision detection, assemble idempotency, temporal filtering, query hop traversal, FTS ranking.
- Add a CI workflow that runs tests + rebuilds the graph and fails on nonzero errors.log.

### G7. No relevance/confidence scoring or contradiction detection
- Add per-fact confidence field (derived: number of supporting episodes, recency).
- Detect contradictory active facts (same subject+predicate, different object, overlapping validity windows) and log to errors.log as `CONTRADICTION`.

### G8. No schema versioning
- Add `schema_version` to episodes and a migration note; validate on assemble.
- Also validate date formats on `valid_at`/`invalid_at`/`date` (feeds G11/G7).

### G9. Derived files are merged, not rebuilt (CRITICAL)
- `graph-assemble.mjs` merges into existing `nodes.jsonl`/`edges.jsonl`, so deleting/editing an episode leaves stale data. Rebuild derived artifacts deterministically from `episodes/` + `resolve.json` every run.

### G10. Query traversal `visited`-set reset bug
- `visited` is rebuilt per hop as `{seed} ∪ oldFrontier ∪ newFrontier`, dropping earlier-hop nodes from output and breaking semantics on cycles. Use a monotonic visited set.

### G11. No temporal filtering
- Query ignores `valid_at`; future-dated facts appear active. Add `--as-of <date>` with proper `valid_at <= as-of < invalid_at` filtering.

### G12. One malformed episode crashes assemble
- Unguarded `JSON.parse` per episode and no shape validation. Guard parsing, reject bad episodes to errors.log, continue.

### G13. errors.log unbounded + duplicates
- Rewrite errors.log per assemble (or rotate); don't append the same issues forever. CI gate must reflect this.

### G14. `superseded_by` chains unvalidated
- Validate targets exist and are acyclic; warn on invalidations referencing missing edges.

### G15. invalidations.json absent/unchecked
- Ship a documented empty example, validate shape on load.

### G16. Assemble nondeterminism
- Replace wall-clock fallback when episode lacks `date` with explicit rejection; deterministic edge sort (subject, predicate, object).

## Corrections from independent review
- G5 must include G9: atomic writes alone don't fix stale derived data — rebuild first, then write atomically.
- G6 CI gate must account for G13 (errors.log semantics change).
- G7 contradiction overlap detection depends on G11/G8 date validation.

## Out of scope (explicitly)
- Replacing JSONL-git history with a hosted DB.
- Multi-user / networked access.
- Heavy ML models on-device (embeddings stay optional and off by default).

## Acceptance criteria
- MCP server registered and tools callable from an OpenCode agent.
- `graph_search` returns ranked, token-capped results.
- Assemble is crash-safe and concurrency-safe (lockfile + atomic writes).
- Tests pass; CI green.
- Contradictions and over-merges surface in errors.log.
- Existing query CLI behavior unchanged (backward compatible).
