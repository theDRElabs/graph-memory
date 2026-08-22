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
const writeJSONL = (f, arr) =>
  fs.writeFileSync(f, arr.map((o) => JSON.stringify(o)).join("\n") + "\n");
const logError = (msg) =>
  fs.appendFileSync(DIR("errors.log"), `${new Date().toISOString()} ${msg}\n`);
const slug = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const resolveData = JSON.parse(fs.readFileSync(DIR("resolve.json"), "utf8"));
for (const c of resolveData.clusters ?? []) {
  if ((c.aliases?.length ?? 0) > 4)
    logError(`OVER-MERGE-RISK cluster "${c.canonical}" has ${c.aliases.length} aliases - review manually`);
}
const aliasOwner = new Map();
for (const c of resolveData.clusters ?? []) {
  for (const nm of [c.canonical.toLowerCase(), ...(c.aliases ?? []).map((a) => a.toLowerCase())]) {
    const owner = aliasOwner.get(nm);
    if (owner && owner !== c.canonical)
      logError(
        `ALIAS-COLLISION "${nm}" claimed by clusters "${owner}" and "${c.canonical}" - false-merge risk, fix resolve.json`
      );
    else aliasOwner.set(nm, c.canonical);
  }
}
const aliasToCanonical = new Map();
for (const c of resolveData.clusters ?? []) {
  aliasToCanonical.set(c.canonical.toLowerCase(), c.canonical);
  for (const a of c.aliases ?? []) aliasToCanonical.set(a.toLowerCase(), c.canonical);
}

const clusterByName = new Map();
for (const c of resolveData.clusters ?? []) clusterByName.set(c.canonical.toLowerCase(), c);

let rejectedEpisodes = 0;
const episodes = fs
  .readdirSync(DIR("episodes"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(DIR("episodes"), f), "utf8"));
    return { file: f, ...data };
  })
  .filter((ep) => {
    if (!ep.source || !String(ep.source).trim()) {
      rejectedEpisodes++;
      logError(`EPISODE-REJECTED ${ep.id ?? ep.file}: missing source - no receipt, no entry`);
      process.exitCode = 1;
      return false;
    }
    return true;
  });

const declaredNames = new Set();
for (const c of resolveData.clusters ?? []) {
  declaredNames.add(c.canonical.toLowerCase());
  for (const a of c.aliases ?? []) declaredNames.add(a.toLowerCase());
}
for (const ep of episodes)
  for (const e of ep.entities ?? []) {
    declaredNames.add(String(e.name).toLowerCase());
    for (const a of e.aliases ?? []) declaredNames.add(String(a).toLowerCase());
  }

let fallbacks = 0;
const canon = (name, epId) => {
  const key = String(name).toLowerCase();
  const hit = aliasToCanonical.get(key);
  if (hit) return hit;
  if (!declaredNames.has(key)) {
    fallbacks++;
    logError(
      `DANGLING-REF "${name}" in ${epId}: used by a relation but never declared as entity or cluster -> self-cluster`
    );
  }
  return String(name);
};

const nodes = readJSONL(DIR("nodes.jsonl"));
const edges = readJSONL(DIR("edges.jsonl"));
const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
const edgeKey = (s, p, o) => `${slug(s)}|${slug(p)}|${slug(o)}`;
const edgeIndex = new Map(edges.map((e) => [edgeKey(e.subject, e.predicate, e.object), e]));

