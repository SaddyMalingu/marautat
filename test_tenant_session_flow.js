#!/usr/bin/env node

/**
 * Tenant Session Smoke Test
 *
 * Verifies:
 * 1) Tenant session login succeeds
 * 2) Protected endpoint accepts valid token
 * 3) Logout revokes token
 * 4) Same token is rejected after logout
 *
 * Usage:
 *   node test_tenant_session_flow.js
 *
 * Optional env vars:
 *   BASE_URL=http://localhost:3000
 *   TENANT_TEST_PHONE=2547...
 *   TENANT_DASHBOARD_PASS=...
 *   ADMIN_PASS=... (used as fallback key)
 */

import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config();

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TENANT_PHONE = process.env.TENANT_TEST_PHONE || process.env.TENANT_PHONE || "";
const DASHBOARD_KEY = process.env.TENANT_DASHBOARD_PASS || process.env.ADMIN_PASS || "";
const AUTO_CREATE_TEST_TENANT = String(process.env.AUTO_CREATE_TEST_TENANT || "false").toLowerCase() === "true";

const SB_URL = process.env.SB_URL || "";
const SB_SERVICE_ROLE_KEY = process.env.SB_SERVICE_ROLE_KEY || "";

const logInfo = (msg) => console.log(chalk.blue(`i ${msg}`));
const logPass = (msg) => console.log(chalk.green(`+ ${msg}`));
const logFail = (msg) => console.log(chalk.red(`x ${msg}`));

function getSupabase() {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL and SB_SERVICE_ROLE_KEY are required for AUTO_CREATE_TEST_TENANT mode");
  }
  return createClient(SB_URL, SB_SERVICE_ROLE_KEY);
}

async function ensureTenantExists(phone) {
  const sb = getSupabase();
  const { data: existing, error: queryError } = await sb
    .from("alphadome.bot_tenants")
    .select("id")
    .eq("client_phone", phone)
    .limit(1)
    .maybeSingle();

  if (queryError) {
    throw new Error(`Failed checking tenant existence: ${queryError.message}`);
  }

  if (existing?.id) {
    return { created: false, id: existing.id };
  }

  const suffix = Date.now();
  const payload = {
    client_name: `Smoke Test Tenant ${suffix}`,
    client_phone: phone,
    client_email: `smoke+${suffix}@example.com`,
    point_of_contact_name: "Smoke Test",
    whatsapp_phone_number_id: `TEST_PHONE_ID_${suffix}`,
    whatsapp_business_account_id: `TEST_WABA_${suffix}`,
    whatsapp_access_token: `TEST_TOKEN_${suffix}`,
    ai_provider: "openai",
    ai_api_key: "test-key-placeholder",
    ai_model: "gpt-4o-mini",
    is_active: true,
    is_verified: false,
    webhook_verify_token: `tenant_smoke_${suffix}`,
    metadata: {
      created_by: "test_tenant_session_flow",
      temporary: true,
    },
  };

  const { data: inserted, error: insertError } = await sb
    .from("alphadome.bot_tenants")
    .insert(payload)
    .select("id")
    .maybeSingle();

  if (insertError) {
    throw new Error(`Failed creating temporary tenant: ${insertError.message}`);
  }

  if (!inserted?.id) {
    throw new Error("Temporary tenant creation did not return an id");
  }

  return { created: true, id: inserted.id };
}

async function cleanupTemporaryTenant(id) {
  if (!id) return;
  const sb = getSupabase();
  const { error } = await sb
    .from("alphadome.bot_tenants")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`Failed cleaning up temporary tenant: ${error.message}`);
  }
}

async function run() {
  console.log(chalk.bold.cyan("\nTenant Session Smoke Test\n"));

  if (!TENANT_PHONE) {
    logFail("Missing TENANT_TEST_PHONE (or TENANT_PHONE) in environment.");
    process.exit(1);
  }

  if (!DASHBOARD_KEY) {
    logFail("Missing TENANT_DASHBOARD_PASS (or ADMIN_PASS) in environment.");
    process.exit(1);
  }

  logInfo(`Base URL: ${BASE_URL}`);
  logInfo(`Tenant phone: ${TENANT_PHONE}`);
  logInfo(`Auto-create mode: ${AUTO_CREATE_TEST_TENANT ? "enabled" : "disabled"}`);

  let token = "";
  let temporaryTenantId = "";
  let exitCode = 1;

  try {
    if (AUTO_CREATE_TEST_TENANT) {
      const ensured = await ensureTenantExists(TENANT_PHONE);
      if (ensured.created) {
        temporaryTenantId = ensured.id;
        logPass(`Temporary tenant created: ${temporaryTenantId}`);
      } else {
        logInfo("Tenant already exists; using existing record.");
      }
    }

    // 1) Login
    try {
      const loginRes = await axios.post(`${BASE_URL}/tenant/session/login`, {
        tenant_phone: TENANT_PHONE,
        key: DASHBOARD_KEY,
      });

      token = String(loginRes.data?.token || "").trim();
      if (!token) {
        throw new Error("Login response did not include token");
      }
      logPass("Login succeeded and token issued.");
    } catch (error) {
      const status = error?.response?.status;
      const msg = error?.response?.data?.error || error.message;
      if (status === 404 && !AUTO_CREATE_TEST_TENANT) {
        logFail(`Login failed (tenant not found): ${msg}`);
        logInfo("Tip: set AUTO_CREATE_TEST_TENANT=true to create and clean up a temporary tenant automatically.");
      } else {
        logFail(`Login failed: ${msg}`);
      }
      return;
    }

    // 2) Protected endpoint should work with valid token
    try {
      await axios.get(`${BASE_URL}/tenant/catalog`, {
        headers: { "x-tenant-session": token },
      });
      logPass("Protected endpoint accepted active token.");
    } catch (error) {
      const msg = error?.response?.data?.error || error.message;
      logFail(`Protected call failed before logout: ${msg}`);
      return;
    }

    // 3) Logout should revoke token
    try {
      const logoutRes = await axios.post(
        `${BASE_URL}/tenant/session/logout`,
        {},
        { headers: { "x-tenant-session": token } }
      );

      if (!logoutRes.data?.ok) {
        throw new Error("Logout did not return ok=true");
      }
      logPass("Logout endpoint revoked token.");
    } catch (error) {
      const msg = error?.response?.data?.error || error.message;
      logFail(`Logout failed: ${msg}`);
      return;
    }

    // 4) Same token should now be rejected
    try {
      await axios.get(`${BASE_URL}/tenant/catalog`, {
        headers: { "x-tenant-session": token },
      });
      logFail("Token still works after logout; expected 401 rejection.");
      return;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 401) {
        logPass("Revoked token is correctly rejected after logout.");
        console.log(chalk.bold.green("\nSmoke test passed.\n"));
        exitCode = 0;
        return;
      }
      const msg = error?.response?.data?.error || error.message;
      logFail(`Unexpected status after logout (expected 401): ${status || "n/a"} - ${msg}`);
      return;
    }
  } catch (error) {
    logFail(`Unexpected failure: ${error.message}`);
  } finally {
    if (temporaryTenantId) {
      try {
        await cleanupTemporaryTenant(temporaryTenantId);
        logPass(`Temporary tenant cleaned up: ${temporaryTenantId}`);
      } catch (cleanupError) {
        logFail(cleanupError.message);
        exitCode = 1;
      }
    }
    process.exit(exitCode);
  }
}

run();
