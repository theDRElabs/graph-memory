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

const args = process.argv.slice(2);
if (args.includes("--help") || args.filter((a) => !a.startsWith("--")).length === 0) {
  console.log("usage: graph-search.mjs <query> [--top=N]");
  process.exit(0);
}
const topArg = args.find((a) => a.startsWith("--top=") || a.startsWith("--limit="));
const top = topArg
  ? Math.max(1, parseInt(topArg.split("=")[1], 10))
  : 10;
const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();

const nodes = readJSONL(DIR("nodes.jsonl"));
if (nodes.length === 0) {
  console.log("[search] no nodes indexed");
  process.exit(0);
}

const render = (ranked) => {
  for (const { node } of ranked.slice(0, top)) {
    const aliases = (node.aliases ?? []).join(", ");
    console.log(
      `[${node.type}] ${node.name} (${node.id}) confidence=${node.confidence ?? "?"} created=${node.created_at ?? "?"}${node.description ? ` - ${node.description}` : ""}${aliases ? ` | aliases: ${aliases}` : ""}`
    );
  }
  if (ranked.length > top) console.error(`[search] ${ranked.length} matches, showing top ${top} (--top=N to change)`);
};

const edges = readJSONL(DIR("edges.jsonl"));
const predsByNode = new Map();
for (const e of edges) {
  for (const id of [e.subject, e.object]) {
    if (!predsByNode.has(id)) predsByNode.set(id, new Set());
    predsByNode.get(id).add(String(e.predicate ?? ""));
  }
}
const nodePredicates = (n) => [...(predsByNode.get(n.id) ?? [])].join(" ");

// G2: blend match rank with confidence and recency into one score (lower = better).
const TODAY = new Date().toISOString().slice(0, 10);
const recencyBonus = (created) => {
  if (!created || typeof created !== "string") return 0;
  const ageDays = (Date.parse(TODAY) - Date.parse(created)) / 86400000;
  return ageDays >= 0 && ageDays <= 30 ? 0.1 : 0;
};
const byRelevance = (a, b) =>
  adjustedRank(a) - adjustedRank(b) || a.node.id.localeCompare(b.node.id);
const adjustedRank = (r) =>
  r.rank - 0.15 * (r.node.confidence ?? 0) - recencyBonus(r.node.created_at);

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
  if (typeof DatabaseSync !== "function") DatabaseSync = null;
} catch {
  DatabaseSync = null;
}

if (DatabaseSync) {
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts USING fts5(name, description, aliases, type, predicates)");
    const ins = db.prepare(
      "INSERT INTO fts(name, description, aliases, type, predicates) VALUES (?, ?, ?, ?, ?)"
    );
    nodes.forEach((n) =>
      ins.run(
        String(n.name ?? ""),
        String(n.description ?? ""),
        (n.aliases ?? []).join(" "),
        String(n.type ?? ""),
        nodePredicates(n)
      )
    );
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/"/g, ""))
      .filter(Boolean);
    if (terms.length === 0) {
      console.log("[search] empty query");
      process.exit(0);
    }
    const ftsQuery = terms.map((t) => `"${t}"`).join(" OR ");
    const rows = db
      .prepare("SELECT rowid, rank FROM fts WHERE fts MATCH ? ORDER BY rank")
      .all(ftsQuery);
    const ranked = rows.map((r) => ({ rank: r.rank, node: nodes[r.rowid - 1] }));
    ranked.sort(byRelevance);
    render(ranked);
    db.close();
    process.exit(0);
  } catch (err) {
    console.error(`[search] FTS unavailable (${err.message}); falling back to substring match`);
  }
} else {
  console.error("[search] node:sqlite unavailable on this Node; falling back to substring match");
}

// Fallback: case-insensitive substring scoring over name/description/aliases/type
const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
const scored = [];
for (const n of nodes) {
  const blob = `${n.name ?? ""}\n${n.description ?? ""}\n${(n.aliases ?? []).join(" ")}\n${n.type ?? ""}\n${nodePredicates(n)}`.toLowerCase();
  const hits = terms.filter((t) => blob.includes(t)).length;
  if (hits > 0) scored.push({ rank: -hits, node: n });
}
scored.sort(byRelevance);
render(scored);
