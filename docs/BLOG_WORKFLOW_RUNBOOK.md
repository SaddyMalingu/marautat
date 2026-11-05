# Blog workflow runbook

Operational notes for the Render Workflow that writes blog pages for captured offers.
See `OPEN_FLAGS.md` #58–#60 for why it exists and what was broken before it.

## Environment variables: why the workflow needs its own

**Render environment variables are per service.** A workflow service does not inherit the
web service's variables — it starts empty, and `createClient(undefined, undefined)` throws
`supabaseUrl is required` on the first run. So the values must be set twice.

Worse, this repo reads **two different spellings** for the same database:

| Reader | Variable names it actually reads |
|---|---|
| `server.js` (the web service) | `SB_URL`, `SB_SERVICE_ROLE_KEY` |
| `scripts/blogManager.js`, `scripts/blog_queue.mjs`, `workflows/index.js` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

The dashboard currently holds both pairs, which is why the site works. A workflow given only
the `SB_*` pair would fail on its first run even though "the key is set".

## Minimum set for the workflow service

| Key | Required | Why |
|---|---|---|
| `SUPABASE_URL` | yes | every writer module connects with this name |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | writing `blog_posts` needs the service role (there is no logged-in user in a workflow) |
| `OPENROUTER_API_KEY` | one provider is required | the writer walks OpenRouter first. `OPENROUTER_KEY` and `OPEN_ROUTER_API_KEY` are accepted aliases — see `keyFrom()` in `scripts/blogManager.js` — but prefer the canonical name |
| `GEMINI_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `GROK_API_KEY`, `HF_API_KEY` | optional | additional providers in the same walk; more keys means fewer composed fallbacks |
| `SITE_URL` | recommended | canonical link and CTA URLs on each page (`https://alphadome.onrender.com` if unset) |
| `BLOG_RUN_BUDGET_MS` | recommended | `600000`. The 90 s default exists because generation normally runs inside a tenant's HTTP request; a task run may last two hours, so the budget can be spent instead of truncating angles |
| `BLOG_ANGLE_DELAY_MS` | optional | `1200` keeps nine sequential calls inside free-tier per-minute limits |

Do **not** copy to the workflow: `ADMIN_PASS`, `TENANT_*`, `MPESA_*`, `WHATSAPP_*`,
`SENDGRID_*`, `SMTP_*`, `SERPAPI_KEY`, `GOOGLE_CSE_*`, `POSTGRES_URL` (this path uses the
Supabase REST client, not the database URL), or `REPLICATE_API_TOKEN` (see images below).

## Images

`genImage()` writes a PNG to `public/images/blog/<slug>.png` and returns
`/images/blog/<slug>.png`. The durable copy of a page is its `blog_posts` row, and
`restoreFromDB()` rebuilds only the **HTML** on boot — so no PNG ever comes back, on any
host. A workflow finishes by discarding its filesystem entirely, which makes it certain.
`workflows/index.js` therefore calls the generator with `{ images: false }`.

Moving thumbnails to Supabase Storage is the fix; until then, a `thumbnail_url` in
`blog_posts` is a 404 candidate and should not be advertised.

## Deploy checklist

1. Confirm `main` is deployed (the workflow builds the same commit the site serves).
2. Create the workflow: Name `alphadome-blog`, Language Node, Branch `main`, Region Frankfurt,
   Root Directory blank.
3. Build Command: `npm install && npm install @renderinc/sdk@^1.7.0`
4. Start Command: `node workflows/index.js` — **not** `node index.js`, which does not exist.
5. Add the environment variables above.
6. Deploy and check the log for `[workflow] registered blogQueue + blogOffer`.
7. Trigger once — dashboard task run, `render workflows tasks list`, or the nightly GitHub
   Action.

**The task slug is `<workflow-slug>/blogQueue`.** Ours is `alphadome-blog/blogQueue`
(service `wfl-dbm4ea56e07s73b49qn0`). That string appears in two other places and all three
must agree:

| Place | Value |
|---|---|
| Render dashboard → Workflow Slug | `alphadome-blog` |
| `.github/workflows/blog-automation.yml` | `BLOG_WORKFLOW_TASK`, defaulting to `alphadome-blog/blogQueue`; override with the repository variable of that name |
| `render.yaml` | `name: alphadome-blog` |

A wrong slug returns **404** from the Render API, not 401 — which reads like an auth problem
but is not. Trigger by hand to check:

```bash
curl --fail-with-body -X POST https://api.render.com/v1/task-runs \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"task":"alphadome-blog/blogQueue","input":[{"limit":3}]}'
```

`input` is always an **array** of positional arguments, so the queue's options object is the
single element `[{"limit":3}]`.

## Health check

| Symptom | Cause |
|---|---|
| `supabaseUrl is required` | `SUPABASE_URL` missing (only `SB_URL` was set) |
| run is green, `pages: 0` | every angle returned nothing — check the provider keys. The writer reports `mode=template` when it composed from the offer data instead, and `success:false` when it wrote nothing at all |
| `failed: 1` with `provider 429` | rate limiting; the fan-out keeps the other offers, retries happen per step |
| pages written but 404 on the site | the web service has not restored yet — `blog_posts` is the source of truth, and `restoreBlogs()` runs at boot |

## Secrets hygiene

An API key that has been pasted into a chat, a screenshot, or a commit is compromised.
Rotate it, update every place that reads the name (web service, workflow service, GitHub
secrets), then confirm with `node scripts/check_ai_key.mjs` locally.
