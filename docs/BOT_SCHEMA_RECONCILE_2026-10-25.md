# Bot schema reconcile — 2026-10-25

## What the diagnose proved

| schema | what it holds |
| --- | --- |
| `alphadome` | all 10 `bot_*` tables. `bot_products` 24, `bot_product_images` 12, `bot_product_variants` 4, `bot_collections` 3, `bot_collection_items` 7, `bot_tenants` 1 |
| `public` | `bot_tenants` only (3 rows). The other ten are MISSING |
| overlap | **0** tenant uuids exist in both schemas |

The one tenant that owns the catalogue is `2330bdfe-7b4d-476f-ad0d-ba1b2caeed12`
(Kassangas Music Shop, 0702245555) in `alphadome`. Section D shows it as
invisible through `public.bot_tenants`.

The three `public` rows are portal shells (`portal_token`, `status`,
`description`). None of them owns a product — `public.bot_products` does not
exist, so they cannot.

## Why the dashboard half-works

| symptom | cause |
| --- | --- |
| catalogue looks fine | `server.js:3288` falls back to `get_catalog(phone)`, which reads `alphadome` by phone |
| Orders always empty | `server.js:3463` — no table in `public`, no RPC fallback, error swallowed |
| Training never saves | `server.js:2852/2892/2913` — insert into a missing table, no fallback |
| Templates, settings dead | `get_templates_by_tenant(uuid)` looks the uuid up in `alphadome`; the session uuid lives in `public` |
| readiness 0 products, abandoned-cart "not configured" | `server.js:1259/3884` select `whatsapp_access_token` / `is_active`, which `public.bot_tenants` does not have |

## The shadow — confirmed by the pre-flight SELECT

`findTenantByPhone()` (`server.js:2280`) reads `supabase.from("bot_tenants")`, and
the client at `server.js:600` is built with **no `schema` option**, so that is
`public`. The live lookup can only ever see the three public rows:

| id | name | phone | products it can own |
| --- | --- | --- | --- |
| `cfc89b88…` | Coach Dawn 3.0 | +254 748 621563 | none — no `alphadome` row at all |
| `62828821…` | Kassangas Music Shop | 0702245555 | 0 — `public.bot_products` does not exist |
| `84342b47…` | Kassangas | 254737245555 | 0 |

`62828821…` holds **the same phone as the catalogue owner in `alphadome`**, so
every phone login resolves to this shell and stops. That is why the portal
authenticates, greets Kassangas, and then shows nothing: the session uuid belongs
to a row that cannot own a product, while the 24 products sit under a uuid the
portal never asks for.

After step 2 the shell's phone becomes `merged:62828821…`, the keeper is the only
`0702245555` in `public`, and the session uuid *is* the catalogue owner.

## What the fingerprints proved

Run on 2026-10-25 against the three public rows (`ecf8427e` is the tail of
`md5('')`, i.e. "empty or column absent"):

| row | `is_active` | `has_portal_token` | `phone_id_fp` | `alphadome_twin` |
| --- | --- | --- | --- | --- |
| Coach Dawn 3.0 | absent | **false** | `ecf8427e` (none) | **0** |
| Kassangas Music Shop `62828821…` | absent | **false** | `0f6c6062` | 1 |
| Kassangas `84342b47…` | absent | **false** | `e98b3f56` | **0** |

1. **No portal token exists anywhere.** All three are `false`, and
   `whatsapp_access_token` is empty in every row. So the invite middleware at
   `server.js:2414` returns 401 for every invite link — the dashboard has been
   reached through the **phone-session** route at `server.js:2487`, which is
   exactly the route the shell shadows. Clearing `portal_token` in section C is a
   no-op today, and step 3 (Portal Invite) is mandatory, not cosmetic. It is also
   what gives the mirror trigger in section H something to carry.
2. **`is_active` is absent, not false.** `is_active: "-"` is the fallback for a
   missing column, which confirms section B's column adds and the readiness /
   abandoned-cart errors at `server.js:1259` / `:3884`.
