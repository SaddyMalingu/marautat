#!/usr/bin/env node
// Text-level guardrails for the bot schema reconcile SQL (diagnose 01 + apply 02).
// There is no psql client on the dev box, so the migration cannot be executed
// here. What CAN be proven locally is that the pair stays read-only by default,
// never deletes a row, never promotes a tenant that owns no catalogue, never
// replaces a real public table with a view, and never prints a credential.
//
// Run: node scripts/test_bot_schema_reconcile_sql.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIAGNOSE = path.join(ROOT, 'migrations', '2026-10-25_bot_schema_reconcile_01_diagnose.sql');
const APPLY = path.join(ROOT, 'migrations', '2026-10-25_bot_schema_reconcile_02_apply.sql');

// The identity that owns the 24 products in alphadome.bot_tenants (section D of
// the 2026-10-25 diagnose run). Everything else is a portal shell.
const KEEPER = '2330bdfe-7b4d-476f-ad0d-ba1b2caeed12';
const RETIRE = [
  '62828821-4a59-4775-894e-017d5da92f13',
  '84342b47-3a46-431d-b5f3-e8dd7f4bd979',
];

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// Strip line comments so prose in the headers cannot satisfy a code check.
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

const diagnose = read(DIAGNOSE);
const apply = read(APPLY);
const MERGE_COPY = path.join(ROOT, 'migrations',
  '2026-10-25_bot_schema_reconcile_02_apply.MERGE.sql');
const merge = read(MERGE_COPY);
const VERIFY = path.join(ROOT, 'migrations',
  '2026-10-25_bot_schema_reconcile_03_verify.sql');
const verify = read(VERIFY);
const diagnoseCode = stripComments(diagnose);
const applyCode = stripComments(apply);

// ---------------------------------------------------------------------------
// Dollar-quote tags and parenthesis balance (a broken pair kills the whole run)
// ---------------------------------------------------------------------------
function structure(sql) {
  const stack = [];
  let depth = 0;
  let minDepth = 0;
  let inSingle = false;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (!inSingle && sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (!inSingle && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 40));
      if (m) {
        const tag = m[1] || '';
        if (stack.length && stack[stack.length - 1] === tag) stack.pop();
        else stack.push(tag);
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "'") {
      if (!inSingle) { inSingle = true; continue; }
      if (sql[i + 1] === "'") { i += 1; continue; }
      inSingle = false;
      continue;
    }
    if (inSingle || stack.length) continue;
    if (c === '(') depth += 1;
    if (c === ')') { depth -= 1; if (depth < minDepth) minDepth = depth; }
  }
  return { openTags: stack.length, depth, minDepth, inSingle };
}

const diagShape = structure(diagnose);
const applyShape = structure(apply);

// ---------------------------------------------------------------------------
// Diagnose 01 must stay read-only
// ---------------------------------------------------------------------------
check('diagnose file exists', diagnose.length > 0, DIAGNOSE);
check('apply file exists', apply.length > 0, APPLY);
check('diagnose dollar quotes balanced', diagShape.openTags === 0, JSON.stringify(diagShape));
check('diagnose parens balanced', diagShape.depth === 0 && diagShape.minDepth === 0);
check('diagnose never writes an application table',
  !/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public|alphadome)\./i.test(diagnoseCode));
check('diagnose only writes its own temp grid',
  (diagnoseCode.match(/INSERT\s+INTO\s+\w+/gi) || [])
    .every((s) => /INSERT\s+INTO\s+_diag/i.test(s)));
check('diagnose stays generic - no hardcoded tenant uuid',
  !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(diagnoseCode));

// ---------------------------------------------------------------------------
// Apply 02 structure
// ---------------------------------------------------------------------------
check('apply dollar quotes balanced', applyShape.openTags === 0, JSON.stringify(applyShape));
check('apply parens balanced', applyShape.depth === 0 && applyShape.minDepth === 0);
// A DO block that loses its END is invisible to tag balancing - the next DO's
// opener simply closes the previous body - so track nesting order explicitly.
check('every DO block closes before the next one opens', (() => {
  let depth = 0;
  let ok = true;
  apply.split('\n').forEach((line) => {
    if (/^\s*DO \$/.test(line)) {
      if (depth > 0) ok = false;
      depth += 1;
    } else if (/^\s*END \$[A-Za-z_]*\$;/.test(line)) {
      depth -= 1;
      if (depth < 0) ok = false;
    }
  });
  return ok && depth === 0;
})());
check('apply has no unterminated literal', applyShape.inSingle === false);
check('apply is one transaction', /^BEGIN;/m.test(apply) && /^COMMIT;/m.test(apply));
check('BEGIN precedes the first DO block',
  apply.indexOf('BEGIN;') > -1 && apply.indexOf('BEGIN;') < apply.indexOf('DO $'));
