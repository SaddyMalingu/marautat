#!/usr/bin/env node
// Text-level guardrails for the duplicate-tenant merge SQL.
// There is no psql client on the dev box, so the merge cannot be executed here.
// What CAN be proven locally is that the scripts never delete a tenant row, stay
// read-only until an explicit two-flag opt-in, refuse to run against the wrong
// tenants, and never print a credential. These checks fail the moment one of
// those properties is edited away.
//
// Run: node scripts/test_tenant_merge_sql.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = path.join(ROOT, 'migrations', '2026-10-25_tenant_merge_01_inventory.sql');
const APPLY = path.join(ROOT, 'migrations', '2026-10-25_tenant_merge_02_apply.sql');

const KEEPER = '62828821-4a59-4775-894e-017d5da92f13';
const RETIRE = '84342b47-3a46-431d-b5f3-e8dd7f4bd979';

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
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

const inventory = read(INVENTORY);
const apply = read(APPLY);

// Strip line comments so prose in the headers cannot satisfy a code check.
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const inventoryCode = stripComments(inventory);
const applyCode = stripComments(apply);

// ---------------------------------------------------------------------------
// Both files
// ---------------------------------------------------------------------------
check('inventory file exists', inventory.length > 0, INVENTORY);
check('apply file exists', apply.length > 0, APPLY);
check('inventory names the keeper row', inventory.includes(KEEPER));
check('inventory names the retire row', inventory.includes(RETIRE));
check('apply names the keeper row', apply.includes(KEEPER));
check('apply names the retire row', apply.includes(RETIRE));
check('no DROP statements anywhere',
  !/\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)\b/i.test(inventoryCode + applyCode));
check('no TRUNCATE of an application table',
  !/TRUNCATE\s+(?!public\._tenant_merge_report\b|_merge_inventory\b|_merge_tenants\b|_merge_snapshot\b|_merge_kassangas_rows\b|_merge_kassangas\b|_merge_runtime_tables\b)\w/i
    .test(inventoryCode + applyCode));

// ---------------------------------------------------------------------------
// Inventory: read-only
// ---------------------------------------------------------------------------
check('inventory creates only a temp table',
  /CREATE\s+TEMP(ORARY)?\s+TABLE/i.test(inventoryCode));
check('inventory never updates app tables', !/\bUPDATE\s+\w/i.test(inventoryCode));
check('inventory never deletes rows', !/\bDELETE\s+FROM\b/i.test(inventoryCode));
check('inventory inserts only into its own temp tables',
  !/\bINSERT\s+INTO\s+(?!_merge_inventory\b|_merge_tenants\b|_merge_kassangas_rows\b|_merge_kassangas\b|_merge_runtime_tables\b)\w/i.test(inventoryCode));
check('inventory discovers tenant columns instead of hardcoding tables',
  /information_schema\.columns/i.test(inventoryCode) &&
  inventoryCode.includes("'bot_tenant_id'") && inventoryCode.includes("'tenant_id'"));
check('inventory counts both directions',
  /retire_rows/i.test(inventoryCode) && /keeper_rows/i.test(inventoryCode));
check('inventory masks the WhatsApp token in its output',
  /-\s*'whatsapp_access_token'/.test(inventoryCode));
check('inventory reports token presence as a boolean',
  /has_whatsapp_token/i.test(inventoryCode));
check('inventory ships the duplicate detector',
  /same normalised phone/i.test(inventoryCode) && /same name prefix/i.test(inventoryCode));
check('inventory has a balanced DO block',
  (inventory.match(/^DO \$\$/gm) || []).length === (inventory.match(/^END \$\$;/gm) || []).length);

// ---------------------------------------------------------------------------
// Apply: opt-in writes, guards first, tombstone not delete
// ---------------------------------------------------------------------------
check('apply is wrapped in a transaction',
  /^BEGIN;/m.test(applyCode) && /^COMMIT;/m.test(applyCode));
check('apply runs as a single DO block',
  (applyCode.match(/^DO \$\$/gm) || []).length === 1 &&
  (applyCode.match(/^END \$\$;/gm) || []).length === 1);
check('apply is a dry run by default', /v_dry_run\s+boolean\s*:=\s*true/.test(applyCode));
check('apply requires an explicit confirmation word',
  /v_confirm/.test(applyCode) && /v_word/.test(applyCode) &&
  /v_confirm/.test(applyCode) && /<> v_word/.test(applyCode));
check('apply refuses writes without the confirmation word',
  /write refused/i.test(applyCode));
check('apply asserts the keeper phone before writing',
  /v_keeper_phone_expected\s+constant\s+text\s*:=\s*'0702245555'/.test(applyCode));
check('apply asserts the retire phone before writing',
  /v_retire_phone_expected\s+constant\s+text\s*:=\s*'254737245555'/.test(applyCode));
check('apply aborts when the ids do not match the guards',
  /phone guard failed/i.test(applyCode));

const guardAt = applyCode.indexOf('phone guard failed');
const firstTenantWriteAt = applyCode.indexOf('UPDATE %I.bot_tenants');
const firstRepointAt = applyCode.indexOf('UPDATE %I.%I SET');
check('guards run before any tenant write',
  guardAt > -1 && firstTenantWriteAt > guardAt && firstRepointAt > guardAt,
  `guard=${guardAt} tenantWrite=${firstTenantWriteAt} repoint=${firstRepointAt}`);

