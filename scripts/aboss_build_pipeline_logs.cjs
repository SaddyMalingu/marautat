const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, 'logs');

const FILES = {
  mixedSendNow: path.join(ROOT, 'ABOSS_MIXED_SEND_NOW_REFRESHED.csv'),
  batch2Messages: path.join(ROOT, 'ABOSS_BATCH2_MESSAGES_READY.csv'),
  blockers: path.join(ROOT, 'ABOSS_MIXED_RESEARCH_BLOCKERS.csv'),
  deepResearch: path.join(ROOT, 'ABOSS_DEEP_RESEARCH_MIXED.csv'),
  hiddenChampions: path.join(ROOT, 'ABOSS_HIDDEN_CHAMPIONS_STRIKE.csv'),
  nextActions: path.join(ROOT, 'ABOSS_BATCH2_NEXT_ACTIONS.csv')
};

const OUT = {
  master: path.join(LOG_DIR, 'ABOSS_CONVERSION_PIPELINE_MASTER.csv'),
  callQueue: path.join(LOG_DIR, 'ABOSS_CALL_WHATSAPP_PRIORITY.csv'),
  decisionMakers: path.join(LOG_DIR, 'ABOSS_DECISION_MAKER_RESEARCH.csv'),
  review: path.join(LOG_DIR, 'ABOSS_PIPELINE_REVIEW_2026-07-06.md')
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const BOUNCED = new Set(['contact@mafcarrefour.com', 'channelsales@hotpoint.co.ke']);

function clean(v) {
  return String(v || '').trim();
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheet = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
}

function writeCsv(filePath, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  fs.writeFileSync(filePath, XLSX.utils.sheet_to_csv(ws), 'utf8');
}

function normalizePhone(phone) {
  const d = clean(phone).replace(/\D/g, '');
  if (!d || d === '2147483647') return '';
  if (d.startsWith('254') && d.length === 12) return `+${d}`;
  if ((d.startsWith('07') || d.startsWith('01')) && d.length === 10) return `+254${d.slice(1)}`;
  return '';
}

function emailStatus(email) {
  const e = clean(email).toLowerCase();
  if (!e) return 'missing';
  if (!EMAIL_RE.test(e)) return 'invalid_format';
  if (BOUNCED.has(e)) return 'known_bounced';
  return 'valid_format';
}

function stageFromStatus(status, signal = '') {
  const s = clean(status).toLowerCase();
  const f = clean(signal).toLowerCase();

  if (s.includes('pending_jumia_call')) return 'ACTION_REQUIRED_CALL';
  if (f.includes('call +') || f.includes('call/') || f.includes('whatsapp') || f.includes('bulk purchase route')) return 'ACTION_REQUIRED_CALL';
  if (s.includes('sent_')) return 'OUTREACH_SENT';
  if (s.includes('deferred_contacted_today')) return 'DEFERRED_24H';
  if (s.includes('queued_24h_followup')) return 'FOLLOWUP_QUEUE';
  if (s.includes('queued_batch2')) return 'BATCH2_QUEUE';
  if (f.includes('blocker') || f.includes('no additional verified')) return 'RESEARCH_BLOCKER';
  return 'RESEARCH_POOL';
}

function statusRank(status) {
  const s = clean(status).toLowerCase();
  if (s.includes('pending_jumia_call')) return 100;
  if (s.includes('sent_')) return 90;
  if (s.includes('deferred_contacted_today')) return 80;
  if (s.includes('queued_24h_followup')) return 70;
  if (s.includes('queued_batch2')) return 60;
  if (s.includes('new')) return 10;
  return 0;
}

const trustedPhoneOverrides = {
  'basigo': '+254705837904',
  'greenspoon': '+254157267894',
  'ilara health': '+254111027900',
  'm-gas': '+254792556677',
  'twiva': '+254715819949',
  'jumia kenya': '+254711011011',
  'quickmart': '+254789646464',
  'safaricom': '+254722002222',
  'pesapal': '+254709219000'
};

function roleHint(industry) {
  const i = clean(industry).toLowerCase();
  if (i.includes('retail')) return 'Head of Operations';
  if (i.includes('hospitality')) return 'General Manager';
  if (i.includes('fintech') || i.includes('financial')) return 'Partnerships Lead';
  if (i.includes('saas')) return 'Head of Growth';
  if (i.includes('healthtech')) return 'Operations Manager';
  if (i.includes('logistics')) return 'Commercial Manager';
  if (i.includes('telecom')) return 'Business Development Manager';
  return 'Business Development Lead';
}

const socialEvidence = {
  'm-gas': {
    known_contacts: 'Nick Quintong (Managing Director); Anita Otete (Divisional Head - Customer Experience); Richard O\'Brien (Divisional Head - Legal and Compliance)',
    source: 'https://mgas.ke/about-us/|https://mgas.ke/contact-us/'
  },
  'sarova hotels': {
    known_contacts: 'Central Reservations team (corporate); use group-level decision-maker path via corporate contact',
    source: 'https://www.sarovahotels.com/|https://www.sarovahotels.com/contact-us.html'
  },
  'serena hotels kenya': {
    known_contacts: 'Kenya marketing/corporate team (group-level).',
    source: 'https://www.serenahotels.com/'
  },
  'villa rosa kempinski nairobi': {
    known_contacts: 'Reservations/corporate events contact path through hotel details and meetings/events.',
    source: 'https://www.kempinski.com/en/hotel-villa-rosa'
  },
  'quickmart': {
    known_contacts: 'Q-Soko team and operations path via contact page.',
    source: 'https://www.quickmart.co.ke/contact-us'
  },
  'jumia kenya': {
    known_contacts: 'Kenya support + corporate/bulk purchase route; escalate to operations/commercial manager via corporate channel.',
    source: 'https://www.jumia.co.ke/sp-contact/'
  },
  'safaricom': {
    known_contacts: 'Safaricom Business team contacts; likely path to Business Development/Commercial owners.',
    source: 'https://www.business.safaricom.co.ke/'
  }
};

const mixedSend = readCsv(FILES.mixedSendNow);
const batch2Msgs = readCsv(FILES.batch2Messages);
const blockers = readCsv(FILES.blockers);
const deep = readCsv(FILES.deepResearch);
const hidden = readCsv(FILES.hiddenChampions);
const nextActions = readCsv(FILES.nextActions);

const byOrg = new Map();

function upsert(row, sourceTag) {
  const org = clean(row.organization);
  if (!org) return;
  const key = org.toLowerCase();
  const existing = byOrg.get(key) || {
    organization: org,
    segment: '',
    industry: '',
    target_role: '',
    email: '',
    phone: '',
    channel_primary: '',
    source_urls: '',
    linkedin_url: '',
    instagram_url: '',
    status_raw: '',
    next_action: '',
    evidence: '',
    from_sources: new Set(),
    status_rank: -1
  };

  const mergeIfEmpty = (field, value) => {
    const v = clean(value);
    if (!v) return;
    if (!clean(existing[field])) existing[field] = v;
  };

  mergeIfEmpty('segment', row.segment);
  mergeIfEmpty('industry', row.industry);
  mergeIfEmpty('target_role', row.target_role || row.role);
  mergeIfEmpty('email', row.email || row.recipient_email);
  mergeIfEmpty('phone', row.phone || row.recipient_phone);
  mergeIfEmpty('channel_primary', row.channel_primary || row.primary_channel || row.channel);
  mergeIfEmpty('source_urls', row.source_urls || row.source_url || row.website);
  mergeIfEmpty('linkedin_url', row.linkedin_url);
  mergeIfEmpty('instagram_url', row.instagram_url);

  if (clean(row.status)) {
    const rank = statusRank(row.status);
    if (rank >= existing.status_rank) {
      existing.status_raw = clean(row.status);
      existing.status_rank = rank;
    }
  }
  if (clean(row.next_action)) existing.next_action = clean(row.next_action);
  if (clean(row.evidence) || clean(row.validation_signals)) {
    existing.evidence = [clean(existing.evidence), clean(row.evidence), clean(row.validation_signals)]
      .filter(Boolean)
      .join(' | ');
  }

  existing.from_sources.add(sourceTag);
  byOrg.set(key, existing);
}

mixedSend.forEach((r) => upsert(r, 'mixed_send_now'));
batch2Msgs.forEach((r) => upsert(r, 'batch2_messages'));
blockers.forEach((r) => upsert(r, 'blockers'));
deep.forEach((r) => upsert(r, 'deep_research'));
hidden.forEach((r) => upsert(r, 'hidden_champions'));
nextActions.forEach((r) => upsert(r, 'next_actions'));

const rows = [...byOrg.values()].map((r) => {
  const override = trustedPhoneOverrides[r.organization.toLowerCase()] || '';
  const phoneNorm = override || normalizePhone(r.phone);
  const emailStat = emailStatus(r.email);
  const stage = stageFromStatus(r.status_raw, `${r.next_action} ${r.evidence}`);

  const recommendedChannel = stage === 'ACTION_REQUIRED_CALL'
    ? (phoneNorm ? 'whatsapp/call' : 'email')
    : (emailStat === 'valid_format' ? 'email' : (phoneNorm ? 'whatsapp/call' : 'research'));

  return {
    organization: r.organization,
    segment: r.segment || 'unknown',
    industry: r.industry || 'unknown',
    target_role: r.target_role || roleHint(r.industry),
    decision_stage: stage,
    status_raw: r.status_raw || 'n/a',
    recommended_channel: recommendedChannel,
    email: r.email,
    email_validation: emailStat,
    phone_raw: r.phone,
    phone_normalized: phoneNorm,
    phone_validation: phoneNorm ? 'valid_kenya_format' : 'invalid_or_missing',
    channel_primary: r.channel_primary,
    linkedin_url: r.linkedin_url,
    instagram_url: r.instagram_url,
    source_urls: r.source_urls,
    next_action: r.next_action || 'Triage and assign next action',
    evidence: r.evidence,
    from_sources: [...r.from_sources].sort().join('|')
  };
});

rows.sort((a, b) => a.organization.localeCompare(b.organization));
writeCsv(OUT.master, rows);

const callQueue = rows
  .filter((r) => !!r.phone_normalized)
  .map((r) => {
    let priority = 40;
    if (r.decision_stage === 'ACTION_REQUIRED_CALL') priority = 100;
    else if (r.decision_stage === 'OUTREACH_SENT') priority = 85;
    else if (r.decision_stage === 'BATCH2_QUEUE') priority = 75;
    else if (r.decision_stage === 'DEFERRED_24H') priority = 60;
    else if (r.decision_stage === 'RESEARCH_BLOCKER') priority = 55;

    return {
      organization: r.organization,
      industry: r.industry,
      decision_stage: r.decision_stage,
      phone: r.phone_normalized,
      whatsapp_url: `https://wa.me/${r.phone_normalized.replace('+', '')}`,
      recommended_script: r.decision_stage === 'ACTION_REQUIRED_CALL'
        ? 'Call now and ask for decision owner for same-day pilot close'
        : 'Use short value opener and ask for 15-minute pilot call',
      priority_score: priority,
      next_action: r.next_action
    };
  })
  .sort((a, b) => b.priority_score - a.priority_score);

writeCsv(OUT.callQueue, callQueue);

const decisionRows = rows.map((r) => {
  const key = r.organization.toLowerCase();
  const ev = socialEvidence[key] || {};
  const targetRole = r.target_role || roleHint(r.industry);

  return {
    organization: r.organization,
    target_decision_maker_role: targetRole,
    known_person_or_path: ev.known_contacts || 'No named person verified yet; use role-based outreach',
    linkedin_company: r.linkedin_url || 'n/a',
    instagram_company: r.instagram_url || 'n/a',
    priority_search_query_1: `${r.organization} ${targetRole} LinkedIn Kenya`,
    priority_search_query_2: `${r.organization} ${targetRole} email`,
    priority_search_query_3: `${r.organization} ${targetRole} Instagram`,
    social_research_source: ev.source || r.source_urls || 'n/a',
    next_action: 'Identify named role owner and update email/phone if better contact exists'
  };
});

writeCsv(OUT.decisionMakers, decisionRows);

const stageCounts = rows.reduce((acc, r) => {
  acc[r.decision_stage] = (acc[r.decision_stage] || 0) + 1;
  return acc;
}, {});

const review = [
  '# ABOSS Conversion Pipeline Review (2026-07-06)',
  '',
  '## Snapshot',
  `- Total leads tracked: ${rows.length}`,
  `- ACTION_REQUIRED_CALL: ${stageCounts.ACTION_REQUIRED_CALL || 0}`,
  `- OUTREACH_SENT: ${stageCounts.OUTREACH_SENT || 0}`,
  `- DEFERRED_24H: ${stageCounts.DEFERRED_24H || 0}`,
  `- BATCH2_QUEUE: ${stageCounts.BATCH2_QUEUE || 0}`,
  `- RESEARCH_BLOCKER: ${stageCounts.RESEARCH_BLOCKER || 0}`,
  `- RESEARCH_POOL: ${stageCounts.RESEARCH_POOL || 0}`,
  '',
  '## Files',
  '- ABOSS_CONVERSION_PIPELINE_MASTER.csv',
  '- ABOSS_CALL_WHATSAPP_PRIORITY.csv',
  '- ABOSS_DECISION_MAKER_RESEARCH.csv',
  '',
  '## Immediate Focus',
  '1. Work top rows in ABOSS_CALL_WHATSAPP_PRIORITY.csv for live call/WhatsApp conversion attempts.',
  '2. Use ABOSS_CONVERSION_PIPELINE_MASTER.csv as source-of-truth for channel and status decisions.',
  '3. Use ABOSS_DECISION_MAKER_RESEARCH.csv to replace generic inboxes with named decision makers.'
].join('\n');

fs.writeFileSync(OUT.review, review, 'utf8');

console.log(`Tracked leads: ${rows.length}`);
console.log(`Call/WhatsApp priority rows: ${callQueue.length}`);
console.log(`Wrote: ${path.basename(OUT.master)}`);
console.log(`Wrote: ${path.basename(OUT.callQueue)}`);
console.log(`Wrote: ${path.basename(OUT.decisionMakers)}`);
console.log(`Wrote: ${path.basename(OUT.review)}`);
