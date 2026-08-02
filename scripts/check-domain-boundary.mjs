#!/usr/bin/env node
// Enforces "the domain never imports a chain SDK": fails if packages/core
// imports anything chain-specific. Run via `pnpm docs:check-domain-boundary`
// (wired into CI) — see docs/ARCHITECTURE.md's "Enforcement" section.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, "..", "packages/core/src");

// Anything importing one of these from packages/core is a boundary violation.
// Not "everything outside @checkout/core" — zod (validation) is fine; the rule
// is specifically about chain/anchor SDKs and I/O, not all third-party code.
const FORBIDDEN_SPECIFIERS = [/^@stellar\//, /^node:/, /^@checkout\/stellar/, /^@checkout\/offramp/];

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["'];?/gm;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

const violations = [];
for (const file of walk(coreSrc)) {
  const src = readFileSync(file, "utf8");
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    const specifier = m[1];
    if (FORBIDDEN_SPECIFIERS.some((re) => re.test(specifier))) {
      violations.push(`${file}: imports "${specifier}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("[check-domain-boundary] packages/core imports a chain SDK / I/O module:\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nThe domain (packages/core) must stay chain-agnostic — put this behind a port " +
      "(RailPort / WatcherPort / OffRampPort) and implement it in an adapter package instead.",
  );
  process.exit(1);
}

console.log(`[check-domain-boundary] clean — no chain SDK imports in packages/core/src.`);
