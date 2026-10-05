# Fact extraction prompt template (G4)

This document is the canonical prompt for pulling durable facts out of raw
material (session transcripts under `runs/`, session logs, memory notes,
README/ADR diffs) into graph-memory **candidate** episodes.

- LLM available → paste the source material + the prompt below into the LLM.
- No LLM → run the deterministic fallback parser: `node scripts/capture.mjs <file>`
  (heuristics only: `X is a Y`, `X depends on Y`, `X -- predicate --> Y`, ...).

Either way the result is a **candidate** episode in `episodes/candidates/`,
reviewed by a human or agent before being moved into `episodes/` and assembled.

## Source to scan

Scan, in priority order:

1. `runs/` — session transcripts / agent run logs (newest first).
2. Session-log files the agent already keeps (e.g. `~/.config/opencode` logs).
3. Source docs explicitly cited during the session (README.md, ADRs, config).

Extract only facts that are **stated**, not inferred. One episode per logical
source or session, not one giant file.

## Prompt

> You are extracting durable facts for a knowledge graph.
>
> From the SOURCE below, produce ONE JSON object matching this exact schema:
>
> ```json
> {
>   "id": "YYYY-MM-DD-short-slug",
>   "source": "<where this came from: path or session description>",
>   "date": "YYYY-MM-DD",
>   "schema_version": "1",
>   "entities": [
>     { "name": "canonical name", "type": "TOOL", "aliases": ["..."], "description": "one line" }
>   ],
>   "relations": [
>     { "subject": "entity name", "predicate": "kebab-case-predicate", "object": "entity name",
>       "valid_at": "YYYY-MM-DD (optional)", "invalid_at": "YYYY-MM-DD (optional)" }
>   ]
> }
> ```
>
> Rules:
> - `id`: `<date>-<kebab-slug of source>`; unique within `episodes/`.
> - `source`: the path or description the facts came from. Never invent.
> - `date`: the date the facts were observed, ISO `YYYY-MM-DD`. Required.
> - `schema_version`: always `"1"`.
> - Entities: reuse names already present in `resolve.json` (canonical names and
>   aliases) so facts merge instead of forking new nodes. If an alias is
>   mentioned, add it to the entity's `aliases` **and** prefer the canonical name.
> - Relations: `subject`/`object` must exactly match an entity `name` in the
>   same episode (assemble rejects dangling refs).
> - Predicates: lowercase kebab-case verb phrases (`depends-on`,
>   `runtime-incompatible-with`, `offloads-to`, `rules-encoded-in`). Prefer an
>   existing predicate style from prior episodes. No spaces, no generic
>   predicates like `relates-to`.
> - Entity types (pick one): `PERSON`, `ORG`, `TOOL`, `REPO`, `EVENT`,
>   `CONCEPT`, `ARTIFACT`, `LOCATION`. When in doubt use `CONCEPT` and note
>   the uncertainty in `description`.
> - Temporal fields: set `valid_at` when the fact has an explicit start date;
>   set `invalid_at` only when the source says the fact ended. Never guess dates.
>
> Uncertainty policy:
> - If the source hedges ("maybe", "I think", "usually", "reportedly") → SKIP
>   the fact. Do not mark it.
> - If a fact is stated plainly but contradicted elsewhere in the source →
>   keep only the newer/stronger claim and note the superseded one in the
>   episode `source` or omit it entirely (never emit both as active).
> - If you cannot determine an entity type, date, or predicate with
>   confidence → SKIP that fact rather than guessing.
>
> Output ONLY the JSON object, no prose.
>
> SOURCE:
> ```
> <paste transcript/log excerpt here>
> ```

## After extraction

1. Save the JSON as `episodes/candidates/<id>.json` (or let
   `scripts/capture.mjs` write the heuristic candidate).
2. Review: check entity types, predicate style, dates, and that no fact was
   invented. Never edit files already in `episodes/` — add a new episode or an
   invalidation instead.
3. Move the approved file into `episodes/`, then:
   `node scripts/graph-assemble.mjs` and inspect `errors.log`.
