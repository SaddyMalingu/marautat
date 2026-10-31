#!/usr/bin/env node

/**
 * Browser Actor live probe (2026-10-31)
 *
 * The runtime's own suite runs without MoreLogin. This script is the other half:
 * it talks to a real `ml-cli` / Local API so an operator can prove the host is
 * wired before an agent depends on it.
 *
 *   npm run browser:doctor
 *   node scripts/browser_actor_probe.mjs profiles
 *   node scripts/browser_actor_probe.mjs capture --tenant acme --url https://example.com
 *
 * Exit codes: 0 = the provider answered, 1 = it did not (or the call failed).
 * Nothing here prints a token: cdpUrl values are redacted before logging.
 */
import { createMoreloginClient } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { capturePage } from '../utils/browserActor/cdp.js';
import { redact } from '../utils/browserActor/moreloginClient.js';
import { parseProfileMap, resolveIdentity, describeIdentity } from '../utils/browserActor/identity.js';

const argv = process.argv.slice(2);
const command = argv[0] || 'doctor';

function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function print(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

const client = createMoreloginClient();
const runtime = createBrowserRuntime({ client });

async function main() {
  if (command === 'doctor' || command === 'status') {
    const probe = await runtime.probe();
    print({ transport: client.cfg.transport, ...probe });
    if (!probe.reachable) {
      console.error('\nFix: install the MoreLogin desktop client and ml-cli, then `ml-cli status`.');
      console.error('Docs: https://guide.morelogin.com/cli/quick-start');
      process.exit(1);
    }
    return;
  }

  if (command === 'profiles') {
    const result = await runtime.listProfiles({ pageSize: Number(flag('page-size', 20)) });
    print(result);
    return;
  }

  if (command === 'capture') {
    const tenant = flag('tenant');
    const url = flag('url');
    if (!tenant || !url) {
      console.error('capture needs --tenant <slug> and --url <https url>');
      process.exit(1);
    }
    const identity = resolveIdentity({
      tenantSlug: tenant,
      map: parseProfileMap(process.env.BROWSER_ACTOR_PROFILES || ''),
      defaultEnvId: process.env.BROWSER_ACTOR_DEFAULT_ENV_ID || ''
    });
    console.error(`tenant=${tenant} profile=${describeIdentity(identity).envIdMasked} runtime=${identity.runtime}`);

    const started = await runtime.startProfile(identity.envId, { runtime: identity.runtime, headless: true });
    if (!started.debugPort) {
      print({ started: { runtime: started.runtime, status: started.status, pending: started.pending } });
      console.error('The profile is not ready yet. Re-run once the runtime reports RUNNING.');
      process.exit(1);
    }
    try {
      const page = await capturePage({ host: started.host, port: started.debugPort, url });
      print({ attach: { host: started.host, port: started.debugPort }, page });
    } finally {
      if (flag('keep-open') === null) {
        try { await runtime.closeProfile(identity.envId); } catch {}
      }
    }
    return;
  }

  console.error(`Unknown command "${command}". Use: doctor | profiles | capture`);
  process.exit(1);
}

main().catch((error) => {
  console.error(redact(error?.message || String(error)));
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  if (error?.code) console.error(`code: ${error.code}`);
  process.exit(1);
});
