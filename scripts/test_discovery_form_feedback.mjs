#!/usr/bin/env node

/**
 * Verifies the client discovery form actually tells the client what happened.
 *
 * Live 2026-10-26: the form hid itself on submit (`form.style.display = 'none'`)
 * and the "Thank you" panel was a child of that form, so a successful submission
 * replaced the page with a blank screen — the client could not tell whether it
 * had worked, and re-submitted. The error path was no better: a raw `alert()`
 * with the exception text, and an unguarded `resp.json()` that turned a 502 into
 * "Unexpected token < in JSON".
 *
 * Part 1 is markup (the panel must live outside the form).
 * Part 2 runs the real inline script against a tiny DOM stub and drives the
 * success and failure branches, so "the confirmation appears" is asserted, not
 * assumed.
 *
 * Runs offline. Usage: npm run test:discovery-form
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */

import fs from "node:fs";
import chalk from "chalk";

const FORM_FILE = "public/client-discovery-form.html";
const html = fs.readFileSync(FORM_FILE, "utf8");
const results = [];
const record = (status, name, detail = "") => {
  results.push({ status, name, detail });
  const line = `${name}${detail ? " — " + detail : ""}`;
  if (status === "PASS") console.log(chalk.green(`+ ${line}`));
  else console.log(chalk.red(`x ${line}`));
};
async function check(name, fn) {
  try {
    const detail = await fn();
    record("PASS", name, detail || "");
  } catch (e) {
    record("FAIL", name, e.message);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------------------------------------------------------------------
// Part 1 — markup contract.
const formOpen = html.indexOf('<form id="discoveryForm">');
const formClose = html.indexOf("</form>");
const successAt = html.indexOf('id="successMessage"');
const errorAt = html.indexOf('id="errorMessage"');

await check("confirmation panel exists", () => {
  assert(successAt > -1, "#successMessage is missing");
  return "#successMessage";
});

await check("confirmation panel is outside the form that gets hidden", () => {
  assert(formOpen > -1 && formClose > formOpen, "form element not found");
  assert(successAt > formClose, `successMessage@${successAt} is inside the form (closes at ${formClose})`);
  return "after </form>";
});

await check("error panel is outside the form", () => {
  assert(errorAt > -1, "#errorMessage is missing");
  assert(errorAt > formClose, "errorMessage is inside the form");
  return "after </form>";
});

await check("no blocking alert() left in the submit path", () => {
  assert(!/\balert\(/.test(html), "alert() is still used");
  return "inline error panel";
});

// ---------------------------------------------------------------------------
// Part 2 — behaviour. The inline script is pulled out of the page verbatim.
const script = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]).join("\n");

function makeDom() {
  const el = (id) => ({
    id, style: {}, textContent: "", disabled: false,
    scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; },
  });
  const submitBtn = { textContent: "Submit Questionnaire", disabled: false };
  const form = el("discoveryForm");
  form.querySelector = (sel) => (sel === 'button[type="submit"]' ? submitBtn : null);
  const elements = {
    discoveryForm: form,
    successMessage: el("successMessage"),
    successReference: el("successReference"),
    errorMessage: el("errorMessage"),
  };
  // The stylesheet hides both panels; the script is what reveals one.
  elements.successMessage.style.display = "none";
  elements.errorMessage.style.display = "none";
  let submitHandler = null;
  form.addEventListener = (event, fn) => { if (event === "submit") submitHandler = fn; };
  const document = { getElementById: (id) => elements[id] || null };
  const window = { scrollTo() { window.scrolled = (window.scrolled || 0) + 1; } };
  return { elements, submitBtn, document, window, getHandler: () => submitHandler };
}

function makeFormData(values) {
  return class FakeFormData {
    constructor() { this.map = values; }
    get(k) { return this.map[k] === undefined ? null : this.map[k]; }
    getAll(k) { const v = this.map[k]; return Array.isArray(v) ? v : (v ? [v] : []); }
  };
}

