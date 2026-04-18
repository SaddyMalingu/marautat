// sendTemplate.js
import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith("254") && digits.length >= 12) return digits;
  if (digits.length === 9) return `254${digits}`;
  return digits;
}

function parseArgs(argv) {
  const options = {
    template: "afrika",
    language: "en",
    delayMs: 800,
    to: null,
    list: null,
    file: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if ((token === "--to" || token === "-t") && next) {
      options.to = next;
      i += 1;
      continue;
    }
    if ((token === "--list" || token === "-l") && next) {
      options.list = next;
      i += 1;
      continue;
    }
    if ((token === "--file" || token === "-f") && next) {
      options.file = next;
      i += 1;
      continue;
    }
    if ((token === "--template" || token === "--name") && next) {
      options.template = next;
      i += 1;
      continue;
    }
    if ((token === "--lang" || token === "--language") && next) {
      options.language = next;
      i += 1;
      continue;
    }
    if (token === "--delay" && next) {
      options.delayMs = Math.max(0, Number(next) || 0);
      i += 1;
      continue;
    }
  }

  return options;
}

function collectRecipients(options) {
  const items = [];

  if (options.to) items.push(options.to);

  if (options.list) {
    options.list
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => items.push(value));
  }

  if (options.file) {
    const raw = fs.readFileSync(options.file, "utf8");
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .forEach((line) => items.push(line));
  }

  const normalized = items
    .map(normalizePhone)
    .filter(Boolean);

  return [...new Set(normalized)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTemplate(to, templateName, languageCode) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ Template '${templateName}' sent to ${to}`);
    return { ok: true, to, data: res.data };
  } catch (err) {
    const errorMsg = JSON.stringify(err.response?.data || err.message);
    console.error(`❌ Failed for ${to}: ${errorMsg}`);
    return { ok: false, to, error: err.response?.data || err.message };
  }
}

async function main() {
  if (!process.env.PHONE_NUMBER_ID || !process.env.WHATSAPP_TOKEN) {
    console.error("❌ Missing PHONE_NUMBER_ID or WHATSAPP_TOKEN in environment.");
    process.exit(1);
  }

  const options = parseArgs(process.argv.slice(2));
  const recipients = collectRecipients(options);

  if (recipients.length === 0) {
    console.error("⚠️ Usage:");
    console.error("  node sendTemplate.js --to 2547XXXXXXXX");
    console.error("  node sendTemplate.js --list 2547XXXXXXX,2547YYYYYYY");
    console.error("  node sendTemplate.js --file leads.txt");
    console.error("Optional:");
    console.error("  --template afrika --lang en --delay 800");
    process.exit(1);
  }

  console.log(`🚀 Sending template '${options.template}' to ${recipients.length} recipient(s)...`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += 1) {
    const to = recipients[i];
    const result = await sendTemplate(to, options.template, options.language);
    if (result.ok) success += 1;
    else failed += 1;

    if (i < recipients.length - 1 && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  console.log("\n📊 Campaign Summary");
  console.log(`✅ Success: ${success}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📦 Total: ${recipients.length}`);
}

main().catch((err) => {
  console.error("❌ Campaign aborted:", err.message);
  process.exit(1);
});
