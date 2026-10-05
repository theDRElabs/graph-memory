#!/usr/bin/env node
// G3: automatic capture — scans text for candidate facts and writes a
// candidate episode JSON to episodes/candidates/ for human/agent approval.
// Deterministic fallback parser; the LLM prompt template lives in
// scripts/extract-template.md (G4). Zero dependencies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GRAPH_DIR
  ? path.resolve(process.env.GRAPH_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage:
  node scripts/capture.mjs <file>     # scan a text file
  node scripts/capture.mjs            # scan stdin

Writes episodes/candidates/<id>.json and prints its path.
Nothing lands in episodes/ — review the candidate first.`;

const readStdin = () => {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

const arg = process.argv[2];
if (arg === "-h" || arg === "--help") {
  console.log(USAGE);
  process.exit(0);
}

let text;
let source;
if (arg) {
  try {
    text = fs.readFileSync(arg, "utf8");
  } catch (err) {
    console.error(`cannot read ${arg}: ${err.message}`);
    process.exit(1);
  }
  source = arg;
} else {
  text = readStdin();
  source = "stdin";
  if (!text.trim()) {
    console.error(USAGE);
    process.exit(1);
  }
}

const clean = (s) =>
  s.trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/g, "").trim();

// Ordered heuristic patterns: [regex, build(subject, tail) -> {subject, predicate, object}]
const PATTERNS = [
  // X -- predicate --> Y   (also X -[predicate]-> Y, X --predicate--→ Y)
  [/^(.+?)\s*-+(?:\[|\()?\s*([^\-\[\]\(\)>→][^\]\)>→]*?)\s*(?:\]|\))?\s*(?:-+[->→]+|→)\s*(.+?)$/, (m) => ({ subject: m[1], predicate: m[2], object: m[3] })],
  [/^(.+?)\s+is an?\s+(.+?)$/i, (m) => ({ subject: m[1], predicate: "is-a", object: m[2] })],
  [/^(.+?)\s+depends on\s+(.+?)$/i, (m) => ({ subject: m[1], predicate: "depends-on", object: m[2] })],
  [/^(.+?)\s+requires\s+(.+?)$/i, (m) => ({ subject: m[1], predicate: "requires", object: m[2] })],
  [/^(.+?)\s+uses\s+(.+?)$/i, (m) => ({ subject: m[1], predicate: "uses", object: m[2] })],
  [/^(.+?)\s+extends\s+(.+?)$/i, (m) => ({ subject: m[1], predicate: "extends", object: m[2] })],
  [/^(.+?)\s+owns\s+(.+?)$/i, (m) => ({ subject: m[1], predicate: "owns", object: m[2] })],
  [/^(.+?)\s+runs on\s+(.+?)$/i, (m) => ({ subject: m[1], predicate: "runs-on", object: m[2] })],
  [/^(.+?)\s+works with\s+(.+?)$/i, (m) => ({ subject: m[1], predicate: "works-with", object: m[2] })],
];

const entities = new Map(); // name.toLowerCase() -> entity
const relations = [];
const seen = new Set(); // subject|predicate|object

const addEntity = (name) => {
  const key = name.toLowerCase();
  if (!entities.has(key)) entities.set(key, { name, type: "CONCEPT", description: "candidate — review type" });
  return entities.get(key).name;
};

for (const rawLine of text.split(/\r?\n/)) {
  // strip list markers and quote/code fences
  const line = rawLine
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^[>\s`]+/, "")
    .trim();
  if (!line || line.length > 300) continue;
  for (const [re, build] of PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    const { subject, predicate, object } = build(m);
    const s = clean(subject);
    const p = clean(predicate).toLowerCase().replace(/\s+/g, "-");
    const o = clean(object);
    if (!s || !p || !o || s.toLowerCase() === o.toLowerCase()) break;
    if (s.split(/\s+/).length > 8 || o.split(/\s+/).length > 8) break;
    const key = `${s.toLowerCase()}|${p}|${o.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      addEntity(s);
      addEntity(o);
      relations.push({ subject: s, predicate: p, object: o });
    }
    break;
  }
}

if (relations.length === 0) {
  console.error(`no candidate facts found in ${source} (patterns: "X is a Y", "X depends on Y", "X -- predicate --> Y", ...)`);
  process.exit(2);
}

const date = new Date().toISOString().slice(0, 10);
const slug = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "capture";

const candidatesDir = path.join(ROOT, "episodes", "candidates");
fs.mkdirSync(candidatesDir, { recursive: true });

let id = `${date}-capture-${slug(path.basename(source))}`;
let n = 2;
while (fs.existsSync(path.join(candidatesDir, `${id}.json`))) id = `${date}-capture-${slug(path.basename(source))}-${n++}`;

const episode = {
  id,
  source,
  date,
  schema_version: "1",
  entities: [...entities.values()],
  relations,
};

const out = path.join(candidatesDir, `${id}.json`);
fs.writeFileSync(out, JSON.stringify(episode, null, 2) + "\n");
console.log(`captured ${relations.length} candidate relation(s), ${entities.size} entit(y/ies)`);
console.log(`candidate episode: ${out}`);
console.log(`review, then move it into episodes/ and run: node scripts/graph-assemble.mjs`);