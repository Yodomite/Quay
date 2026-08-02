#!/usr/bin/env node
// Generates a Mermaid state diagram straight from packages/core/src/domain/status.ts's
// TRANSITIONS map — so docs/generated/status-diagram.mmd (and the copy pasted into
// docs/ARCHITECTURE.md) can never silently drift from the actual status machine.
//
//   pnpm docs:status-diagram          regenerate + write the file
//   pnpm docs:status-diagram --check  fail if the checked-in file is stale (CI)
//
// Parsed with regex, not `import()` / eval — status.ts is plain data (string
// arrays), so a small regex is simpler and safer than spinning up a TS loader
// for a docs script.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const statusPath = resolve(root, "packages/core/src/domain/status.ts");
const outPath = resolve(root, "docs/generated/status-diagram.mmd");

const src = readFileSync(statusPath, "utf8");

function fail(message) {
  console.error(`[gen-status-diagram] ${message}`);
  process.exit(1);
}

// --- LINK_STATUSES: only used to find the initial state (its first entry). ---
const statusesMatch = src.match(/const LINK_STATUSES\s*=\s*\[([\s\S]*?)\]\s*as const;/);
if (!statusesMatch) fail("could not find LINK_STATUSES array — has status.ts changed shape?");
const orderedStatuses = [...statusesMatch[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
if (orderedStatuses.length === 0) fail("parsed zero entries from LINK_STATUSES");
const initialState = orderedStatuses[0];

// --- TRANSITIONS: the actual edges. ---
const transitionsMatch = src.match(/const TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\};/);
if (!transitionsMatch) fail("could not find TRANSITIONS object — has status.ts changed shape?");

const transitions = [];
const lineRe = /(\w+):\s*\[([^\]]*)\]/g;
let m;
while ((m = lineRe.exec(transitionsMatch[1]))) {
  const from = m[1];
  const tos = m[2]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  transitions.push([from, tos]);
}
if (transitions.length === 0) fail("parsed zero states from TRANSITIONS");

const lines = ["stateDiagram-v2", `  [*] --> ${initialState}`];
for (const [from, tos] of transitions) {
  if (tos.length === 0) {
    lines.push(`  ${from} --> [*]`);
    continue;
  }
  for (const to of tos) lines.push(`  ${from} --> ${to}`);
}
const rendered = lines.join("\n") + "\n";

if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = readFileSync(outPath, "utf8");
  } catch {
    // fall through — missing file is also "stale"
  }
  if (existing !== rendered) {
    console.error(
      `[gen-status-diagram] ${outPath} is out of date (or the pasted copy in docs/ARCHITECTURE.md is).\n` +
        "Run `pnpm docs:status-diagram`, update the fenced block in docs/ARCHITECTURE.md to match, and commit both.",
    );
    process.exit(1);
  }
  console.log("[gen-status-diagram] up to date.");
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, rendered);
console.log(rendered);
