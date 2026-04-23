#!/usr/bin/env node
import axios from "axios";

const url = "https://alphadome.onrender.com/admin/api/campaign/send-template?key=myverify123";
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

try {
  const res = await axios.post(url, body, { timeout: 180000 });
  console.log(JSON.stringify(res.data, null, 2));
} catch (err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  console.error("Campaign trigger failed:", status || "n/a", data ? JSON.stringify(data) : err.message);
  process.exit(1);
}