const SUBMISSION = {
  name: "Jane Doe", business_name: "Kassangas Music Shop", email: "jane@example.com",
  phone: "254743780542", industry: "retail", team_size: "1-5", whatsapp_usage: "daily",
  revenue_target: "500000", ownership_interest: "yes", timeline: "30-days", budget: "50000",
};

async function drive(fetchImpl) {
  const dom = makeDom();
  const FormDataStub = makeFormData(SUBMISSION);
  // Runs the page's own script — no reimplementation of its logic.
  new Function("document", "FormData", "fetch", "window", script)(
    dom.document, FormDataStub, fetchImpl, dom.window,
  );
  const handler = dom.getHandler();
  if (!handler) throw new Error("no submit handler was registered");
  await handler({ preventDefault() {} });
  return dom;
}

// ---------------------------------------------------------------------------
await check("success: form hides, confirmation shows with a reference", async () => {
  const dom = await drive(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, saved: true, submission_id: "DSC-TEST-1" }),
  }));
  assert(dom.elements.discoveryForm.style.display === "none", "form is still visible after submit");
  assert(dom.elements.successMessage.style.display === "block", "confirmation is not visible");
  assert(dom.elements.errorMessage.style.display === "none", "error panel shown on success");
  assert(/DSC-TEST-1/.test(dom.elements.successReference.textContent), "reference not shown: " + dom.elements.successReference.textContent);
  assert(dom.window.scrolled > 0, "page was not scrolled to the confirmation");
  return "visible + reference";
});

await check("success: submit button is re-enabled with its label", async () => {
  const dom = await drive(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, submission_id: "X" }) }));
  assert(dom.submitBtn.disabled === false, "button left disabled");
  assert(dom.submitBtn.textContent === "Submit Questionnaire", "button label: " + dom.submitBtn.textContent);
  return "re-enabled";
});

await check("rejection: form stays filled in, error panel explains why", async () => {
  const dom = await drive(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, error: "Missing required fields: phone" }),
  }));
  assert(dom.elements.discoveryForm.style.display !== "none", "form was hidden despite the failure");
  assert(dom.elements.errorMessage.style.display === "block", "error panel is not visible");
  assert(/Missing required fields: phone/.test(dom.elements.errorMessage.textContent), "server reason not shown: " + dom.elements.errorMessage.textContent);
  assert(dom.elements.successMessage.style.display === "none", "success panel shown on failure");
  assert(dom.submitBtn.disabled === false, "button left disabled after failure");
  return "reason surfaced";
});

await check("network failure: no exception escapes, error panel shows", async () => {
  const dom = await drive(async () => { throw new Error("Failed to fetch"); });
  assert(dom.elements.errorMessage.style.display === "block", "no error shown");
  assert(/Failed to fetch/.test(dom.elements.errorMessage.textContent), "cause not shown");
  assert(dom.submitBtn.disabled === false, "button left disabled after a network failure");
  return "handled";
});

await check("HTML error page (proxy/502) does not surface a JSON parse error", async () => {
  const dom = await drive(async () => ({
    ok: false,
    status: 502,
    json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); },
  }));
  assert(dom.elements.errorMessage.style.display === "block", "no error shown");
  assert(!/Unexpected token/i.test(dom.elements.errorMessage.textContent), "raw parse error leaked to the client");
  assert(/502/.test(dom.elements.errorMessage.textContent), "status not mentioned: " + dom.elements.errorMessage.textContent);
  return "status 502 reported";
});

await check("a second submit clears the previous message", async () => {
  const dom = await drive(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, submission_id: "Y" }) }));
  dom.elements.errorMessage.textContent = "stale error";
  dom.elements.errorMessage.style.display = "block";
  await dom.getHandler()({ preventDefault() {} });
  assert(dom.elements.errorMessage.style.display === "none", "stale error panel remained");
  return "state reset";
});

// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.status === "FAIL");
console.log("");
if (failed.length) {
  console.log(chalk.red(`${failed.length} of ${results.length} checks failed`));
  process.exitCode = 1;
} else {
  console.log(chalk.green(`All ${results.length} checks passed`));
}
