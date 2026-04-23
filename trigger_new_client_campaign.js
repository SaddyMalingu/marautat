#!/usr/bin/env node
import axios from "axios";

const url = "https://alphadome.onrender.com/admin/api/campaign/send-template?key=myverify123";

const body = {
  audience: "new_clients",
  template: "alphadome_new_client",
  language: "en",
  delay_ms: 1400,
  dry_run: true,
  limit: 20,
  // Replace with your new-client numbers when ready.
  phones: [
    "254700000001",
    "254700000002"
  ],
  exclude_phones: ["254702245555", "254117604817", "254743780542"],
};

try {
  const res = await axios.post(url, body, { timeout: 180000 });
  console.log(JSON.stringify(res.data, null, 2));
} catch (err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  console.error("New-client campaign trigger failed:", status || "n/a", data ? JSON.stringify(data) : err.message);
  process.exit(1);
}
