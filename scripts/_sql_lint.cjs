#!/usr/bin/env node
/**
 * Lightweight STRUCTURAL sanity check for the Phase 1 migration SQL.
 * NOT a Postgres parser - it catches the specific classes of hand-edit bugs:
 *   - unterminated statements (a top-level keyword right after an unterminated ')')
 *   - unbalanced $$ dollar-quote blocks
 *   - BEGIN/COMMIT and DO/END imbalance
 *   - missing final semicolon after COMMIT
 * Run: node scripts/_sql_lint.cjs <file.sql>
 */
const fs = require("fs");
const file = process.argv[2];
if (!file) { console.error("usage: node _sql_lint.cjs <file.sql>"); process.exit(2); }
const raw = fs.readFileSync(file, "utf8");

// 1) Balance check on dollar-quote ($$) pairs across the WHOLE file.
const dollarCount = (raw.match(/\$\$/g) || []).length;
const dollarBalanced = dollarCount % 2 === 0;

// 2) Strip dollar-quoted bodies so we don't parse PL/pgSQL internals.
const noDollar = raw.replace(/\$\$[\s\S]*?\$\$/g, " /*DOBLOCK*/ ");

// 3) Count top-level transaction + DO block markers on the stripped text.
const beginCount = (noDollar.match(/^\s*BEGIN\b/gim) || []).length;
const commitCount = (noDollar.match(/^\s*COMMIT\b/gim) || []).length;
const doCount = (noDollar.match(/^\s*DO\b/gim) || []).length;
// END $$ lines were stripped; recover them by counting on original per-line.
const endCount = (raw.match(/^\s*END\s*\$\$/gim) || []).length;

// 4) Per-line terminator scan on the dollar-stripped, comment-stripped text.
const problems = [];
let lastSignificant = "";
const lines = noDollar.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  let t = lines[i].replace(/--.*$/, "").trim();   // drop comments
  if (!t) continue;
  t = t.replace(/\/\*DOBLOCK\*\//g, "").trim();
  if (!t) continue;

  const startsStatement = /^(ALTER|CREATE|INSERT|UPDATE|DROP|GRANT|COMMENT)\b/i.test(t);
  if (startsStatement && lastSignificant === ")") {
    problems.push(`near: '${t.slice(0, 34)}...' follows an unterminated ')'`);
  }
  lastSignificant = t.slice(-1);
}

let lastMeaningful = "";
for (let j = lines.length - 1; j >= 0; j--) {
  const t = lines[j].trim();
  if (!t || t.startsWith("--")) continue;
  lastMeaningful = t;
  break;
}

console.log(`file: ${file}`);
console.log(`BEGIN=${beginCount} COMMIT=${commitCount} DO=${doCount} END$$=${endCount} dollarBalanced=${dollarBalanced}`);
console.log(`last meaningful line: ${lastMeaningful.slice(0, 40)}`);

let ok = true;
if (beginCount !== commitCount) { ok = false; problems.push(`BEGIN(${beginCount}) != COMMIT(${commitCount})`); }
if (doCount !== endCount) { ok = false; problems.push(`DO(${doCount}) != END$$(${endCount})`); }
if (!dollarBalanced) { ok = false; problems.push(`unbalanced $$ (count=${dollarCount})`); }
if (!/;\s*$/.test(lastMeaningful)) { ok = false; problems.push("file does not end with ';' after COMMIT"); }

if (problems.length) {
  console.log("\nPROBLEMS:");
  for (const p of problems) console.log(" - " + p);
  process.exit(1);
}
console.log("\nSTRUCTURE OK");
process.exit(0);
