/**
 * Which Supabase this script will talk to, validated before any query (2026-11-13).
 *
 * The Render cron job failed on 2026-11-13 with:
 *
 *     Error: reading blog_posts: TypeError: fetch failed — coverage is unknown, refusing to plan
 *
 * `fetch failed` is Node's wrapper around a connection-level error, and it says nothing about
 * which of the five things that can be wrong is wrong. The failure was also *silent* about the
 * real cause, because the value being wrong is not the same as being absent: `createClient('')`
 * throws a clear message, but a URL that parses as a URL and points nowhere fails at the socket.
 *
 * So the shape is checked here, once, with the host printed in a form that identifies it without
 * printing the key. Also accepts `SB_URL` / `SB_SERVICE_ROLE_KEY`, because `server.js` itself reads
 * those names — a host configured the way the web service is must not need a second pair.
 */
function readSupabaseEnv(env = process.env) {
  const url = String(env.SUPABASE_URL || env.SB_URL || '').trim();
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SB_SERVICE_ROLE_KEY || '').trim();
  const urlVar = env.SUPABASE_URL ? 'SUPABASE_URL' : (env.SB_URL ? 'SB_URL' : '(neither set)');
  const keyVar = env.SUPABASE_SERVICE_ROLE_KEY ? 'SUPABASE_SERVICE_ROLE_KEY'
    : (env.SB_SERVICE_ROLE_KEY ? 'SB_SERVICE_ROLE_KEY' : '(neither set)');

  const problems = [];
  if (!url) problems.push(`no project URL: set SUPABASE_URL (or SB_URL) on this service — ${urlVar}`);
  if (url && !/^https:\/\/[a-z0-9][a-z0-9.-]*$/i.test(url)) {
    // Catches the two mistakes that actually happen: a Postgres connection string pasted in
    // (postgresql://…), and a trailing /rest/v1 or slash.
    const scheme = (url.match(/^([a-z0-9+.-]+):/i) || [])[1] || 'no scheme';
    problems.push(`SUPABASE_URL is not a bare https project URL (scheme: ${scheme}, length: ${url.length}). It should look like https://abcd1234.supabase.co — no path, no trailing slash, and not a postgres:// string`);
  }
  if (!key) problems.push(`no service role key: set SUPABASE_SERVICE_ROLE_KEY (or SB_SERVICE_ROLE_KEY) — ${keyVar}`);
  if (key && key.length < 40) problems.push(`the service role key is ${key.length} chars, which is too short to be one`);

  return { url, key, urlVar, keyVar, problems, host: url ? (url.match(/^https?:\/\/([^/]+)/i) || [])[1] || url : null };
}

export function requireSupabaseEnv(env = process.env) {
  const described = readSupabaseEnv(env);
  if (described.problems.length) {
    console.error('\nCannot reach Supabase from this service:\n');
    for (const problem of described.problems) console.error('  - ' + problem);
    if (described.host) console.error('\n  resolving host: ' + described.host);
    console.error('\n  This is a configuration problem, not a code problem. Nothing was planned or written.\n');
    process.exit(2);
  }
  return described;
}