check('progress is reported through one grid table',
  apply.includes('public._bot_reconcile_report'));
// The header prose claimed "the other 9 are MISSING" / "the 9 domain tables"
// while G actually creates 10 - a contradiction that reads as a failed run.
check('header agrees with the real view count (10 domain tables)',
  /the other 10 are MISSING/.test(apply) && /the 10 domain tables/.test(apply),
  /the other 9 are MISSING/.test(apply) ? 'stale 9 in header' : '');
// The SQL Editor renders only the LAST result set. A SELECT after the report
// replaces the grid, so the operator reads a different query's rows and thinks
// the run produced nothing - the exact confusion on the 2026-10-25 dry run.
check('the report grid is the last statement in the file', (() => {
  const at = applyCode.lastIndexOf('public._bot_reconcile_report');
  if (at === -1) return false;
  return /^public\._bot_reconcile_report\s+ORDER BY seq;$/.test(applyCode.slice(at).trim());
})(), applyCode.slice(applyCode.lastIndexOf('public._bot_reconcile_report')).trim().slice(0, 120));
// A dry run writes nothing, so no report row may claim a write. Two sections
// used to print a literal 1 (C. tombstone, E. cleared duplicate), which read as
// "already done" in a preview. Pin them to the flag.
check('write counts are 0 on a dry run', (() => {
  const at = (needle) => applyCode.indexOf(needle);
  const near = (i, re) => i > -1 && re.test(applyCode.slice(i, i + 400));
  return near(at("'C. tombstone'"), /CASE WHEN v_dry THEN 0 ELSE 1 END/)
      && near(at("'E. cleared duplicate unique value'"), /CASE WHEN v_dry THEN 0 ELSE v_n END/);
})());
// Section B adds its columns only on an apply run, so probing public for them
// directly made a dry run under-report section D and the write pass then showed
// unexpected extra lines. A column that does not exist holds nothing.
check('D previews the columns B will add instead of skipping them',
  /v_pub_has\s*:=\s*EXISTS/.test(applyCode) && /IF v_pub_has THEN/.test(applyCode));

// ---------------------------------------------------------------------------
// Dry run is the default, and the write word is required
// ---------------------------------------------------------------------------
check('apply defaults to dry_run true and empty confirm',
  /INSERT INTO _bot_reconcile_ctl[\s\S]{0,240}?\btrue,\s*''/.test(applyCode));
check('apply refuses to write without the write word',
  /IF NOT v_dry AND coalesce\(v_confirm, ''\) <> 'MERGE' THEN/.test(applyCode)
    && /write refused/.test(applyCode));
check('every section reads the flags from the ctl row',
  (applyCode.match(/FROM _bot_reconcile_ctl/g) || []).length >= 6,
  String((applyCode.match(/FROM _bot_reconcile_ctl/g) || []).length));

// ---------------------------------------------------------------------------
// Identity: keeper owns the catalogue, shells are tombstoned, nothing deleted
// ---------------------------------------------------------------------------
check('apply names the catalogue keeper uuid', apply.includes(KEEPER));
for (const id of RETIRE) {
  check(`apply names retire id ${id.slice(0, 8)}`, apply.includes(id));
}
check('apply refuses a keeper without products', /owns no products/.test(applyCode));
check('apply checks the keeper exists in alphadome first',
  /keeper % not found in alphadome\.bot_tenants/.test(applyCode));
check('apply checks retire ids all exist in public',
  /retire ids not all present in public\.bot_tenants/.test(applyCode));
check('tombstone section runs before the promote section',
  apply.indexOf('-- C)') > -1 && apply.indexOf('-- C)') < apply.indexOf('-- E)'));
check('tombstone rewrites the phone instead of deleting',
  /'merged:' \|\| v_row\.id/.test(applyCode));
check('tombstone clears the portal token', /portal_token = NULL/.test(applyCode));
check('no DELETE of any row', !/DELETE\s+FROM/i.test(applyCode));
check('no TRUNCATE of an application table',
  !/TRUNCATE\s+(?!public\._bot_reconcile_report|_bot_reconcile_ctl)\w/i.test(applyCode));
check('DROP only touches the report table and the trigger',
  (applyCode.match(/DROP\s+TABLE\s+(?:IF EXISTS\s+)?([\w.]+)/gi) || [])
    .every((s) => /_bot_reconcile_(report|ctl)/.test(s)));

