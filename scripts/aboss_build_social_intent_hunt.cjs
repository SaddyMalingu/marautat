const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, 'logs');
const TAXONOMY_PATH = path.join(ROOT, 'data', 'aboss_social_intent_taxonomy.json');

const OUT_QUERIES = path.join(LOG_DIR, 'ABOSS_SOCIAL_LISTENING_QUERIES.csv');
const OUT_PLAN = path.join(LOG_DIR, 'ABOSS_SOCIAL_INTENT_DAILY_PLAN.csv');
const OUT_REVIEW = path.join(LOG_DIR, 'ABOSS_SOCIAL_INTENT_PLAYBOOK_2026-07-06.md');

function clean(v) {
  return String(v || '').trim();
}

function uniq(arr) {
  return [...new Set((arr || []).map((x) => clean(x)).filter(Boolean))];
}

function pickTop(list, limit) {
  return uniq(list).slice(0, limit);
}

function writeCsv(filePath, rows) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(sheet);
  fs.writeFileSync(filePath, csv, 'utf8');
}

function queryTemplates(phrase, sector, city, market) {
  return [
    `\"${phrase}\" ${market}`,
    `\"${phrase}\" ${city}`,
    `${sector} \"${phrase}\" ${market}`,
    `${sector} buyer intent ${market}`,
    `${sector} procurement need ${market}`,
    `${sector} operations pain ${market}`
  ];
}

function buildQueries(taxonomy) {
  const rows = [];
  const platforms = uniq(taxonomy.platforms);
  const cities = uniq(taxonomy.default_city_focus);
  const market = clean(taxonomy.default_market) || 'Kenya';
  const slotsPerIntent = Number(taxonomy.query_slots_per_intent || 12);

  for (const intent of taxonomy.intents || []) {
    const sectors = pickTop(intent.sectors, 3);
    const trigger = pickTop(intent.trigger_phrases, 4);
    const warm = pickTop(intent.warm_phrases, 2);
    const phrases = [...trigger, ...warm];

    let generated = 0;
    for (const platform of platforms) {
      for (const sector of sectors) {
        for (const city of cities) {
          for (const phrase of phrases) {
            if (generated >= slotsPerIntent) break;
            const pack = queryTemplates(phrase, sector, city, market);
            rows.push({
              intent_id: intent.intent_id,
              intent_name: intent.intent_name,
              platform,
              sector,
              city,
              buyer_signal_strength: intent.buyer_signal_strength,
              daily_target_min: intent.target_daily_min_leads,
              daily_target_max: intent.target_daily_max_leads,
              query_1: pack[0],
              query_2: pack[1],
              query_3: pack[2],
              query_4: pack[3],
              query_5: pack[4],
              query_6: pack[5],
              exclude_terms: (intent.exclusion_phrases || []).join(' | '),
              target_roles: (intent.decision_roles || []).join(' | '),
              offer_angle: clean(intent.offer_angle)
            });
            generated += 1;
          }
          if (generated >= slotsPerIntent) break;
        }
        if (generated >= slotsPerIntent) break;
      }
      if (generated >= slotsPerIntent) break;
    }
  }

  return rows;
}

function buildDailyPlan(taxonomy) {
  return (taxonomy.intents || []).map((intent) => {
    const min = Number(intent.target_daily_min_leads || 10);
    const max = Number(intent.target_daily_max_leads || 20);
    const target = Math.round((min + max) / 2);

    return {
      intent_id: intent.intent_id,
      intent_name: intent.intent_name,
      buyer_signal_strength: clean(intent.buyer_signal_strength),
      sectors: (intent.sectors || []).join(' | '),
      target_daily_min_leads: min,
      target_daily_max_leads: max,
      target_daily_operating_leads: target,
      primary_trigger_terms: pickTop(intent.trigger_phrases, 4).join(' | '),
      warm_signal_terms: pickTop(intent.warm_phrases, 3).join(' | '),
      exclusion_terms: (intent.exclusion_phrases || []).join(' | '),
      primary_decision_roles: (intent.decision_roles || []).join(' | '),
      offer_angle: clean(intent.offer_angle)
    };
  });
}

function writeReview(taxonomy, queryRows, dailyPlanRows) {
  const totalMin = dailyPlanRows.reduce((sum, r) => sum + Number(r.target_daily_min_leads || 0), 0);
  const totalMax = dailyPlanRows.reduce((sum, r) => sum + Number(r.target_daily_max_leads || 0), 0);
  const totalOperating = dailyPlanRows.reduce((sum, r) => sum + Number(r.target_daily_operating_leads || 0), 0);

  const lines = [
    '# ABOSS Social Intent Playbook (2026-07-06)',
    '',
    '## Scope',
    `- Intent categories: ${dailyPlanRows.length}`,
    `- Daily lead floor (all intents): ${totalMin}`,
    `- Daily lead ceiling (all intents): ${totalMax}`,
    `- Daily operating target (all intents): ${totalOperating}`,
    `- Query rows generated: ${queryRows.length}`,
    '',
    '## Files',
    '- ABOSS_SOCIAL_INTENT_DAILY_PLAN.csv',
    '- ABOSS_SOCIAL_LISTENING_QUERIES.csv',
    '',
    '## Execution Standard',
    '1. Work hot intents first, then warm intents.',
    '2. Capture only posts with explicit demand signals and timeline clues.',
    '3. Route each captured lead to NEW_SOCIAL_INTENT -> CONTACT_READY -> CONTACTED -> FOLLOWUP_24H.',
    '4. Keep exclusions strict to avoid low-intent noise.',
    '',
    '## Per-Intent Rule',
    '- Every intent category is configured to produce 10-30 leads/day (or a tighter range where quality requires).'
  ];

  fs.writeFileSync(OUT_REVIEW, lines.join('\n'), 'utf8');
}

if (!fs.existsSync(TAXONOMY_PATH)) {
  console.error(`Missing taxonomy: ${TAXONOMY_PATH}`);
  process.exit(1);
}

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
const queryRows = buildQueries(taxonomy);
const dailyPlanRows = buildDailyPlan(taxonomy).sort((a, b) => b.target_daily_operating_leads - a.target_daily_operating_leads);

writeCsv(OUT_QUERIES, queryRows);
writeCsv(OUT_PLAN, dailyPlanRows);
writeReview(taxonomy, queryRows, dailyPlanRows);

console.log(`Intent categories: ${dailyPlanRows.length}`);
console.log(`Query rows generated: ${queryRows.length}`);
console.log(`Wrote: ${path.basename(OUT_PLAN)}`);
console.log(`Wrote: ${path.basename(OUT_QUERIES)}`);
console.log(`Wrote: ${path.basename(OUT_REVIEW)}`);