const ensureNode = (canonicalName, epId, epDate, hint = {}) => {
  const id = slug(canonicalName);
  let node = nodeIndex.get(id);
  if (!node) {
    const cl = clusterByName.get(canonicalName.toLowerCase());
    node = {
      id,
      name: canonicalName,
      type: hint.type ?? cl?.type ?? "UNKNOWN",
      description: hint.description ?? cl?.description ?? "",
      aliases: [
        canonicalName.toLowerCase(),
        ...(cl?.aliases ?? []).map((x) => x.toLowerCase()),
      ],
      episodes: [],
      created_at: epDate,
    };
    nodes.push(node);
    nodeIndex.set(id, node);
  }
  if (!node.episodes.includes(epId)) node.episodes.push(epId);
  for (const a of [canonicalName.toLowerCase(), ...(hint.aliases ?? []).map((x) => x.toLowerCase())]) {
    if (!node.aliases.includes(a)) node.aliases.push(a);
  }
  if (!node.description && hint.description) node.description = hint.description;
  if (hint.type && hint.type !== "UNKNOWN" && node.type !== hint.type) {
    if (node.type === "UNKNOWN") {
      node.type = hint.type;
    } else {
      logError(`TYPE-CONFLICT node "${node.name}" is ${node.type}, episode ${epId} claims ${hint.type}`);
    }
  }
  return id;
};

let addedNodes = 0;
let addedEdges = 0;
let mergedEdges = 0;
let droppedSelfLoops = 0;

for (const ep of episodes) {
  const epId = ep.id ?? ep.file.replace(/\.json$/, "");
  const epDate = ep.date ?? new Date().toISOString().slice(0, 10);

  const declared = new Map();
  for (const ent of ep.entities ?? []) declared.set(ent.name, ent);

  for (const ent of ep.entities ?? []) {
    const canonical = canon(ent.name, epId);
    const existed = nodeIndex.has(slug(canonical));
    ensureNode(canonical, epId, epDate, ent);
    if (!existed) addedNodes++;
  }

  for (const rel of ep.relations ?? []) {
    const cs = canon(rel.subject, epId);
    const co = canon(rel.object, epId);
    if (slug(cs) === slug(co)) {
      droppedSelfLoops++;
      logError(
        `SELF-LOOP "${rel.subject}" --[${rel.predicate}]--> "${rel.object}" in ${epId}: endpoints resolved to same entity (over-merge suspect), edge dropped`
      );
      continue;
    }
    const sid = ensureNode(cs, epId, epDate, declared.get(rel.subject) ?? {});
    const oid = ensureNode(co, epId, epDate, declared.get(rel.object) ?? {});
    const key = edgeKey(sid, rel.predicate, oid);
    const existing = edgeIndex.get(key);
    if (existing) {
      if (!existing.episodes.includes(epId)) existing.episodes.push(epId);
      mergedEdges++;
      continue;
    }
    const edge = {
      subject: sid,
      predicate: rel.predicate,
      object: oid,
      episodes: [epId],
      valid_at: rel.valid_at ?? epDate,
      invalid_at: null,
      superseded_by: null,
    };
    edges.push(edge);
    edgeIndex.set(key, edge);
    addedEdges++;
  }
}

const invFile = DIR("invalidations.json");
let appliedInvalidations = 0;
if (fs.existsSync(invFile)) {
  const inv = JSON.parse(fs.readFileSync(invFile, "utf8"));
  for (const [key, v] of Object.entries(inv)) {
    const e = edgeIndex.get(key);
    if (!e) {
      logError(`INVALIDATION-TARGET-MISSING "${key}"`);
      continue;
    }
    e.invalid_at = v.invalid_at ?? null;
    e.superseded_by = v.superseded_by ?? null;
    appliedInvalidations++;
  }
}

writeJSONL(DIR("nodes.jsonl"), nodes.sort((a, b) => a.id.localeCompare(b.id)));
writeJSONL(DIR("edges.jsonl"), edges.sort((a, b) => a.subject.localeCompare(b.subject)));

console.log(
  `assemble ok | episodes: ${episodes.length} (rejected ${rejectedEpisodes}) | nodes: ${nodes.length} (+${addedNodes}) | edges: ${edges.length} (+${addedEdges}, deduped ${mergedEdges}) | self-loops dropped: ${droppedSelfLoops} | dangling refs: ${fallbacks} | invalidations: ${appliedInvalidations}`
);
