#!/usr/bin/env node
// Approval digest: summarize pending candidate episodes from episodes/candidates/.
// Prints to stdout always. Emails via Resend HTTPS API only when:
//   GRAPH_RESEND_API_KEY and GRAPH_EMAIL_TO are set in the environment.
// Otherwise just prints a note that email is not configured.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GRAPH_DIR
  ? path.resolve(process.env.GRAPH_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAND_DIR = path.join(ROOT, "episodes", "candidates");

if (!fs.existsSync(CAND_DIR)) {
  console.log("[digest] no candidates directory — nothing pending approval");
  process.exit(0);
}

const files = fs
  .readdirSync(CAND_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.log("[digest] no pending candidates");
  process.exit(0);
}

const lines = [`${files.length} candidate episode(s) pending approval:`];
for (const f of files) {
  try {
    const ep = JSON.parse(fs.readFileSync(path.join(CAND_DIR, f), "utf8"));
    lines.push(
      `- ${f}: ${ep.relations?.length ?? 0} relation(s), ${ep.entities?.length ?? 0} entit(y/ies), source=${ep.source}, date=${ep.date}`
    );
  } catch {
    lines.push(`- ${f}: (unreadable)`);
  }
}
lines.push("Approve with: mv episodes/candidates/<file> episodes/ && node scripts/graph-assemble.mjs");

const digest = lines.join("\n");
console.log(digest);

if (process.env.GRAPH_RESEND_API_KEY && process.env.GRAPH_EMAIL_TO) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GRAPH_RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "graph-memory <digest@resend.dev>",
        to: process.env.GRAPH_EMAIL_TO,
        subject: `[graph-memory] ${files.length} candidate(s) awaiting approval`,
        text: digest,
      }),
    });
    console.log(res.ok ? "[digest] emailed" : `[digest] email failed: ${res.status}`);
  } catch (err) {
    console.log(`[digest] email error: ${err.message}`);
  }
} else {
  console.log("[digest] email not configured (set GRAPH_RESEND_API_KEY and GRAPH_EMAIL_TO to enable)");
}
