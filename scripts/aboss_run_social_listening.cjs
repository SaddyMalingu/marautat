const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');

const TAXONOMY_PATH = path.join(DATA_DIR, 'aboss_social_intent_taxonomy.json');
const RAW_CAPTURE_PATH = path.join(DATA_DIR, 'ABOSS_SOCIAL_SIGNALS_RAW.csv');

const dateStr = new Date().toISOString().slice(0, 10);

const OUT_LEADS = path.join(LOG_DIR, 'ABOSS_SOCIAL_INTENT_LEADS.csv');
const OUT_READY = path.join(LOG_DIR, 'ABOSS_SOCIAL_OUTREACH_READY.csv');
const OUT_WHATSAPP = path.join(LOG_DIR, 'ABOSS_SOCIAL_WHATSAPP_PRIORITY.csv');
const OUT_REVIEW = path.join(LOG_DIR, `ABOSS_SOCIAL_CAPTURE_REVIEW_${dateStr}.md`);

const TEMPLATE_HEADER = [
  'captured_at',
  'platform',
  'author_handle',
  'author_name',
  'profile_url',
  'post_url',
  'post_text',
  'sector_hint',
  'city_hint',
  'intent_hint',
  'contact_hint',
  'captured_by'
].join(',');

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?254|0)(?:\d[\s().-]?){8,10}/g;
const DECISION_RE = /(owner|founder|procurement|operations|fleet|manager|head of|director|ceo|coo|commercial)/i;
const BUDGET_RE = /(ksh|kes|usd|\$)\s?\d+|\bunder\s+\d+|\bbudget\b/i;
const TIMELINE_RE = /\basap\b|\burgent\b|\bimmediately\b|\btoday\b|\bthis week\b|\bthis month\b|\bnext week\b|\bby end of\b/i;

function clean(v) {
  return String(v || '').trim();
}

