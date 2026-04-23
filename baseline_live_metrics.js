#!/usr/bin/env node
import axios from "axios";

const base = "https://alphadome.onrender.com";
const key = "myverify123";

const res = await axios.get(`${base}/admin/ops-overview?key=${key}`, { timeout: 20000 });
const k = res.data?.kpis || {};
console.log(JSON.stringify({
  at: new Date().toISOString(),
  revenue_kes: k.revenue_kes ?? 0,
  attempts_7d: k.attempts_7d ?? 0,
  incoming_24h: k.incoming_24h ?? 0,
  hot_leads: k.hot_leads ?? 0,
  failed_count: k.failed_count ?? 0,
  pending_count: k.pending_count ?? 0
}, null, 2));
