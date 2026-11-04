const suites = [
  'test_linkedin_listener.mjs',
  'test_social_listening.mjs',
  'test_tenant_browser_access.mjs',
  'test_browser_actor_runtime.mjs',
  'test_micro1_adapter.mjs',
  'test_writer_flow.mjs',
  'test_tenant_portal_mobile.mjs',
  'test_admin_console_html.mjs',
  'test_site_hygiene.mjs',
  'test_social_publish.mjs'
];
const lines = [];
for (const suite of suites) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [`scripts/${suite}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    out = `${error.stdout || ''}\n${error.stderr || ''}`;
  }
  const all = out.split('\n');
  const total = (all.find((l) => /passed, \d+ failed/.test(l)) || 'NO TOTAL').trim();
  lines.push(`${suite}: ${total}`);
  all.filter((l) => l.startsWith('FAIL')).forEach((l) => lines.push(`  ${l}`));
}
fs.writeFileSync('tmp_all_check.txt', lines.join('\n'));
console.log(lines.join('\n'));