3. **`84342b47…` holds a different `whatsapp_phone_number_id`** (`e98b3f56` vs the
   keeper's row `0f6c6062`). That column does exist in `public`, and two distinct
   non-empty ids mean 0737 245 555 was registered as a separate WABA number, not
   a typo of 0702 245 555. It still has no `alphadome` twin, so the bot has never
   answered it — tombstoning it destroys no bot behaviour, and if the line is
   real it can be re-created as its own tenant later.
4. **Coach Dawn's orphan is generated, not accidental.** `admin/seed_coachdawn3.js`
   declares *"insert into alphadome.bot_tenants"* in its header but built the
   client with no `db.schema`, so every run wrote to `public`. Fixed: the client
   now pins `db: { schema: 'alphadome' }`, and the error branch names `42P10`
   (no unique constraint for the upsert) and `PGRST204` (column missing) instead
   of failing silently.

Section D is inert either way on this data: if the keeper's
`whatsapp_phone_number_id` is set it reports *"keeper already has"* and refuses to
be overwritten; if it is NULL while both shells hold a value it reports
`D. WARNING ambiguous` and writes nothing. No shell value is ever taken over a
keeper value.

## Open decisions

1. ~~Is `254737245555` a live Kassangas line?~~ **Answered:** it carries its own
   distinct `whatsapp_phone_number_id`, so it is a registered second WABA number.
   It still has no `alphadome` row, so the bot has never answered it and the
   tombstone removes no working behaviour. Keep it in the merge set; if Kassangas
   still wants that line, create it as a real tenant afterwards — do not un-tombstone
   `84342b47…`.
2. **Coach Dawn 3.0 has no `alphadome` row.** Sections B/G leave it alone, so it
   keeps behaving exactly as badly as today (nothing). The seed script that
   created the orphan is fixed, but the existing row still needs a `_03` that
   inserts the matching `alphadome.bot_tenants` row **under the same uuid**
   `cfc89b88-cc67-4655-ab06-b823b93a73e2`. Anything else leaves Coach Dawn with
   two identities and repeats the shadow.
3. ~~Keeper credentials are unverified.~~ **Answered 2026-10-25: the keeper is
   fully credentialed.** `has_phone_id = true`, `has_token = true`,
   `is_active = true`. Consequences:
   - **No credential has to move.** Every public fingerprint was `ecf8427e`
     (empty/absent), so there is nothing for section D to rescue — it will only
     emit `D. keeper already has …` lines. Section D exists for future tenants,
     not for this apply.
   - **The live WhatsApp path keeps working untouched.** The bot sends with this
     row today and will still send with this row afterwards; the migration adds
     no second copy of any credential.
   - `E. is_active forced true` should **not** appear in the grid: `alphadome`
     already has `true`, so the override is a no-op that only fires on bad data.

<details>
<summary>Fingerprint query used to produce the table above (read-only) — `phone_id_fp` / `token_fp` distinguish *absent* from *a different credential* without revealing either</summary>

```sql
-- safe before section B: to_jsonb never fails on a missing column.
-- Fingerprints only - no raw credential is ever printed.
SELECT t.id, t.client_name, t.client_phone,
       coalesce(to_jsonb(t)->>'status', '')          AS status,
       coalesce(to_jsonb(t)->>'is_active', '-')      AS is_active,
       (to_jsonb(t)->>'portal_token') IS NOT NULL    AS has_portal_token,
       right(md5(coalesce(to_jsonb(t)->>'whatsapp_phone_number_id', '')), 8) AS phone_id_fp,
       right(md5(coalesce(to_jsonb(t)->>'whatsapp_access_token', '')), 8)    AS token_fp,
       (SELECT count(*) FROM alphadome.bot_tenants a
         WHERE right(regexp_replace(a.client_phone, '\D', '', 'g'), 9)
             = right(regexp_replace(coalesce(t.client_phone, ''), '\D', '', 'g'), 9))
         AS alphadome_twin
  FROM public.bot_tenants t
 ORDER BY t.client_phone;
```

</details>

## The fix

`migrations/2026-10-25_bot_schema_reconcile_02_apply.sql`, one transaction:

1. **B** — add the columns `public.bot_tenants` is missing, types/defaults copied from `alphadome`.
2. **C** — tombstone the two Kassangas shells (phone → `merged:<id>`, `status=inactive`, `is_active=false`, portal token cleared). No DELETE.
3. **D** — rescue any credential only one shell still holds into the alphadome keeper when the keeper's value is NULL. Presence reported, values never printed.
4. **E** — promote the keeper into `public.bot_tenants` **under the same uuid**, so the portal session uuid and the catalogue owner are the same identity. `status` and `is_active` are forced `active`/`true` rather than copied: `isTenantRecordActive()` (`server.js:2251`) prefers the raw boolean, so a false value from `alphadome` would promote a row the phone lookup then rejects as "Tenant found but inactive".
5. **F** — re-key rows already pointing at the shells, limited to FKs on `bot_tenants` plus `wf_campaigns.tenant_id`. `site_tenants` ids are left alone.
6. **G** — create one `public` view per `alphadome` `bot_*` table (ten here: every one except `bot_tenants`, which stays a real table). Single-table `select *` views are auto-updatable, so reads **and** writes work with no `server.js` change. If a real `public` **table** already owns one of those names it is left untouched and reported with **both row counts**; an *empty* public table shadowing a populated `alphadome` one raises a warning, because that is the exact failure this migration exists to remove.
7. **H** — mirror future portal credential edits onto the alphadome row, so the token entered in the portal is the token WhatsApp sends with.
8. **I** — report grid, `notify pgrst, 'reload schema'`, commit.

No domain rows move. The 24 products keep `bot_tenant_id = 2330bdfe…`, so
`get_catalog` and `get_tenant_by_wa` keep resolving exactly as they do today.

## Run order

```text
1. migrations/2026-10-25_bot_schema_reconcile_02_apply.sql   dry_run := true   -> read grid
2. migrations/2026-10-25_bot_schema_reconcile_02_apply.MERGE.sql               -> commit
   generated copy of step 1 with dry_run := false, confirm := 'MERGE'; identical
   SQL otherwise, and the test suite fails if the two ever drift apart
3. migrations/2026-10-25_bot_schema_reconcile_03_verify.sql     read only      -> read grid
4. Admin -> Tenants -> Kassangas Music Shop -> Portal Invite  (the keeper has no portal token)
5. node scripts/verify_writers_flow.js
6. node scripts/smoke_tenant_onboarding.mjs --issue
7. Live walk: catalog / orders / training -> Writer's Flow -> Blogger offer -> F5
8. migrations/2026-10-25_bot_schema_reconcile_04_coachdawn.sql  dry run       -> read grid
9. same file, dry_run := false, confirm := 'MERGE'                             -> commit
```

Step 3 is not optional. Step 2 rebuilds `public._bot_reconcile_report` at the
start of every run, so **a re-run destroys the previous grid**. The report proves
what a run *did*; `_03_verify.sql` proves what the database *is*. Only the second
survives a second click on Run.

Steps 8 and 9 are about the second tenant, not the Kassangas demo: they can wait
until step 7 has been walked end to end.

The `.MERGE.sql` copy exists only so nobody hand-edits flags in the SQL Editor
under pressure. Delete it once step 3 is green; the parent file stays the audited,
dry-run-by-default source of truth.

## Reading the `_03_verify` grid

One result set, thirteen arms now. Expected, in order:

| step | healthy value | means |
| --- | --- | --- |
| `V. views` | `10 views, 0 shadowing base tables` | G created every view; a table of the same name would hide one |
| `V. shadowing table` | **no rows** | nothing shadows a view name; only printed when a base table shares a name with an alphadome table |
| `V. public-only table` | `bot_outputs` | expected: a `bot_*` table alphadome never had, so it shadows nothing |
| `V. updatable views` | `10` | single-table `select *` views stay writable |
| `V. products` / `V. reachable` | `24` / `24` | catalogue visible *and* owned by an active tenant |
| `V. supporting rows` | `3` | collections 3, images 12, variants 4 (one row per table) |
| `V. tenant <name>` | keeper `1`, shells `0` | `0` on a shell is the tombstone working |
| `V. token mirror` | `1` | tenants whose WhatsApp token matches across schemas, by `md5` |
| `V. mirror trigger` | `1` | the section H trigger is installed and enabled |
| `V. write targets` | `0` | orders/training/logs empty — nobody has written since the apply |
| `V. tenant columns` | `public 30 vs alphadome 26` | **informational**: public keeps legacy extras |
| `V. missing columns` | `none` / `0` | the assertion that matters: alphadome ⊆ public |
| `V. orphans` | `1` (Coach Dawn) | live tenants that exist only in `public` |

`bot_outputs` is the only `bot_*` base table in `public` that alphadome has no
counterpart for. It is not in any migration in this repo and no code path in
`server.js` touches it, so it was created outside the repo. It shadows no view and
breaks nothing — which is exactly why it gets its own line rather than being folded
into the shadow count.

Three of these were wrong in earlier versions of the file and are worth keeping in
mind when reading any grid like this:

1. **The column counts were compared for equality.** They are not equal and never
   will be: B adds what public lacks, nothing removes what public has extra. The
   real test is subset direction, so `V. missing columns` names any alphadome
   column public cannot supply and expects `none`.
2. **`1 shadowing base table` was reported without saying which.** A count cannot
   tell a harmless leftover (`bot_settings`) from an empty twin that starves the
   portal (`bot_products`), so `V. shadowing table` prints the names.
3. **`bot_outputs` was counted as shadowing.** A shadow is a base table whose name
   also exists in `alphadome` — and only for `bot_*` names, since G creates no other
   views. The count now requires both, and the complement is listed separately as
   `V. public-only table` so it cannot be mistaken for leakage.

## Step 4: the second tenant has no alphadome row

`V. orphans: 1` is Coach Dawn 3.0 (`cfc89b88…`). She exists in `public.bot_tenants`
and is **absent** from `alphadome.bot_tenants`. Two consequences:

1. **Credentials typed for her are thrown away.** The section H trigger is
   `UPDATE alphadome.bot_tenants SET … WHERE id = $1`. With no alphadome row it
   matches zero rows, raises nothing, and the portal form still shows success. The
   first time anyone pastes her WhatsApp token into the admin UI it will vanish.
2. **Phone fallback cannot find her.** `get_tenant_by_wa()` reads
   `alphadome.bot_tenants` only.

`_04_coachdawn.sql` fixes both, in the same shape as section E but reversed:
same uuid, intersection of both column lists, active flags forced, and it
**aborts** rather than clearing a value if an alphadome `UNIQUE` column would
collide. `_02` cleared duplicates on the dead shells; doing that here would rewrite
the credential store.

It also normalises `client_phone`. Her stored number is `+254 748 621563`, but
`server.js:6206` matches `client_phone` with an exact `.in()` against `254…`/`0…`
and `get_tenant_by_wa()` normalises only its *argument*, never the stored value — so
the formatted value matches neither form. `_04` rewrites it to `0748621563`, the
local 0-format the keeper already uses, and reports old → new.

## Reading the `_04` grid

```text
A. mode                DRY RUN - nothing written   | 0     (APPLY | 1 when committing)
A. source              cfc89b88… | Coach Dawn 3.0 | status=active | active=true | 1
A. phone_number_id     set | MISSING …             | 1|0   (primary lookup key, before phone)
A. products            catalogue rows she owns     | 0     (she has none seeded yet)
B. phone normalised    +254 748 621563 -> 0748621563 | 1   (0 when already digits)
C. collisions          no alphadome unique column taken | 0
D. fillable            every NOT NULL column supplyable | 1
E. promote             25 shared columns, forced: is_active | 1  (0 on re-run: skipped)
E. phone in alphadome  0748621563                  | 1
```

25 shared columns is the honest number, and it is a schema fact worth
understanding: alphadome has 26, one of them is `is_active`, which is deliberately
**not** copied from the public row and is written as `true` instead. `status`,
`description` and the two `portal_token` columns are public-only, so they are not in
the intersection at all — the report says `forced: is_active`, not the
`status/is_active forced` an earlier draft claimed, because a table that has no
`status` column cannot be forced into one.

`A. products: 0` is a separate gap, not a `_04` failure. `public.bot_products` is a
view over alphadome, so 0 there means she has **no catalogue anywhere**. Promoting
her makes her credentials storable and her phone resolvable; it does not give her
anything to sell. If she is meant to demo live, her catalogue has to be seeded in
`alphadome` under the same uuid first — otherwise her bot answers `get_catalog`
with nothing.

`A. phone_number_id: MISSING` compounds with the phone-format bug: with no id and a
`+254 …` number she is currently unreachable on both lookup paths. `B` repairs the
phone path; the id has to be entered from her WhatsApp Business account.

Anything that raises instead of printing is a guard doing its job — it names the
column or uuid and the whole transaction rolls back, including the phone rewrite.

## Re-running is safe, and why that matters

If the apply grid shows `A. note: keeper already in public`, `B. columns to add: 0`
and `E. promote keeper: already present`, you are looking at a **second** run: an
earlier run already committed. Every section is written to be re-run, so nothing
is damaged — but three things are worth knowing.

1. **The first grid is gone.** The report table is dropped and recreated per run.
   Verify the end state with `_03_verify.sql` instead of trusting the surviving grid.
2. **`C. tombstone` prints the phone *before* the update.** On a re-run it shows
   `merged:<id>` as the incoming value, which looks like the tombstone failed. It
   did not; it already happened.
3. **The merge note is appended once only.** It used to append ` [merged into …]`
   on every run, stacking the marker (found on the 2026-10-25 re-run). The `UPDATE`
   now checks `position(marker in description) > 0` first.

**Reading the result.** The Results pane keeps only the **last** result set, so
the `step | detail | rows` report is deliberately the last statement in the file
and the verification `NOTICE`s sit just above it (they land in the **Messages**
tab). If the pane shows the three-tenant list instead, the run still succeeded —
the report is committed to disk, so read it with:

```sql
SELECT step, detail, rows FROM public._bot_reconcile_report ORDER BY seq;
```

If that query errors with *relation does not exist*, the batch actually aborted
and rolled back: read the error above it, not the tenant list.

If the apply grid contains `G. SKIPPED`, stop before step 3. A real public table is
still shadowing that name, so reads keep returning the shadow and steps 3–6 would be
debugging the wrong layer. Read the two counts in the row: a populated `alphadome`
side with zero public rows **is** the catalogue you are trying to expose.

`2026-10-25_tenant_merge_02_apply.sql` is **superseded** by step 2. It merges
`62828821…` → `84342b47…`, which are both shells owned by no catalogue; after
step 2 its phone guards fail on purpose. Do not run it.

## Expected grid for this data

The grid at section I is ordered by `seq`. With the keeper verified as
`phone_id + token + is_active = true` and both shells holding no credential, the
expected output is:

| step | dry run (`dry_run := true`) | apply (`false, 'MERGE'`) |
| --- | --- | --- |
| `A. mode` | `DRY RUN - nothing written`, 0 | `APPLY`, 1 |
| `A. keeper products` | **24** | **24** |
| `A. row` ×2 | `62828821… Kassangas Music Shop 0702245555`, `84342b47… Kassangas 254737245555` | same |
| `A. note` | **absent** — the keeper is not in `public` yet, so E will insert | same |
| `B. add public column` ×15 | the 15 columns below, each 0 | each 1 |
| `B. columns to add` | **15** | 15 |
| `B. is_active normalised` | *absent* (write) | **1** — Coach Dawn set from `status`, shells excluded |
| `C. tombstone` ×2 | both shells listed, each **0** — a preview writes nothing | same lines, each **1** |
| `C. tombstoned rows` | **0** — nothing written yet, this is correct | **2** |
| `D. keeper already has` ×K | one line per credential column the keeper already holds: `whatsapp_phone_number_id`, `whatsapp_business_account_id`, `whatsapp_access_token`, … | **identical** — D deliberately previews the columns B adds, so the apply grid must not grow here. If it does, D and B have drifted apart |
| `D. rescued to keeper` | absent | absent — nothing to rescue |
| `E. promote keeper` | uuid + **12** column names, **0** | **1**, uuid + **26** column names |
| `E. is_active forced true` | absent | absent — alphadome is already `true` |
| `E. cleared duplicate unique value` | **appears**, 0 — `client_phone on 1 shell row(s)`. Dry-run only: `public.bot_tenants.client_phone` carries a single-column UNIQUE index and the `62828821…` shell still shares `0702245555` with the keeper, because C has not rewritten it yet | ***absent*** — C runs first and has already moved that phone to `merged:62828821…`, so there is nothing left to clear |
| `F. re-key to keeper` / `F. re-keyed rows` | 0 | 0 — nothing points at the shells |
| `G. view` ×10 | 10 lines, each 0 | 10 lines, each 1 |
| `G. views` | `10 to create, 0 skipped` | `10 to create, 0 skipped` |
| `G. SKIPPED` | absent | absent — no real `public` table owns those names. If it **does** appear, read the counts: `public rows: 0, alphadome rows: 24` means something still shadows the catalogue and reads will stay empty |
| `H. mirror trigger` | `skipped in dry run`, 0 | `… (credentials only)`, 1 |

The two `E. promote keeper` column lists differ on purpose. A dry run runs against
the schema as it is **now**, where `public.bot_tenants` is missing 15 columns, so E
sees only the 12 it can copy. On the write pass B has just added them, so E copies
26 — including the live `whatsapp_access_token`, `whatsapp_token_expires_at` and
`whatsapp_phone_number_id`. That is why the portal's WhatsApp readiness turns green
immediately after the apply, and why the Portal Invite step that follows is about the
**login token** (`portal_token`, still NULL), not about re-entering WhatsApp
credentials.


The 15 columns B adds, straight from diagnose section F — every one of them
`only in alphadome`:

```text
ai_api_key  ai_model  ai_provider  client_email  is_active  is_verified
smtp_from_name  smtp_host  smtp_pass  smtp_port  smtp_user
webhook_url  webhook_verify_token  whatsapp_access_token  whatsapp_token_expires_at
```

`whatsapp_phone_number_id` is **not** in that list: it exists in both schemas, which
is why section E copies it from the keeper. `status`, `portal_token`,
`portal_token_issued_at` and `description` are public-only, so E sets `status` to
`active` explicitly and lets the portal columns stay NULL.

Three numbers look like failures in a dry run and are not: `C. tombstoned rows = 0`,
every `G. view` row at 0, and `E. cleared duplicate unique value` at 0. Those are
write counts, and a dry run writes nothing. Compare B's total (15), 24 keeper
products and 10 views; those are the values that must match on both passes.

## Rollback

The whole script is one transaction, so a failed guard rolls back by itself.
After a successful apply the reversible pieces are:

```sql
DROP VIEW IF EXISTS public.bot_orders, public.bot_products, public.bot_product_images,
  public.bot_product_variants, public.bot_collections, public.bot_collection_items,
  public.bot_templates, public.bot_training_data, public.bot_control_settings,
  public.bot_message_logs;
DROP TRIGGER IF EXISTS bot_tenants_mirror ON public.bot_tenants;
DROP TABLE IF EXISTS public._bot_reconcile_report;
DROP TABLE IF EXISTS public._bot_coachdawn_report;
DELETE FROM public.bot_tenants WHERE id = '2330bdfe-7b4d-476f-ad0d-ba1b2caeed12';
DELETE FROM alphadome.bot_tenants WHERE id = 'cfc89b88-cc67-4655-ab06-b823b93a73e2';
```

The 15 added columns are left in place on purpose: they are additive, nullable and
unused by any code path until the portal reads them, so dropping them buys nothing
and risks a partial rollback.

Tombstoned shells stay recoverable from `client_phone = 'merged:<id>'` and the
`description` suffix; their tokens were cleared, so a re-invite is required.

## Validation available locally

```text
node scripts/test_bot_schema_reconcile_sql.mjs   # 94 checks
node scripts/test_tenant_merge_sql.mjs           # 63 checks
```

The 86 include the guards that matter after the fact, not just before:
the `.MERGE.sql` copy is byte-compared to the audited file apart from its two
flags, `_03_verify.sql` is proven to contain exactly one statement and no write
verb, the tombstone is proven to append its merge note at most once, and
`_04_coachdawn.sql` is proven to write to nothing but `alphadome.bot_tenants` — the
one place where a stray `UPDATE` would rewrite a live credential.
