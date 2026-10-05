#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GRAPH_DIR
  ? path.resolve(process.env.GRAPH_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = (d) => path.join(ROOT, d);
const slug = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const runAssemble = () =>
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "graph-assemble.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });

const tools = [
  {
    name: "graph_query",
    description: "Query the knowledge graph from a seed entity through N hops.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", description: "Entity name or alias" },
        hops: { type: "number", description: "Hop distance (default 2)" },
        all: { type: "boolean", description: "Include invalidated/inactive facts" },
        as_of: { type: "string", description: "ISO date YYYY-MM-DD; default today" },
      },
      required: ["seed"],
    },
  },
  {
    name: "graph_add_episode",
    description: "Add a new episode JSON to episodes/ and rebuild the graph.",
    inputSchema: {
      type: "object",
      properties: {
        episode: { type: "object", description: "Episode object with id/source/date/entities/relations" },
      },
      required: ["episode"],
    },
  },
  {
    name: "graph_invalidate",
    description: "Mark an edge inactive from invalid_at onward (optionally superseded_by).",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        predicate: { type: "string" },
        object: { type: "string" },
        invalid_at: { type: "string", description: "YYYY-MM-DD" },
        superseded_by: { type: "string", description: "Optional replacement edge key" },
      },
      required: ["subject", "predicate", "object", "invalid_at"],
    },
  },
  {
    name: "graph_search",
    description: "Ranked full-text search over node name/description/aliases/type (FTS5 via node:sqlite, substring fallback).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        top: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "graph_stats",
    description: "Report episode/node/edge counts and whether errors.log is non-empty.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "graph-memory", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  try {
    if (req.params.name === "graph_query") {
      const argv = [path.join(ROOT, "scripts", "graph-query.mjs"), String(args.seed)];
      if (args.hops) argv.push(`--hops=${Number(args.hops)}`);
      if (args.all) argv.push("--all");
      if (args.as_of) argv.push(`--as-of=${args.as_of}`);
      const out = execFileSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8" });
      return { content: [{ type: "text", text: out }] };
    }
    if (req.params.name === "graph_add_episode") {
      const ep = args.episode;
      if (!ep || typeof ep !== "object" || !ep.id)
        throw new Error("episode must be an object with an id");
      const file = path.join(DIR("episodes"), `${slug(ep.id)}.json`);
      fs.writeFileSync(file, JSON.stringify(ep, null, 2) + "\n");
      const out = runAssemble();
      return { content: [{ type: "text", text: `wrote ${file}\n${out}` }] };
    }
    if (req.params.name === "graph_invalidate") {
      const key = `${slug(args.subject)}|${slug(args.predicate)}|${slug(args.object)}`;
      const invFile = DIR("invalidations.json");
      const inv = fs.existsSync(invFile)
        ? JSON.parse(fs.readFileSync(invFile, "utf8"))
        : {};
      inv[key] = { invalid_at: args.invalid_at, superseded_by: args.superseded_by ?? null };
      fs.writeFileSync(invFile, JSON.stringify(inv, null, 2) + "\n");
      const out = runAssemble();
      return { content: [{ type: "text", text: `invalidated ${key}\n${out}` }] };
    }
    if (req.params.name === "graph_search") {
      if (!args.query || typeof args.query !== "string")
        throw new Error("query is required");
      const argv = [path.join(ROOT, "scripts", "graph-search.mjs"), args.query];
      if (args.top) argv.push(`--top=${Number(args.top)}`);
      const out = execFileSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8" });
      return { content: [{ type: "text", text: out }] };
    }
    if (req.params.name === "graph_stats") {
      const count = (f) =>
        fs.existsSync(DIR(f))
          ? fs.readFileSync(DIR(f), "utf8").split("\n").filter(Boolean).length
          : 0;
      const episodes = fs.existsSync(DIR("episodes"))
        ? fs.readdirSync(DIR("episodes")).filter((f) => f.endsWith(".json")).length
        : 0;
      const errors = fs.existsSync(DIR("errors.log"))
        ? fs.readFileSync(DIR("errors.log"), "utf8").trim().length
        : 0;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                episodes,
                nodes: count("nodes.jsonl"),
                edges: count("edges.jsonl"),
                errorsPending: errors > 0,
              },
              null,
              2
            ),
          },
        ],
      };
    }
    throw new Error(`unknown tool: ${req.params.name}`);
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: String(err.message ?? err) }] };
  }
});

await server.connect(new StdioServerTransport());