check('apply never deletes a tenant row',
  !/DELETE\s+FROM\s+(%I\.bot_tenants|public\.bot_tenants|alphadome\.bot_tenants)/i.test(applyCode));
check('apply deletes only the duplicate control-settings row',
  /DELETE\s+FROM\s+%I\.%I/.test(applyCode) && applyCode.includes('bot_control_settings'));
check('control-settings special case runs before the generic repoint',
  applyCode.indexOf('bot_control_settings') > -1 &&
  applyCode.indexOf('bot_control_settings') < applyCode.indexOf('UPDATE %I.%I SET'));

check('apply tombstones the retire row instead of removing it',
  /'merged:'/.test(applyCode) && /\|\|\s*id::text/.test(applyCode));
check('tombstone marks the row inactive', /status = ''inactive''/.test(applyCode));
check('tombstone clears the portal token', /portal_token = NULL/.test(applyCode));
check('tombstone clears the retire WABA credential', /whatsapp_access_token = NULL/.test(applyCode));

check('apply repoints both tenant column names',
  applyCode.includes("('bot_tenant_id', 'tenant_id')"));
check('apply casts per column type instead of assuming uuid',
  /data_type = 'uuid' THEN 'uuid'/.test(applyCode) && /ELSE 'text'/.test(applyCode));
check('apply fills keeper fields only when the keeper value is empty',
  /k\.%I::text IS NULL OR k\.%I::text = ''/.test(applyCode));
check('apply tags the keeper metadata with the merge source',
  /merged_from/.test(applyCode));
check('apply refuses to finish if the credential did not move',
  /credential copy did not run/i.test(applyCode));
check('apply reports what it did', /_tenant_merge_report/.test(applyCode));
check('apply reports in execution order', /ORDER BY seq/.test(applyCode));
check('apply verifies the Kassangas rows afterwards',
  /Kassangas rows after merge/i.test(applyCode));
check('apply never echoes a credential value',
  !/->>\s*'whatsapp_access_token'\s+AS\b/.test(applyCode.replace(/''/g, "'")) &&
  !/AS\s+whatsapp_access_token\b/.test(applyCode) &&
  /IS NOT NULL AS has_whatsapp_token/.test(applyCode));
check('apply has balanced FOR/LOOP blocks',
  (applyCode.match(/^\s*FOR\b/gm) || []).length ===
  (applyCode.match(/END LOOP;/g) || []).length);
check('apply states the recommended keep/retire direction',
  /keeper 62828821/.test(apply) && /retire 84342b47/.test(apply));
check('inventory is schema-agnostic (public vs alphadome)',
  !/public\.bot_tenants/.test(inventoryCode) && !/alphadome\.bot_tenants/.test(inventoryCode));
check('apply is schema-agnostic (public vs alphadome)',
  !/public\.bot_tenants/.test(applyCode) && !/alphadome\.bot_tenants/.test(applyCode));
check('inventory reports which schema holds the pair',
  /pair_rows/.test(inventoryCode));
check('apply prefers the schema the application reads',
  /'public' = ANY \(v_found\)/.test(applyCode));
check('apply warns when another schema also holds the pair',
  /WARNING duplicate pair in other schemas/i.test(applyCode));
check('apply discovers the tenant schema instead of hardcoding it',
  /information_schema\.tables/.test(applyCode) && /v_found/.test(applyCode));
check('apply preflights single-column UNIQUE tenant columns',
  /pg_index/.test(applyCode) && /UNIQUE conflict needs a decision/.test(applyCode));
check('tombstone clears a duplicated phone number id',
  /clear duplicate phone number id/.test(applyCode));
check('tombstone warns about a distinct phone number id',
  /WARNING retire keeps a different phone number id/.test(applyCode));
check('apply reports brand-scoped history it cannot move',
  /WARNING brand-scoped history/.test(applyCode));

// The 2025/2026 setup migrations wrote the whole shop into alphadome while the
// server reads unqualified (public) tables, so a same-schema merge alone would
// leave the catalog behind an invisible schema boundary.
check('inventory lists every Kassangas row, not just the pair',
  /_merge_kassangas\b/.test(inventory) && /attached_rows/.test(inventory));
check('inventory counts the rows attached to each Kassangas id',
  /_merge_kassangas_rows/.test(inventory));
check('inventory checks the tables the server actually queries',
  /_merge_runtime_tables/.test(inventory) && /exists_public/.test(inventory));
check('inventory explains a missing public table is a silent failure',
  /schema-cache error/.test(inventory));
check('apply warns about same-tenant rows in another schema',
  /WARNING same tenant in another schema/.test(applyCode));
check('apply never writes to a non-target schema',
  !/UPDATE\s+alphadome\./i.test(applyCode) && !/DELETE\s+FROM\s+alphadome\./i.test(applyCode));
check('apply warns when public has no catalog table',
  /WARNING no public\.bot_products/.test(applyCode));
check('apply shadow scan normalises phones before matching',
  /regexp_replace\(regexp_replace\(coalesce\(shadow\.ph/.test(applyCode));

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

