#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GRAPH_DIR
  ? path.resolve(process.env.GRAPH_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = (d) => path.join(ROOT, d);

const writeJSONL = (f, arr) =>
  fs.writeFileSync(f, arr.map((o) => JSON.stringify(o)).join("\n") + "\n");
const logError = (msg) =>
  fs.appendFileSync(DIR("errors.log"), `${new Date().toISOString()} ${msg}\n`);

// G13: errors.log reflects only the most recent run — start by truncating it.
fs.writeFileSync(DIR("errors.log"), "");
const slug = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

let resolveData = { clusters: [] };
try {
  resolveData = JSON.parse(fs.readFileSync(DIR("resolve.json"), "utf8"));
} catch (err) {
  logError(`RESOLVE-REJECTED resolve.json: ${err.message}`);
}
if (!resolveData || typeof resolveData !== "object" || Array.isArray(resolveData)) {
  logError(`RESOLVE-REJECTED resolve.json: expected an object with "clusters" array`);
  resolveData = { clusters: [] };
}
const clusters = (Array.isArray(resolveData.clusters) ? resolveData.clusters : []).filter(
  (c) => c && typeof c.canonical === "string" && c.canonical.trim()
);
for (const c of clusters) {
  if ((c.aliases?.length ?? 0) > 4)
    logError(`OVER-MERGE-RISK cluster "${c.canonical}" has ${c.aliases.length} aliases - review manually`);
}
const aliasOwner = new Map();
for (const c of clusters) {
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
for (const c of clusters) {
  aliasToCanonical.set(c.canonical.toLowerCase(), c.canonical);
  for (const a of c.aliases ?? []) aliasToCanonical.set(a.toLowerCase(), c.canonical);
}

const clusterByName = new Map();
for (const c of clusters) clusterByName.set(c.canonical.toLowerCase(), c);

let rejectedEpisodes = 0;
const episodes = fs
  .readdirSync(DIR("episodes"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DIR("episodes"), f), "utf8"));
      return { file: f, ...data };
    } catch (err) {
      rejectedEpisodes++;
      logError(`EPISODE-REJECTED ${f}: ${err.message}`);
      process.exitCode = 1;
      return null;
    }
  })
  .filter(Boolean)
  .filter((ep) => {
    if (!ep.source || !String(ep.source).trim()) {
      rejectedEpisodes++;
      logError(`EPISODE-REJECTED ${ep.id ?? ep.file}: missing source - no receipt, no entry`);
      process.exitCode = 1;
      return false;
    }
    // G12/G16: shape validation
    if (ep.entities !== undefined && !Array.isArray(ep.entities)) {
      rejectedEpisodes++;
      logError(`EPISODE-REJECTED ${ep.id ?? ep.file}: entities must be an array`);
      process.exitCode = 1;
      return false;
    }
    if (ep.relations !== undefined && !Array.isArray(ep.relations)) {
      rejectedEpisodes++;
      logError(`EPISODE-REJECTED ${ep.id ?? ep.file}: relations must be an array`);
      process.exitCode = 1;
      return false;
    }
    if (!ep.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(ep.date))) {
      rejectedEpisodes++;
      logError(`EPISODE-REJECTED ${ep.id ?? ep.file}: missing or invalid date (expected YYYY-MM-DD)`);
      process.exitCode = 1;
      return false;
    }
    // G8: schema_version, default "1", only "1" supported
    const sv = ep.schema_version === undefined ? "1" : String(ep.schema_version);
    if (sv !== "1") {
      rejectedEpisodes++;
      logError(`EPISODE-REJECTED ${ep.id ?? ep.file}: unsupported schema_version "${sv}" (known: "1")`);
      process.exitCode = 1;
      return false;
    }
    for (const rel of ep.relations ?? []) {
      if (!rel || typeof rel.subject !== "string" || typeof rel.predicate !== "string" || typeof rel.object !== "string") {
        rejectedEpisodes++;
        logError(`EPISODE-REJECTED ${ep.id ?? ep.file}: relation missing subject/predicate/object string`);
        process.exitCode = 1;
        return false;
      }
    }
    for (const ent of ep.entities ?? []) {
      if (!ent || typeof ent.name !== "string" || !ent.name.trim()) {
        rejectedEpisodes++;
        logError(`EPISODE-REJECTED ${ep.id ?? ep.file}: entity missing name string`);
        process.exitCode = 1;
        return false;
      }
    }
    return true;
  });

const declaredNames = new Set();
for (const c of clusters) {
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

// G9: rebuild derived artifacts deterministically from episodes + resolve.json +
// invalidations.json on every run. Do NOT read existing nodes/edges as input,
// so deleting/editing an episode no longer leaves stale nodes/edges behind.
const nodes = [];
const edges = [];
const nodeIndex = new Map();
const edgeKey = (s, p, o) => `${slug(s)}|${slug(p)}|${slug(o)}`;
const edgeIndex = new Map(edges.map((e) => [edgeKey(e.subject, e.predicate, e.object), e]));

// G7: track which supporting episodes carry an explicit valid_at, per node/edge.
// An edge's contribution is explicit iff its relation declared rel.valid_at;
// a node's contribution is explicit iff the source episode does (top-level
// valid_at, or every one of its relations declares valid_at).
const epById = new Map();
for (const ep of episodes) epById.set(ep.id ?? ep.file.replace(/\.json$/, ""), ep);
const epHasExplicitValidAt = (ep) => {
  if (!ep) return false;
  if (typeof ep.valid_at === "string" && ep.valid_at.trim()) return true;
  const rels = Array.isArray(ep.relations) ? ep.relations : [];
  return rels.length > 0 && rels.every((r) => typeof r?.valid_at === "string" && r.valid_at.trim());
};
const nodeSupport = new Map(); // nodeId -> { all: Set<epId>, explicit: Set<epId> }
const edgeSupport = new Map(); // edgeKey -> { all: Set<epId>, explicit: Set<epId> }
const trackSupport = (map, key, epId, explicit) => {
  let s = map.get(key);
  if (!s) map.set(key, (s = { all: new Set(), explicit: new Set() }));
  s.all.add(epId);
  if (explicit) s.explicit.add(epId);
};

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
  trackSupport(nodeSupport, id, epId, epHasExplicitValidAt(epById.get(epId)));
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
  const epDate = ep.date;

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
      trackSupport(edgeSupport, key, epId, typeof rel.valid_at === "string" && rel.valid_at.trim());
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
    trackSupport(edgeSupport, key, epId, typeof rel.valid_at === "string" && rel.valid_at.trim());
    addedEdges++;
  }
}

