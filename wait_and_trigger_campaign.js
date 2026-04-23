#!/usr/bin/env node
import axios from "axios";

const checkUrl = "https://alphadome.onrender.com/admin/health?key=myverify123";
const campaignUrl = "https://alphadome.onrender.com/admin/api/campaign/send-template?key=myverify123";

const body = {
  audience: "existing_db_users",
  template: "alphadome",
  language: "en",
  window_hours: 8760,
  limit: 8,
  delay_ms: 1400,
  dry_run: false,
  exclude_keywords: ["gideon", "kassangas"],
  exclude_phones: ["254702245555", "254117604817", "254743780542"],
};

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function endpointExists() {
  try {
    await axios.post(
      campaignUrl,
      { ...body, dry_run: true, limit: 1 },
      { timeout: 30000 }
    );
    return { ok: true };
  } catch (err) {
    if (err?.response?.status === 404) return { ok: false, reason: "route_not_live" };
    if (err?.response?.status === 500) return { ok: true, reason: "live_but_runtime_error", detail: err.response.data };
    if (err?.response?.status === 401) return { ok: true, reason: "live_unauthorized" };
    return { ok: false, reason: err.message || "unknown" };
  }
}

async function triggerCampaign() {
  const res = await axios.post(campaignUrl, body, { timeout: 240000 });
  return res.data;
}

async function main() {
  console.log("Waiting for deploy to expose /admin/api/campaign/send-template ...");
  let attempts = 0;
  while (attempts < 40) {
    attempts += 1;
    try {
      const health = await axios.get(checkUrl, { timeout: 20000 });
      console.log(`Health OK (${attempts}): ${JSON.stringify(health.data)}`);
    } catch (err) {
      console.log(`Health check issue (${attempts}): ${err.message}`);
    }

    const route = await endpointExists();
    console.log(`Route check (${attempts}): ${JSON.stringify(route)}`);
    if (route.ok) {
      try {
        const result = await triggerCampaign();
        console.log("Campaign sent successfully:");
        console.log(JSON.stringify(result, null, 2));
        return;
      } catch (err) {
        console.log("Campaign trigger returned error:", err?.response?.status || "n/a", err?.response?.data ? JSON.stringify(err.response.data) : err.message);
        return;
      }
    }

    await pause(20000);
  }

  console.log("Stopped waiting after max attempts.");
}

main().catch((err) => {
  console.error("Auto-trigger failed:", err.message || err);
  process.exit(1);
});