// ---------------------------------------------------------------------------
// Columns: copied from alphadome, generated columns skipped, nothing guessed
// ---------------------------------------------------------------------------
check('missing public columns take their type from alphadome',
  /format_type\(a\.atttypid, a\.atttypmod\)/.test(applyCode)
    && /ADD COLUMN IF NOT EXISTS %I %s%s/.test(applyCode));
check('generated and identity columns are never copied',
  /a\.attidentity = ''/.test(applyCode) && /a\.attgenerated = ''/.test(applyCode));
check('promote refuses NOT NULL portal columns it cannot fill',
  /has NOT NULL columns with no default that alphadome cannot fill/.test(applyCode));
check('promote forces status active',
  /v_exprs := v_exprs \|\| ', ''active'''/.test(applyCode));
// server.js:2251 prefers the raw is_active boolean over status, so copying a
// false/NULL from alphadome would promote a row its own phone lookup rejects.
check('promote forces is_active true instead of copying it', (() => {
  const forced = /v_exprs := v_exprs \|\| ', true'/.test(applyCode);
  const excluded = /'portal_token_issued_at', 'is_active'\)/.test(applyCode);
  const explained = /is_active forced true/.test(applyCode);
  return forced && excluded && explained;
})());

// ---------------------------------------------------------------------------
// Views: public surface over alphadome, no public table is ever replaced
// ---------------------------------------------------------------------------
check('views are created over alphadome',
  /CREATE OR REPLACE VIEW public\.%I AS SELECT \* FROM alphadome\.%I/.test(applyCode));
check('the view sweep is limited to bot_* and skips bot_tenants',
  /left\(c\.relname, 4\) = 'bot_'/.test(applyCode)
    && /c\.relname <> 'bot_tenants'/.test(applyCode));
check('a real public table is skipped, not replaced',
  /a real public table owns that name/.test(applyCode)
    && /c2\.relkind IN \('r', 'p', 'm'\)/.test(applyCode));
check('a shadowed name reports both row counts, not just a name',
  /public rows: %s, alphadome rows: %s/.test(applyCode));
check('an empty shadow escalates instead of passing as success',
  /IF v_pub = 0 AND v_alpha > 0 THEN/.test(applyCode)
    && /a real but EMPTY table while alphadome/.test(applyCode));
check('the view totals are counted, never typed in',
  /v_skipped := v_skipped \+ 1/.test(applyCode)
    && /format\('%s to create, %s skipped', v_created, v_skipped\)/.test(applyCode));
check('is_active mirrors status the way isTenantRecordActive does, blank included',
  applyCode.includes("'B. is_active normalised'")
    && applyCode.includes("coalesce(lower(trim(status)), '''')")
    && applyCode.includes("IN ('''', ''active'')"));
check('the normalisation never touches the shell rows it excludes',
  /USING v_retire/.test(applyCode));
check('views are granted to the api roles',
  /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.%I TO %I/.test(applyCode)
    && /rolname = v_role/.test(applyCode));
