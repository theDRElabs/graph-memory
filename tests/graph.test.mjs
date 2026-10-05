import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSEMBLE = path.join(REPO, "scripts", "graph-assemble.mjs");
const QUERY = path.join(REPO, "scripts", "graph-query.mjs");

const mkgraph = (episodes = [], extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-"));
  fs.mkdirSync(path.join(dir, "episodes"));
  fs.writeFileSync(path.join(dir, "resolve.json"), JSON.stringify(extra.resolve ?? { clusters: [] }));
  for (const [f, content] of episodes) {
    fs.writeFileSync(
      path.join(dir, "episodes", f),
      typeof content === "string" ? content : JSON.stringify(content)
    );
  }
  if (extra.invalidations) fs.writeFileSync(path.join(dir, "invalidations.json"), JSON.stringify(extra.invalidations));
  return dir;
};

const run = (script, args, dir) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    env: { ...process.env, GRAPH_DIR: dir },
    encoding: "utf8",
  });

const ep = (id, entities, relations, extra = {}) => ({
  id,
  source: "test",
  date: "2026-08-01",
  entities,
  relations,
  ...extra,
});

test("assemble builds graph and rebuild removes deleted episode data", () => {
  const dir = mkgraph([
    ["a.json", ep("a", [{ name: "X", type: "TOOL" }], [])],
    ["b.json", ep("b", [{ name: "Y", type: "TOOL" }], [{ subject: "X", predicate: "uses", object: "Y" }])],
  ]);
  assert.equal(run(ASSEMBLE, [], dir).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "nodes.jsonl"), "utf8").trim().split("\n").length, 2);
  fs.unlinkSync(path.join(dir, "episodes", "b.json"));
  assert.equal(run(ASSEMBLE, [], dir).status, 0);
  const nodes = fs.readFileSync(path.join(dir, "nodes.jsonl"), "utf8").trim().split("\n");
  assert.equal(nodes.length, 2 - 1); // Y gone
  assert.ok(!nodes.join("\n").includes('"Y"'));
  assert.equal(fs.readFileSync(path.join(dir, "edges.jsonl"), "utf8").trim(), "");
});

test("malformed episode does not crash; other episodes still built", () => {
  const dir = mkgraph([
    ["bad.json", "{not json"],
    ["ok.json", ep("ok", [{ name: "Z", type: "TOOL" }], [])],
  ]);
  const r = run(ASSEMBLE, [], dir);
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(path.join(dir, "errors.log"), "utf8"), /EPISODE-REJECTED/);
  assert.match(fs.readFileSync(path.join(dir, "nodes.jsonl"), "utf8"), /"Z"/);
});

test("missing date is rejected (G16)", () => {
  const dir = mkgraph([["nodate.json", { id: "n", source: "t", entities: [], relations: [] }]]);
  const r = run(ASSEMBLE, [], dir);
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(path.join(dir, "errors.log"), "utf8"), /missing or invalid date/);
});

test("unknown schema_version rejected (G8)", () => {
  const dir = mkgraph([["v2.json", ep("v2", [], [], { schema_version: "2" })]]);
  run(ASSEMBLE, [], dir);
  assert.match(fs.readFileSync(path.join(dir, "errors.log"), "utf8"), /unsupported schema_version/);
});

test("errors.log truncated between runs (G13)", () => {
  const dir = mkgraph([["bad.json", "{nope"]]);
  run(ASSEMBLE, [], dir);
  assert.match(fs.readFileSync(path.join(dir, "errors.log"), "utf8"), /EPISODE-REJECTED/);
  fs.unlinkSync(path.join(dir, "episodes", "bad.json"));
  fs.writeFileSync(path.join(dir, "episodes", "ok.json"), JSON.stringify(ep("ok", [], [])));
  run(ASSEMBLE, [], dir);
  assert.equal(fs.readFileSync(path.join(dir, "errors.log"), "utf8"), "");
});

test("superseded_by missing target flagged (G14)", () => {
  const dir = mkgraph(
    [["a.json", ep("a", [{ name: "X" }, { name: "Y" }], [{ subject: "X", predicate: "p", object: "Y" }])]],
    { invalidations: { "x|p|y": { invalid_at: "2026-09-01", superseded_by: "no|such|edge" } } }
  );
  run(ASSEMBLE, [], dir);
  assert.match(fs.readFileSync(path.join(dir, "errors.log"), "utf8"), /SUPERSEDED-BY-MISSING/);
});

test("contradiction between active edges flagged (G7)", () => {
  const dir = mkgraph([
    ["a.json", ep("a", [{ name: "S" }, { name: "O1" }], [{ subject: "S", predicate: "p", object: "O1" }])],
    ["b.json", ep("b", [{ name: "O2" }], [{ subject: "S", predicate: "p", object: "O2" }])],
  ]);
  run(ASSEMBLE, [], dir);
  assert.match(fs.readFileSync(path.join(dir, "errors.log"), "utf8"), /CONTRADICTION s --\[p\]--> o1 vs o2/);
});

test("query: --as-of excludes future facts (G11)", () => {
  const dir = mkgraph([
    ["a.json", ep("a", [{ name: "S" }, { name: "O" }], [{ subject: "S", predicate: "p", object: "O", valid_at: "2026-08-01" }])],
  ]);
  run(ASSEMBLE, [], dir);
  const before = run(QUERY, ["S", "--hops=1", "--as-of=2026-01-01"], dir);
  assert.match(before.stderr, /subgraph: 0 triples/);
  const after = run(QUERY, ["S", "--hops=1", "--as-of=2026-09-01"], dir);
  assert.match(after.stderr, /subgraph: 1 triples/);
});

test("query: monotonic visited set lists all reached nodes (G10)", () => {
  const dir = mkgraph([
    ["a.json", ep("a", [{ name: "A" }, { name: "B" }, { name: "C" }], [
      { subject: "A", predicate: "x", object: "B" },
      { subject: "B", predicate: "y", object: "C" },
      { subject: "C", predicate: "z", object: "A" },
    ])],
  ]);
  run(ASSEMBLE, [], dir);
  const r = run(QUERY, ["A", "--hops=3"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /A/);
  assert.match(r.stderr, /B/);
  assert.match(r.stderr, /C/);
});

test("assemble is deterministic", () => {
  const mk = () =>
    mkgraph([
      ["a.json", ep("a", [{ name: "S" }, { name: "O" }], [{ subject: "S", predicate: "p", object: "O" }])],
    ]);
  const d1 = mk();
  const d2 = mk();
  run(ASSEMBLE, [], d1);
  run(ASSEMBLE, [], d2);
  assert.equal(
    fs.readFileSync(path.join(d1, "nodes.jsonl"), "utf8"),
    fs.readFileSync(path.join(d2, "nodes.jsonl"), "utf8")
  );
  assert.equal(
    fs.readFileSync(path.join(d1, "edges.jsonl"), "utf8"),
    fs.readFileSync(path.join(d2, "edges.jsonl"), "utf8")
  );
});
