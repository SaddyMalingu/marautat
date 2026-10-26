// Behaviour of the Writer's Flow campaign insert.
//
// Context (live 2026-10-26): `POST /tenant/wf/campaigns 500 - 961ms` in the
// Render log — one database round trip inside the insert, no server-side log
// line, and two incompatible `wf_campaigns` shapes in this repo. The client is
// faked here so each schema the deployment might have can be replayed: an `id`
// with no default, a table missing optional columns, a `status` check
// constraint, and a table that cannot hold a campaign at all.
//
// Run: npm run test:wf-create   (no server, no database required)
import { insertWfCampaign, describeWfCampaignError } from '../utils/wfCampaigns.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A Supabase-shaped client: `from().insert().select().maybeSingle()`.
// `behave(row, attempt)` decides what the database answers.
function fakeClient(behave) {
  const sent = [];
  return {
    sent,
    from() {
      return {
        insert(rows) {
          const row = JSON.parse(JSON.stringify(rows[0]));
          return {
            select() {
              return {
                async maybeSingle() {
                  sent.push(row);
                  return behave(row, sent.length - 1);
                },
              };
            },
          };
        },
      };
    },
  };
}

const missingColumn = (column, style = 'schema-cache') => ({
  code: 'PGRST204',
  message: style === 'schema-cache'
    ? `Could not find the '${column}' column of 'wf_campaigns' in the schema cache`
    : `column wf_campaigns.${column} does not exist`,
});

const BASE = {
  name: 'Q4 schools',
  keywords: ['school fees', 'bursary'],
  industries: [],
  outreach_types: ['pitch'],
  channels: ['email'],
  target_count: 10,
  quality_threshold: 70,
  status: 'draft',
  tenant_id: '11111111-2222-3333-4444-555555555555',
};

// ---- 1. The happy path ------------------------------------------------------
{
  const client = fakeClient((row) => ({ data: { ...row, created_at: '2026-10-26T07:00:00Z' }, error: null }));
  const campaign = await insertWfCampaign(client, BASE);
  ok('the stored row comes back', campaign.created_at === '2026-10-26T07:00:00Z', JSON.stringify(campaign));
  ok('the row is scoped to the tenant', campaign.tenant_id === BASE.tenant_id);
  ok('the request carries an id even though the caller sent none', UUID.test(campaign.id || ''), String(campaign.id));
  ok("the caller's payload is not mutated", BASE.id === undefined, String(BASE.id));
}

// ---- 2. A `text PRIMARY KEY` with no default -------------------------------
// The 2026-05-03 table shape: without a client-supplied id every insert dies on
// `null value in column "id"`. The retry loop cannot invent one afterwards, so
// the id has to be in the first request.
{
  const seen = [];
  const client = fakeClient((row) => {
    seen.push(row.id);
    return row.id
      ? { data: row, error: null }
      : { data: null, error: { code: '23502', message: 'null value in column "id" of relation "wf_campaigns" violates not-null constraint' } };
  });
  const campaign = await insertWfCampaign(client, BASE);
  ok('a table with no id default still accepts the insert', UUID.test(campaign.id || ''), JSON.stringify(seen));
  ok('the id is sent on the first attempt, not invented after a failure', seen.length === 1 && UUID.test(seen[0] || ''), String(seen.length));
}


// ---- 3. Columns the live table does not have -------------------------------
{
  const client = fakeClient((row) =>
    'channels' in row
      ? { data: null, error: missingColumn('channels') }
      : 'quality_threshold' in row
        ? { data: null, error: missingColumn('quality_threshold', 'postgres') }
        : { data: row, error: null });
  const campaign = await insertWfCampaign(client, BASE);
  ok('optional columns are dropped one at a time until the insert lands', client.sent.length === 3, String(client.sent.length));
  ok('the campaign keeps its name and keywords', campaign.name === BASE.name && campaign.keywords.length === 2);
  ok('a column dropped on retry stays dropped', !('channels' in client.sent[2]) && !('quality_threshold' in client.sent[2]));
}


// ---- 4. Columns we must never drop ----------------------------------------
for (const column of ['name', 'keywords']) {
  const client = fakeClient(() => ({ data: null, error: missingColumn(column) }));
  let caught = null;
  try { await insertWfCampaign(client, BASE); } catch (err) { caught = err; }
  ok(`a missing "${column}" column fails loudly instead of creating a nameless campaign`, Boolean(caught));
  ok(`the "${column}" error names the migration to run`, /2026-04-20_writers_flow_tables\.sql/.test(caught?.message || ''), caught?.message);
  ok(`the "${column}" error is marked as a migration problem`, caught?.migrationRequired === true);
  ok(`the "${column}" case is not retried into a silent success`, client.sent.length === 1, String(client.sent.length));
}
{
  const client = fakeClient(() => ({ data: null, error: missingColumn('tenant_id') }));
  let caught = null;
  try { await insertWfCampaign(client, BASE); } catch (err) { caught = err; }
  ok('a missing tenant_id is never stripped (it would un-scope the campaign)', caught?.migrationRequired === true);
  ok('the tenant_id error names the tenant migration', /2026-10-24_discovery_tenant_approvals\.sql/.test(caught?.message || ''), caught?.message);
}


// ---- 5. A status the table will not accept --------------------------------
// 2026-05-03 allows created|running|completed|failed; the routes send "draft".
{
  const client = fakeClient((row) => {
    if ('status' in row) {
      return { data: null, error: { code: '23514', message: 'new row for relation "wf_campaigns" violates check constraint "wf_campaigns_status_check"' } };
    }
    return { data: { ...row, status: 'created' }, error: null };
  });
  const campaign = await insertWfCampaign(client, BASE);
  ok('a rejected status is retried without it so the column default applies', campaign.status === 'created', JSON.stringify(campaign));
}
{
  // A NOT NULL status with no default: dropping our value makes it worse, so the
  // loop must stop rather than spin.
  const client = fakeClient(() => ({ data: null, error: { code: '23502', message: 'null value in column "status" of relation "wf_campaigns" violates not-null constraint' } }));
  let caught = null;
  try { await insertWfCampaign(client, BASE); } catch (err) { caught = err; }
  ok('a NOT NULL status is retried once without the value', client.sent.length === 2, String(client.sent.length));
  ok('then the database error is raised', /violates not-null/.test(caught?.message || ''));
}

// ---- 6. Errors that are not ours to retry --------------------------------
{
  const client = fakeClient(() => ({ data: null, error: { code: '42501', message: 'permission denied for table wf_campaigns' } }));
  let caught = null;
  try { await insertWfCampaign(client, BASE); } catch (err) { caught = err; }
  ok('a permission error is not retried in a loop', client.sent.length === 1, String(client.sent.length));
  ok('a permission error reaches the route unchanged', /permission denied/.test(caught?.message || ''));
  ok('a permission error is not reported as a migration problem', !caught?.migrationRequired);
}

// ---- 7. Error classification ---------------------------------------------
ok('classification: schema cache message yields the column name',
  describeWfCampaignError(missingColumn('industries')).missingColumn === 'industries');
ok('classification: raw Postgres message yields the column name',
  describeWfCampaignError(missingColumn('industries', 'postgres')).missingColumn === 'industries');
ok('classification: an unattributed 42703 is still a schema problem',
  describeWfCampaignError({ code: '42703', message: 'something about a table' }).schemaUnattributed === true);
ok('classification: a plain Error is not a schema problem',
  describeWfCampaignError(new Error('boom')).schemaUnattributed === false);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
