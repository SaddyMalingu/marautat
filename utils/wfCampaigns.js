/**
 * Writer's Flow campaign creation, hardened against the two `wf_campaigns`
 * shapes this repo has shipped:
 *
 *   2026-04-20  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name, keywords, …
 *   2026-05-03  id text PRIMARY KEY  (no default; no name/keywords columns)
 *
 * Live 2026-10-26 (Render): the tenant portal's "Create campaign" answered
 * `POST /tenant/wf/campaigns 500 - 961ms` — one database round trip, so the
 * insert itself was rejected. The route logged nothing, which left the status
 * line as the only evidence. Two inserts could produce that: a NOT NULL `id`
 * with no default (2026-05-03 shape) or a `status` check constraint that only
 * accepts created|running|completed|failed while the route sends "draft".
 *
 * The insert lives here so it can be exercised without a database, and so both
 * the tenant route and the owner's /admin/api route share one behaviour:
 *   - send our own `id`, which satisfies `uuid` and `text` primary keys alike;
 *   - retry without columns the live table does not have;
 *   - never retry without `name`/`keywords`/`tenant_id` — a campaign that loses
 *     those is either nameless (unfindable) or visible to the wrong client, so
 *     that has to be a loud, actionable error instead of a silent success.
 */
import { randomUUID } from "node:crypto";

// A campaign without these cannot be listed, run, or scoped to its owner.
const REQUIRED_COLUMNS = new Set(["name", "keywords"]);
// Tenant scoping is never dropped on retry: the row would belong to nobody.
const PROTECTED_COLUMNS = new Set(["tenant_id"]);
// Where each missing column is defined, so the error names the file to run.
const COLUMN_MIGRATIONS = {
  name: "migrations/2026-04-20_writers_flow_tables.sql",
  keywords: "migrations/2026-04-20_writers_flow_tables.sql",
  industries: "migrations/2026-04-20_writers_flow_tables.sql",
  tenant_id: "migrations/2026-10-24_discovery_tenant_approvals.sql",
};

/**
 * Classify a failed insert so the caller can decide what to do with it.
 *
 * @param {object} error whatever the Supabase client returned
 * @returns {{code: string, message: string, missingColumn: string|null, notNullColumn: string|null}}
 */
export function describeWfCampaignError(error) {
  const message = String(error?.message || "");
  const details = String(error?.details || "");
  const hint = String(error?.hint || "");
  const combined = `${message} ${details} ${hint}`.toLowerCase();
  const code = String(error?.code || "");

  // PostgREST spells a missing column three ways depending on the path taken:
  // raw Postgres ("column wf_campaigns.name does not exist"), the schema cache
  // ("Could not find the 'name' column of 'wf_campaigns' in the schema cache"),
  // or a select/insert hint ("'name' column ...").
  const missingColumn =
    message.match(/could not find the '([^']+)' column/i)?.[1] ||
    message.match(/column\s+([a-zA-Z0-9_.]+)\s+does not exist/i)?.[1]?.split(".").pop() ||
    message.match(/'([^']+)'\s+column/i)?.[1] ||
    null;

  // 42703 or a schema-cache complaint we could not pin to a column name: still a
  // schema problem, so the caller must not treat it as a generic server fault.
  const schemaUnattributed =
    !missingColumn && (code === "42703" || combined.includes("schema cache"));

  const notNullColumn = message.match(/null value in column "([^"]+)"/i)?.[1] || null;

  return {
    code,
    message: message || "wf_campaigns insert failed",
    missingColumn,
    schemaUnattributed,
    notNullColumn,
  };
}

function schemaError(message, detail) {
  const err = new Error(message);
  err.migrationRequired = true;
  err.schemaDetail = detail || null;
  return err;
}

/**
 * Insert one campaign, adapting to the schema the live database actually has.
 *
 * @param {object} supabase Supabase client (service role)
 * @param {object} basePayload campaign fields
 * @param {{attempts?: number, generateId?: () => string}} [options]
 * @returns {Promise<object>} the stored row (or the payload when select is empty)
 */
export async function insertWfCampaign(supabase, basePayload, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 8);
  const generateId = options.generateId || randomUUID;
  const payload = { ...basePayload };

  // 2026-05-03 declared `id text PRIMARY KEY` with no default, so without this
  // every insert of that table dies on a NOT NULL violation. A uuid string is a
  // valid value for the `uuid` column of the 2026-04-20 shape too.
  if (payload.id === undefined || payload.id === null || payload.id === "") {
    payload.id = generateId();
  }

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data, error } = await supabase
      .from("wf_campaigns")
      .insert([payload])
      .select()
      .maybeSingle();

    if (!error) return data || { ...payload };
    lastError = error;

    const info = describeWfCampaignError(error);

    if (info.missingColumn && info.missingColumn in payload) {
      const column = info.missingColumn;
      if (PROTECTED_COLUMNS.has(column) || REQUIRED_COLUMNS.has(column)) {
        const migration = COLUMN_MIGRATIONS[column] || "migrations/2026-04-20_writers_flow_tables.sql";
        throw schemaError(
          `The wf_campaigns table is missing "${column}", so a campaign cannot be created safely. Run ${migration}, then retry.`,
          info.message
        );
      }
      delete payload[column];
      continue;
    }

    // A NOT NULL column we happened to fill (e.g. `status` on a table whose
    // default differs) succeeds once we let the database default decide.
    if (info.notNullColumn && info.notNullColumn !== "id" && info.notNullColumn in payload) {
      delete payload[info.notNullColumn];
      continue;
    }

    // 23514: a check constraint rejected "draft" (the 2026-05-03 table allows
    // created|running|completed|failed). Dropping the value uses its default.
    if (info.code === "23514" && "status" in payload) {
      delete payload.status;
      continue;
    }

    if (info.schemaUnattributed) {
      throw schemaError(
        "The wf_campaigns table does not match any migration in this repo. Run migrations/2026-04-20_writers_flow_tables.sql and migrations/2026-10-24_discovery_tenant_approvals.sql, then retry.",
        info.message
      );
    }

    break;
  }

  throw lastError || new Error("wf_campaigns insert failed");
}

export default { insertWfCampaign, describeWfCampaignError };