function lc(v) {
  return clean(v).toLowerCase();
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function ensureRawTemplate() {
  if (fs.existsSync(RAW_CAPTURE_PATH)) return false;
  fs.writeFileSync(RAW_CAPTURE_PATH, `${TEMPLATE_HEADER}\n`, 'utf8');
  return true;
}

function readCsvRows(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheetName = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
}

function writeCsv(filePath, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  fs.writeFileSync(filePath, XLSX.utils.sheet_to_csv(ws), 'utf8');
}

function extractFirstEmail(text) {
  const matches = clean(text).match(EMAIL_RE) || [];
  return matches[0] || '';
}

function normalizeKenyaPhone(raw) {
  const digits = clean(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('254') && digits.length === 12) return `+${digits}`;
  if ((digits.startsWith('07') || digits.startsWith('01')) && digits.length === 10) return `+254${digits.slice(1)}`;
  return '';
}

function extractFirstPhone(text) {
  const matches = clean(text).match(PHONE_RE) || [];
  for (const m of matches) {
    const p = normalizeKenyaPhone(m);
    if (p) return p;
  }
  return '';
}

function matchPhrases(text, phrases) {
  const hay = lc(text);
  const hits = [];
  for (const p of phrases || []) {
    const phrase = lc(p);
    if (phrase && hay.includes(phrase)) hits.push(phrase);
  }
  return hits;
}

function pickIntent(row, taxonomy) {
  const textBlob = [
    row.post_text,
    row.intent_hint,
    row.sector_hint,
    row.city_hint,
    row.contact_hint
  ].map(clean).join(' ');

  let best = null;
  for (const intent of taxonomy.intents || []) {
    const triggerHits = matchPhrases(textBlob, intent.trigger_phrases || []);
    const warmHits = matchPhrases(textBlob, intent.warm_phrases || []);
    const exclusionHits = matchPhrases(textBlob, intent.exclusion_phrases || []);

    let score = 0;
    if (triggerHits.length) score += 35;
    else if (warmHits.length) score += 20;

    if (BUDGET_RE.test(textBlob)) score += 15;
    if (TIMELINE_RE.test(textBlob)) score += 15;

    const cities = [taxonomy.default_market, ...(taxonomy.default_city_focus || [])].filter(Boolean);
    if (cities.some((c) => lc(textBlob).includes(lc(c)))) score += 10;

    const contactBlob = [row.contact_hint, row.post_text].join(' ');
    if (extractFirstEmail(contactBlob) || extractFirstPhone(contactBlob) || /whatsapp|dm me|inbox/i.test(contactBlob)) {
      score += 10;
    }

    if (DECISION_RE.test(textBlob)) score += 10;
    if (exclusionHits.length) score -= 40;

    score = clamp(score, 0, 100);

    const candidate = {
      intent,
      triggerHits,
      warmHits,
      exclusionHits,
      score
    };

    if (!best || candidate.score > best.score) best = candidate;
  }

  return best;
}

function confidence(score) {
  if (score >= 70) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

function recommendedChannel(row, email, phone) {
  if (phone) return 'whatsapp/call';
  if (email) return 'email';
  if (clean(row.profile_url) || clean(row.post_url)) return 'social_dm';
  return 'research_needed';
}

function outreachTemplate(intentName, handleOrName) {
  const who = clean(handleOrName) || 'there';
  return `Hi ${who}, saw your post about ${intentName.toLowerCase()}. We can help you move from inquiry to decision fast with a practical shortlist and same-day next step. Open to a 10-minute chat?`;
}

function buildReview(rawCount, scored, ready, whatsappReady, templateCreated) {
  const lines = [
    `# ABOSS Social Listening Capture Review (${dateStr})`,
    '',
    '## Run Summary',
    `- Raw captured rows: ${rawCount}`,
    `- Scored rows: ${scored.length}`,
    `- Outreach-ready rows: ${ready.length}`,
    `- WhatsApp/call-ready rows: ${whatsappReady.length}`,
    `- Raw template created this run: ${templateCreated ? 'yes' : 'no'}`,
    '',
    '## Output Files',
    '- ABOSS_SOCIAL_INTENT_LEADS.csv',
    '- ABOSS_SOCIAL_OUTREACH_READY.csv',
    '- ABOSS_SOCIAL_WHATSAPP_PRIORITY.csv',
    '',
    '## Rules Applied',
    '1. No fabricated leads; every output row must originate from ABOSS_SOCIAL_SIGNALS_RAW.csv.',
    '2. Intent classification uses taxonomy trigger/warm/exclusion phrases and explicit scoring signals.',
    '3. Only score-qualified rows are promoted to outreach-ready queues.'
  ];

  fs.writeFileSync(OUT_REVIEW, lines.join('\n'), 'utf8');
}

function main() {
  ensureDirs();

  if (!fs.existsSync(TAXONOMY_PATH)) {
    console.error(`Missing taxonomy file: ${TAXONOMY_PATH}`);
    process.exit(1);
  }

  const templateCreated = ensureRawTemplate();
  const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));

  const rawRows = fs.existsSync(RAW_CAPTURE_PATH) ? readCsvRows(RAW_CAPTURE_PATH) : [];

  const scored = [];
  const seenPosts = new Set();

  for (const row of rawRows) {
    const postUrl = clean(row.post_url);
    if (!postUrl) continue;
    if (seenPosts.has(postUrl)) continue;
    seenPosts.add(postUrl);

    const best = pickIntent(row, taxonomy);
    if (!best || !best.intent) continue;

    const contactBlob = [row.contact_hint, row.post_text].join(' ');
    const email = extractFirstEmail(contactBlob);
    const phone = extractFirstPhone(contactBlob);
    const channel = recommendedChannel(row, email, phone);

    scored.push({
      captured_at: clean(row.captured_at) || new Date().toISOString(),
      platform: clean(row.platform),
      author_handle: clean(row.author_handle),
      author_name: clean(row.author_name),
      profile_url: clean(row.profile_url),
      post_url: postUrl,
      sector_hint: clean(row.sector_hint),
      city_hint: clean(row.city_hint),
      matched_intent_id: best.intent.intent_id,
      matched_intent_name: best.intent.intent_name,
      buyer_signal_strength: clean(best.intent.buyer_signal_strength),
      intent_score: best.score,
      confidence: confidence(best.score),
      trigger_hits: best.triggerHits.join(' | '),
      warm_hits: best.warmHits.join(' | '),
      exclusion_hits: best.exclusionHits.join(' | '),
      exclusion_flag: best.exclusionHits.length ? 'yes' : 'no',
      email: email,
      phone: phone,
      recommended_channel: channel,
      target_roles: (best.intent.decision_roles || []).join(' | '),
      next_action: best.score >= 65 && !best.exclusionHits.length
        ? 'Send contextual first-touch now'
        : 'Keep monitoring or enrich context before outreach',
      outreach_template: outreachTemplate(best.intent.intent_name, clean(row.author_name) || clean(row.author_handle)),
      post_text_snippet: clean(row.post_text).slice(0, 260),
      source_captured_by: clean(row.captured_by)
    });
  }

  scored.sort((a, b) => Number(b.intent_score) - Number(a.intent_score));

  const ready = scored
    .filter((r) => Number(r.intent_score) >= 65 && r.exclusion_flag !== 'yes')
    .map((r) => ({
      matched_intent_name: r.matched_intent_name,
      platform: r.platform,
      author_handle: r.author_handle,
      author_name: r.author_name,
      profile_url: r.profile_url,
      post_url: r.post_url,
      intent_score: r.intent_score,
      confidence: r.confidence,
      email: r.email,
      phone: r.phone,
      recommended_channel: r.recommended_channel,
      target_roles: r.target_roles,
      outreach_template: r.outreach_template,
      next_action: r.next_action
    }));

  const whatsappReady = ready
    .filter((r) => clean(r.phone))
    .map((r) => ({
      matched_intent_name: r.matched_intent_name,
      author_handle: r.author_handle,
      author_name: r.author_name,
      phone: r.phone,
      whatsapp_url: `https://wa.me/${r.phone.replace('+', '')}`,
      intent_score: r.intent_score,
      recommended_script: r.outreach_template,
      next_action: r.next_action,
      source_post: r.post_url
    }));

  writeCsv(OUT_LEADS, scored);
  writeCsv(OUT_READY, ready);
  writeCsv(OUT_WHATSAPP, whatsappReady);
  buildReview(rawRows.length, scored, ready, whatsappReady, templateCreated);

  console.log(`Raw rows read: ${rawRows.length}`);
  console.log(`Scored leads: ${scored.length}`);
  console.log(`Outreach-ready: ${ready.length}`);
  console.log(`WhatsApp-ready: ${whatsappReady.length}`);
  if (templateCreated) {
    console.log(`Created input template: ${path.basename(RAW_CAPTURE_PATH)}`);
  }
  console.log(`Wrote: ${path.basename(OUT_LEADS)}`);
  console.log(`Wrote: ${path.basename(OUT_READY)}`);
  console.log(`Wrote: ${path.basename(OUT_WHATSAPP)}`);
  console.log(`Wrote: ${path.basename(OUT_REVIEW)}`);
}

main();
