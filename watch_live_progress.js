#!/usr/bin/env node
import fs from "fs";
import path from "path";
import axios from "axios";

const BASE_URL = "https://alphadome.onrender.com";
const KEY = "myverify123";
const INTERVAL_MS = Number(process.env.PROGRESS_INTERVAL_MS || 120000);

const outDir = path.join(process.cwd(), "logs");
const outFile = path.join(outDir, "live_progress.jsonl");
fs.mkdirSync(outDir, { recursive: true });

function pickMetrics(payload) {
  const k = payload?.kpis || {};
  return {
    revenue_kes: Number(k.revenue_kes || 0),
    attempts_7d: Number(k.attempts_7d || 0),
    conversion_rate_pct: Number(k.conversion_rate_pct || 0),
    incoming_24h: Number(k.incoming_24h || 0),
    hot_leads: Number(k.hot_leads || 0),
    failed_count: Number(k.failed_count || 0),
    pending_count: Number(k.pending_count || 0),
    fallback_queue: Number(k.fallback_queue || 0),
  };
}

function printDelta(prev, next) {
  if (!prev) {
    console.log(`Baseline: rev=${next.revenue_kes}, attempts=${next.attempts_7d}, incoming24h=${next.incoming_24h}, hot=${next.hot_leads}`);
    return;
  }
  const d = {
    revenue_kes: next.revenue_kes - prev.revenue_kes,
    attempts_7d: next.attempts_7d - prev.attempts_7d,
    incoming_24h: next.incoming_24h - prev.incoming_24h,
    hot_leads: next.hot_leads - prev.hot_leads,
    pending_count: next.pending_count - prev.pending_count,
  };
  console.log(`Delta: rev ${d.revenue_kes >= 0 ? "+" : ""}${d.revenue_kes}, attempts ${d.attempts_7d >= 0 ? "+" : ""}${d.attempts_7d}, incoming ${d.incoming_24h >= 0 ? "+" : ""}${d.incoming_24h}, hot ${d.hot_leads >= 0 ? "+" : ""}${d.hot_leads}, pending ${d.pending_count >= 0 ? "+" : ""}${d.pending_count}`);
}

async function fetchOps() {
  const res = await axios.get(`${BASE_URL}/admin/ops-overview?key=${KEY}`, { timeout: 20000 });
  return pickMetrics(res.data || {});
}

let previous = null;

async function tick() {
  const at = new Date().toISOString();
  try {
    const current = await fetchOps();
    printDelta(previous, current);
    const row = { at, ok: true, metrics: current };
    fs.appendFileSync(outFile, JSON.stringify(row) + "\n", "utf8");
    previous = current;
  } catch (err) {
    const row = { at, ok: false, error: err?.response?.data || err.message || "unknown" };
    fs.appendFileSync(outFile, JSON.stringify(row) + "\n", "utf8");
    console.log("Tick error:", typeof row.error === "string" ? row.error : JSON.stringify(row.error));
  }
}

console.log(`Watching live progress every ${Math.round(INTERVAL_MS / 1000)}s -> ${outFile}`);
await tick();
setInterval(() => {
  tick().catch(() => {});
}, INTERVAL_MS);
