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

const byRelevance = (a, b) =>
  (a.rank - b.rank) ||
  ((b.node.confidence ?? 0) - (a.node.confidence ?? 0)) ||
  String(b.node.created_at ?? "").localeCompare(String(a.node.created_at ?? "")) ||
  a.node.id.localeCompare(b.node.id);

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
    db.exec("CREATE VIRTUAL TABLE fts USING fts5(name, description, aliases, type)");
    const ins = db.prepare(
      "INSERT INTO fts(name, description, aliases, type) VALUES (?, ?, ?, ?)"
    );
    nodes.forEach((n) =>
      ins.run(
        String(n.name ?? ""),
        String(n.description ?? ""),
        (n.aliases ?? []).join(" "),
        String(n.type ?? "")
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
  const blob = `${n.name ?? ""}\n${n.description ?? ""}\n${(n.aliases ?? []).join(" ")}\n${n.type ?? ""}`.toLowerCase();
  const hits = terms.filter((t) => blob.includes(t)).length;
  if (hits > 0) scored.push({ rank: -hits, node: n });
}
scored.sort(byRelevance);
render(scored);
