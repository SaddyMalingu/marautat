#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

function parseArgs(argv) {
  const options = {
    phones: [],
    since: null,
    limit: 100,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--phones') {
      options.phones = (argv[i + 1] || '').split(',').map((v) => v.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--since') {
      options.since = argv[i + 1];
      i += 1;
    } else if (arg === '--limit') {
      options.limit = Number(argv[i + 1] || 100);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function printUsage() {
  console.log(`Usage:\n  node scripts/check_db_outreach_logs.js --phones 254711000000,254709219000 --since 2026-07-06T00:00:00Z --limit 100\n\nEnvironment:\n  SUPABASE_URL\n  SUPABASE_KEY or SUPABASE_ANON_KEY`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_KEY (or SUPABASE_ANON_KEY).');
    printUsage();
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  const phones = options.phones;
  if (!phones.length) {
    console.error('Provide at least one phone number with --phones.');
    printUsage();
    process.exit(1);
  }

  const normalizedPhones = new Set(phones.map(normalizePhone));

  const { data: userRows, error: userError } = await supabase.from('users').select('id, phone').limit(5000);
  if (userError) {
    console.error('Failed to read users table:', userError.message);
    process.exit(1);
  }

  const matchedUserIds = (userRows || [])
    .filter((row) => normalizedPhones.has(normalizePhone(row.phone)))
    .map((row) => row.id);

  if (!matchedUserIds.length) {
    console.error('No matching users found for the supplied phones.');
    process.exit(1);
  }

  let query = supabase
    .from('conversations')
    .select('id, created_at, direction, message_text, whatsapp_message_id, user_id, brand_id')
    .in('user_id', matchedUserIds)
    .order('created_at', { ascending: false })
    .limit(options.limit);

  if (options.since) {
    query = query.gte('created_at', options.since);
  }

  const { data: conversationRows, error: convError } = await query;
  if (convError) {
    console.error('Failed to read conversations table:', convError.message);
    process.exit(1);
  }

  console.log(`Found ${conversationRows?.length || 0} conversation rows for ${matchedUserIds.length} matched user(s).`);
  console.log('---');

  for (const row of conversationRows || []) {
    console.log(JSON.stringify({
      id: row.id,
      created_at: row.created_at,
      direction: row.direction,
      user_id: row.user_id,
      brand_id: row.brand_id,
      message_text: row.message_text,
      whatsapp_message_id: row.whatsapp_message_id,
    }, null, 2));
    console.log('---');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