check('view creation is gated by the dry-run flag',
  /IF NOT v_dry THEN\s*\n\s*EXECUTE format\('CREATE OR REPLACE VIEW/.test(applyCode));
check('postgrest cache is reloaded after the DDL',
  /NOTIFY pgrst, 'reload schema'/.test(apply));

// ---------------------------------------------------------------------------
// Credentials: rescued, mirrored, never printed
// ---------------------------------------------------------------------------
check('credential rescue only fills a NULL keeper value',
  /SELECT %I IS NOT NULL FROM alphadome\.bot_tenants WHERE id = \$1/.test(applyCode)
    && /keeper already has/.test(applyCode));
check('ambiguous credentials stop and are reported',
  /D\. WARNING ambiguous/.test(applyCode));
check('the report says values are not printed', /value not printed/.test(applyCode));
check('mirror trigger pushes portal edits to alphadome',
  /CREATE TRIGGER bot_tenants_mirror/.test(applyCode)
    && /UPDATE alphadome\.bot_tenants x SET %s WHERE x\.id = \$1/.test(applyCode));
check('mirror never copies timestamps or portal secrets',
  /'created_at', 'updated_at', 'status'/.test(applyCode)
    && /'portal_token_issued_at'/.test(applyCode));
check('no secret is raised as a notice or exception',
  !/RAISE (NOTICE|EXCEPTION)[^;]*whatsapp_access_token/i.test(applyCode));

// ---------------------------------------------------------------------------
// Re-keying is scoped: site_tenants ids are never touched
// ---------------------------------------------------------------------------
check('re-key is limited to FK-to-bot_tenants or wf_campaigns',
  /c\.relname = 'wf_campaigns'/.test(applyCode)
    && /con\.confrelid = 'public\.bot_tenants'::regclass/.test(applyCode));
check('re-key deliberately skips unrelated tenant_id tables',
  /blog_posts\.tenant_id points at site_tenants/.test(apply));

// ---------------------------------------------------------------------------
// The generated write-mode copy must not drift from the audited script
// ---------------------------------------------------------------------------
// `.MERGE.sql` exists so the operator never hand-edits flags at 2am. It is a
// copy, so it can rot: if _02 changes and the copy is not regenerated, the write
// pass runs different SQL from the one that was reviewed. Compare them with
// comments stripped and the two flag values normalised to a placeholder.
function normForCompare(sql) {
  return stripComments(sql)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /INSERT INTO _bot_reconcile_ctl \(dry_run, confirm, keeper, retire\) VALUES \( (?:true|false), (?:''|'MERGE'),/,
      'INSERT INTO _bot_reconcile_ctl (FLAGS) VALUES ( <FLAGS>,');
}
check('the write-mode copy exists', merge.length > 0);
check('the write-mode copy is flagged false / MERGE',
  /INSERT INTO _bot_reconcile_ctl[\s\S]{0,120}?\bfalse,\s*'MERGE'/.test(stripComments(merge)));
check('the write-mode copy matches the audited script apart from the flags',
  normForCompare(apply) === normForCompare(merge));

// Re-running the apply must not stack merge notes on the tombstoned shells.
check('the merge note is appended at most once (re-run safe)',
  /position\(%L in coalesce\(description, %L\)\) > 0/.test(applyCode));

// ---------------------------------------------------------------------------
// The verify file is pasted into production: it must never write
// ---------------------------------------------------------------------------
// It runs after the apply, on a live tenant. One stray UPDATE in it and the
// "read only" promise in its header is a lie, so assert the promise.
const verifyCode = stripComments(verify);
check('the verify file exists and is one statement',
  verify.length > 0 && (verifyCode.match(/;/g) || []).length === 1);
check('the verify file only reads',
  !/^\s*(insert|update|delete|create|drop|alter|truncate|grant|revoke|do|call)\b/im
    .test(verifyCode));
check('the verify file counts the tens of views without miscounting bot_tenants',
  /table_name <> 'bot_tenants'/.test(verifyCode));
check('the verify file never prints a secret, only fingerprints',
  /md5\(coalesce\(p\.whatsapp_access_token/.test(verifyCode)
    && !/SELECT[^;]*whatsapp_access_token\s*$/im.test(verifyCode));

// A bare count is not actionable: a stray bot_* table may be a harmless leftover
// or an empty twin that starves the portal, and only the name distinguishes them.
check('the verify file names shadowing base tables, not just counts them',
  /'V\. shadowing table'/.test(verifyCode)
    && /table_type = 'BASE TABLE'/.test(verifyCode));
// public keeps legacy columns alphadome never had, so equal counts prove nothing.
// The real assertion is that every alphadome column exists in public.
check('the verify file asserts alphadome columns are a subset of public',
  /'V\. missing columns'/.test(verifyCode)
    && /column_name NOT IN \(\s*SELECT column_name FROM information_schema\.columns\s*WHERE table_schema = 'public'/.test(verifyCode));
check('the verify file does not claim the column counts must be equal',
  /public may hold legacy extras/.test(verifyCode));
check('the verify orphan count ignores tombstoned shells',
  /coalesce\(p\.is_active, true\)/.test(verifyCode));
// A public-only bot_* table (bot_outputs) shadows nothing: only a base table
// whose name also exists in alphadome can starve a view.
check('the verify shadow count only counts tables with an alphadome twin',
  /shadowing base tables in public'[\s\S]{0,400}EXISTS \(SELECT 1 FROM information_schema\.tables a/.test(verifyCode));
check('the verify shadow name arm only names tables with an alphadome twin',
  /'V\. shadowing table'[\s\S]{0,400}a\.table_schema = 'alphadome'/.test(verifyCode));
check('the verify file lists public-only bot_* tables instead of alarming about them',
  /'V\. public-only table'/.test(verifyCode)
    && /NOT EXISTS \(SELECT 1 FROM information_schema\.tables a/.test(verifyCode));
// G creates only bot_* views, so a same-named non-bot table (public.products vs
// alphadome.products) shadows nothing and must not be reported as one.
check('the verify shadow name arm stays scoped to bot_* names',
  /'V\. shadowing table'[\s\S]{0,300}t\.table_name ~ '\^bot_'/.test(verifyCode));

// ---------------------------------------------------------------------------
// Step 4 promotes Coach Dawn into alphadome. It writes to the credential store,
// so the same rules apply: opt-in, idempotent, no deletes, no value clearing.
// ---------------------------------------------------------------------------
const COACHDAWN = path.join(ROOT, 'migrations',
  '2026-10-25_bot_schema_reconcile_04_coachdawn.sql');
const coachdawn = read(COACHDAWN);
const cdCode = stripComments(coachdawn);
const cdShape = structure(coachdawn);

check('the coachdawn file exists', coachdawn.length > 0, COACHDAWN);
check('the coachdawn file is balanced', cdShape.openTags === 0
  && cdShape.depth === 0 && cdShape.minDepth === 0, JSON.stringify(cdShape));
// Same trap as _02: a DO block that loses its END is invisible to tag balancing.
check('every coachdawn DO block closes before the next one opens', (() => {
  let depth = 0;
  let ok = true;
  coachdawn.split('\n').forEach((line) => {
    if (/^\s*DO \$/.test(line)) {
      if (depth > 0) ok = false;
      depth += 1;
    } else if (/^\s*END \$[A-Za-z_]*\$;/.test(line)) {
      depth -= 1;
      if (depth < 0) ok = false;
    }
  });
  return ok && depth === 0;
})());
check('the coachdawn file has one transaction', (cdCode.match(/\bBEGIN;/g) || []).length === 1
  && (cdCode.match(/\bCOMMIT;/g) || []).length === 1);
check('the coachdawn file defaults to a dry run',
  /INSERT INTO _bot_coachdawn_ctl \(dry_run, confirm, tenant\) VALUES \(\s*true,\s*'',/
    .test(cdCode));
check('the coachdawn file refuses to write without the MERGE confirmation',
  /coalesce\(v_confirm, ''\) <> 'MERGE'/.test(cdCode));
check('the coachdawn file targets Coach Dawn 3.0 and nobody else',
  (cdCode.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])
    .every((u) => u.toLowerCase() === 'cfc89b88-cc67-4655-ab06-b823b93a73e2'));
check('the coachdawn file refuses to promote a tombstoned shell',
  /LIKE 'merged:%'/.test(cdCode));
check('the coachdawn file is idempotent', /already in alphadome - skipped/.test(cdCode));
check('the coachdawn file never deletes a row', !/\bDELETE\s+FROM\b/i.test(cdCode));
// _02 cleared duplicate values on the dead shells. Doing that in alphadome would
// rewrite the credential store, so this script must abort instead.
check('the coachdawn file never updates alphadome - insert or abort only',
  !/\bUPDATE\s+alphadome\b/i.test(cdCode) && /\bINSERT INTO alphadome\.bot_tenants\b/.test(cdCode));
check('the coachdawn file aborts on a unique collision instead of clearing values',
  /alphadome already has a different row with %/.test(cdCode));
check('the coachdawn file checks fillability before writing',
  /requires % with no default and public cannot supply it/.test(cdCode));
// The uuid must survive verbatim, so an identity column cannot be allowed to
// allocate a new one, and generated columns cannot be written at all.
check('the coachdawn file keeps the source uuid against an identity column',
  /OVERRIDING SYSTEM VALUE/.test(cdCode));
check('the coachdawn file skips generated columns', /is_generated = 'NEVER'/.test(cdCode));
// `status` is public-only, so "status/is_active forced" was a claim the schema
// could not honour. The report must name only the flags it actually forced.
check('the coachdawn report names the flags it actually forced',
  /forced: %s/.test(cdCode) && /v_forced := v_forced/.test(cdCode));
check('the coachdawn file normalises the phone the lookup actually matches',
  /regexp_replace\(coalesce\(v_raw, ''\), '\\D', '', 'g'\)/.test(cdCode)
    && /WHEN left\(v_dig, 3\) = '254' AND length\(v_dig\) = 12/.test(cdCode));
check('the coachdawn file forces the active flags rather than copying them',
  /v_exprs\s*:=\s*v_exprs \|\| ', ''active'''/.test(cdCode)
    && /v_exprs\s*:=\s*v_exprs \|\| ', true'/.test(cdCode));
check('the coachdawn file never selects a credential, only excludes portal state',
  !/whatsapp_access_token/i.test(cdCode)
    && /column_name NOT IN \('status', 'description', 'portal_token'/.test(cdCode));
check('the coachdawn file keeps its own report table',
  /public\._bot_coachdawn_report/.test(cdCode) && !/_bot_reconcile_report/.test(cdCode));
check('the coachdawn grid is the last statement', cdCode.trim().endsWith('ORDER BY seq;'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);