const invFile = DIR("invalidations.json");
let appliedInvalidations = 0;
if (fs.existsSync(invFile)) {
  const inv = (() => {
    try {
      return JSON.parse(fs.readFileSync(invFile, "utf8"));
    } catch (err) {
      logError(`INVALIDATIONS-REJECTED invalidations.json: ${err.message}`);
      return null;
    }
  })();
  if (inv && (typeof inv !== "object" || Array.isArray(inv))) {
    logError(`INVALIDATIONS-REJECTED invalidations.json: expected object mapping edge keys to {invalid_at, superseded_by}`);
  } else if (inv) for (const [key, v] of Object.entries(inv)) {
    // G15: per-entry shape validation
    if (!v || typeof v !== "object" || Array.isArray(v) || (v.invalid_at !== undefined && typeof v.invalid_at !== "string") || (v.superseded_by !== undefined && typeof v.superseded_by !== "string")) {
      logError(`INVALIDATIONS-REJECTED "${key}": expected object with optional string invalid_at/superseded_by`);
      continue;
    }
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

// G14: validate superseded_by chains (targets exist, no cycles).
let supersededIssues = 0;
for (const e of edges) {
  if (!e.superseded_by) continue;
  const target = String(e.superseded_by);
  if (!edgeIndex.has(target)) {
    supersededIssues++;
    logError(`SUPERSEDED-BY-MISSING "${edgeKey(e.subject, e.predicate, e.object)}" -> "${target}"`);
    continue;
  }
  const seen = new Set([edgeKey(e.subject, e.predicate, e.object)]);
  let cur = target;
  while (cur) {
    if (seen.has(cur)) {
      supersededIssues++;
      logError(`SUPERSEDED-BY-CYCLE "${edgeKey(e.subject, e.predicate, e.object)}"`);
      break;
    }
    seen.add(cur);
    const next = edgeIndex.get(cur);
    cur = next && next.superseded_by ? String(next.superseded_by) : null;
  }
}

// G7: deterministic per-node/per-edge confidence scoring.
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const confidenceFor = (supportEpisodes, support) => {
  let c = 0.5;
  if (supportEpisodes.length >= 2) c += 0.2;
  if (support && support.all.size > 0 && [...support.all].every((epId) => support.explicit.has(epId))) c += 0.2;
  return Math.round(clamp01(c) * 100) / 100;
};
for (const node of nodes) node.confidence = confidenceFor(node.episodes, nodeSupport.get(node.id));
for (const edge of edges)
  edge.confidence = confidenceFor(edge.episodes, edgeSupport.get(edgeKey(edge.subject, edge.predicate, edge.object)));

// G7: contradiction detection over currently-active edges. Today is UTC; an edge
// is active iff valid_at <= today AND (invalid_at is null OR invalid_at > today).
const TODAY = new Date().toISOString().slice(0, 10);
const isActive = (e) =>
  typeof e.valid_at === "string" &&
  e.valid_at <= TODAY &&
  (e.invalid_at == null || (typeof e.invalid_at === "string" && e.invalid_at > TODAY));
const bySubjPred = new Map();
for (const e of edges) {
  const k = `${e.subject}|${e.predicate}`;
  if (!bySubjPred.has(k)) bySubjPred.set(k, []);
  bySubjPred.get(k).push(e);
}
let contradictions = 0;
for (const group of bySubjPred.values()) {
  const active = group.filter(isActive);
  const objs = new Set(active.map((e) => e.object));
  if (objs.size < 2) continue;
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.object === b.object) continue;
      contradictions++;
      const eps = [...new Set([...a.episodes, ...b.episodes])].sort().join(", ");
      logError(`CONTRADICTION ${a.subject} --[${a.predicate}]--> ${a.object} vs ${b.object} (episodes: ${eps})`);
    }
  }
}

writeJSONL(DIR("nodes.jsonl"), nodes.sort((a, b) => a.id.localeCompare(b.id)));
writeJSONL(DIR("edges.jsonl"), edges.sort((a, b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate) || a.object.localeCompare(b.object)));

console.log(
  `assemble ok | episodes: ${episodes.length} (rejected ${rejectedEpisodes}) | nodes: ${nodes.length} (+${addedNodes}) | edges: ${edges.length} (+${addedEdges}, deduped ${mergedEdges}) | self-loops dropped: ${droppedSelfLoops} | dangling refs: ${fallbacks} | invalidations: ${appliedInvalidations} | contradictions: ${contradictions} | superseded-by-issues: ${supersededIssues}`
);
