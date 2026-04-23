#!/usr/bin/env node
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const sb = createClient(process.env.SB_URL, process.env.SB_SERVICE_ROLE_KEY);

const SENT = [
  "254788594040","254723236276","254797997676",
  "254705005555","254799040038","254762279184","254741866137","10000000001"
];

const since = "2026-04-18T16:00:00Z";
const until = "2026-04-18T17:30:00Z";

(async () => {
  const { data, error } = await sb
    .from("whatsapp_logs")
    .select("id, phone, status, error_message, created_at, tenant_id, payload, response")
    .in("phone", SENT)
    .gte("created_at", since)
    .lte("created_at", until)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    console.error("ERROR:", error.message);
    process.exit(1);
  }

  const normalized = (data || []).map((r) => {
    let templateName = null;
    let languageCode = null;
    try {
      templateName = r?.payload?.template?.name || r?.response?.template?.name || null;
      languageCode = r?.payload?.template?.language?.code || null;
    } catch {}
    return {
      id: r.id,
      phone: r.phone,
      status: r.status,
      created_at: r.created_at,
      error_message: r.error_message,
      template_name: templateName,
      language: languageCode,
      payload: r.payload || null,
    };
  });

  console.log(JSON.stringify({
    count: normalized.length,
    first: normalized[0] || null,
    last: normalized[normalized.length - 1] || null,
    rows: normalized
  }, null, 2));
})();
