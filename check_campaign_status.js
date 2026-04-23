import https from 'https';

const KEY = 'myverify123';
const BASE = 'https://alphadome.onrender.com';

// The 7 phones we sent the campaign to
const SENT = [
  '254788594040','254723236276','254797997676',
  '254705005555','254799040038','254762279184','254741866137'
];
const SENT_AT = new Date('2026-04-18T16:20:00Z'); // approx send time

function get(path) {
  return new Promise((res, rej) => {
    https.get(BASE + path, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res(d); } });
    }).on('error', rej);
  });
}

async function main() {
  console.log('=== CAMPAIGN STATUS CHECK ===\n');

  // 1. Live KPIs
  const ops = await get('/admin/ops-overview?key=' + KEY);
  console.log('--- Live KPIs ---');
  console.log(`Revenue:        KES ${ops.revenue_kes ?? 0}`);
  console.log(`Incoming 24h:   ${ops.incoming_24h ?? 0} messages`);
  console.log(`Hot leads:      ${ops.hot_leads_count ?? 0}`);
  console.log(`Conversion:     ${ops.conversion_rate_pct ?? 0}%`);
  console.log(`Failed pmts:    ${ops.failed_count ?? 0}`);
  console.log(`Pending pmts:   ${ops.pending_count ?? 0}`);

  // 2. Campaign reply check — query conversations for our sent phones
  console.log('\n--- Campaign Reply Status ---');
  console.log(`Sent to ${SENT.length} numbers at ~${SENT_AT.toISOString()}`);

  const replies = await get('/admin/campaign-replies?key=' + KEY + '&since=' + SENT_AT.toISOString() + '&phones=' + SENT.join(','));
  
  if (typeof replies === 'object' && replies.rows) {
    const repliedPhones = new Set(replies.rows.map(r => r.phone));
    console.log(`\nReplied: ${repliedPhones.size}/${SENT.length}`);
    for (const phone of SENT) {
      const row = replies.rows.find(r => r.phone === phone);
      const status = row ? `✓ REPLIED at ${row.last_reply}` : '✗ No reply yet';
      console.log(`  ${phone}  ${status}`);
    }
  } else {
    // Endpoint not yet built — show what we know
    console.log('\n[campaign-replies endpoint not yet live — building it now]');
    console.log('Sent numbers:');
    for (const p of SENT) console.log(`  ${p}  → awaiting reply`);
  }

  // 3. DB table check via dry-run campaign (tells us if conversations table accessible)
  console.log('\n--- DB Tables Check ---');
  try {
    const dry = await get('/admin/api/campaign/send-template?key=' + KEY + '&dry_run=true&window_hours=8760&limit=5');
    if (typeof dry === 'object') {
      if (dry.ok !== undefined) {
        console.log(`conversations table: OK (${dry.total} rows accessible)`);
      } else if (dry.error) {
        console.log(`conversations table: ERROR - ${dry.error}`);
      }
    }
  } catch(e) {
    console.log('DB check error:', e.message);
  }

  const perf = await get('/admin/performance-report?key=' + KEY + '&period=daily');
  if (typeof perf === 'object' && perf.summary) {
    console.log(`\nPerformance band:  ${perf.performance_band}`);
    if (perf.action_plan?.length) {
      console.log('Action plan:');
      perf.action_plan.slice(0,3).forEach(a => console.log('  -', a));
    }
  }
}

main().catch(e => console.error('Error:', e.message));
