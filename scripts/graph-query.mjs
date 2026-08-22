#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GRAPH_DIR
  ? path.resolve(process.env.GRAPH_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = (d) => path.join(ROOT, d);

const readJSONL = (f) =>
  fs.existsSync(f)
    ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const slug = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  console.log("usage: graph-query.mjs <seed> [--hops=N] [--all]");
  process.exit(0);
}
const all = args.includes("--all");
const hopsArg = args.find((a) => a.startsWith("--hops="));
const hops = hopsArg ? Math.max(1, parseInt(hopsArg.split("=")[1], 10)) : 2;
const seedRaw = args.filter((a) => !a.startsWith("--")).join(" ").trim();

const nodes = readJSONL(DIR("nodes.jsonl"));
const edges = readJSONL(DIR("edges.jsonl"));

const byAlias = new Map();
for (const n of nodes) for (const a of n.aliases ?? []) byAlias.set(a, n.id);

const seedId =
  byAlias.get(seedRaw.toLowerCase()) ??
  (nodes.some((n) => n.id === slug(seedRaw)) ? slug(seedRaw) : null);

if (!seedId) {
  console.error(`seed "${seedRaw}" not found in graph`);
  process.exit(1);
}

const active = (e) => all || !e.invalid_at;

const frontier = new Set([seedId]);
const visited = new Set([seedId]);
const lines = [];

for (let h = 0; h < hops; h++) {
  const next = new Set();
  for (const e of edges) {
    if (!active(e)) continue;
    const inS = frontier.has(e.subject);
    const inO = frontier.has(e.object);
    if (!inS && !inO) continue;
    lines.push(
      `(${e.subject}) --[${e.predicate}]${e.superseded_by ? `[superseded->${e.superseded_by}]` : ""}--> (${e.object})`
    );
    if (inS && !visited.has(e.object)) next.add(e.object);
    if (inO && !visited.has(e.subject)) next.add(e.subject);
  }
  visited.clear();
  visited.add(seedId);
  for (const n of frontier) visited.add(n);
  frontier.clear();
  for (const n of next) {
    frontier.add(n);
    visited.add(n);
  }
}

const seenLines = [...new Set(lines)].sort();
for (const l of seenLines) console.log(l);

const nodesShown = new Set(
  seenLines.flatMap((l) => l.match(/\(([^)]+)\)/g) ?? []).map((s) => s.slice(1, -1))
).size;
console.error(
  `\n[query] seed=${seedId} hops=${hops}${all ? " --all" : ""} | subgraph: ${seenLines.length} triples across ${nodesShown} nodes`
);

for (const n of nodes.filter((n) => visited.has(n.id))) {
  console.error(`[${n.type}] ${n.name}${n.description ? ` - ${n.description}` : ""}`);
}
