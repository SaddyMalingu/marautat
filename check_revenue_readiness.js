#!/usr/bin/env node
/**
 * 7-Day Revenue Implementation Checker
 * Run this daily to track progress and identify blockers
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(message, type = 'info') {
  const prefix = {
    success: `${colors.green}✅${colors.reset}`,
    error: `${colors.red}❌${colors.reset}`,
    warn: `${colors.yellow}⚠️${colors.reset}`,
    info: `${colors.blue}ℹ️${colors.reset}`,
  }[type] || '•';
  
  console.log(`${prefix} ${message}`);
}

function isPlaceholderValue(value = "") {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return true;
  const placeholders = [
    "your_",
    "placeholder",
    "changeme",
    "replace_me",
    "test_",
  ];
  return placeholders.some((p) => v.includes(p));
}

async function supabaseGetWithSchemaFallback(path) {
  const baseUrl = `${process.env.SB_URL}/rest/v1/${path}`;
  const token = process.env.SB_SERVICE_ROLE_KEY;

  const headerCombos = [
    {
      apikey: token,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    {
      apikey: token,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Profile": "alphadome",
      "Content-Profile": "alphadome",
    },
  ];

  let lastErr = null;
  for (const headers of headerCombos) {
    try {
      return await axios.get(baseUrl, { headers, timeout: 10000 });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function checkServer() {
  try {
    const response = await axios.get('http://localhost:3000/', { timeout: 5000 });
    log('Server running on http://localhost:3000', 'success');
    return true;
  } catch (err) {
    log(`Server not responding: ${err.message}`, 'error');
    return false;
  }
}

async function checkEnvironment() {
  const required = [
    'WHATSAPP_TOKEN',
    'PHONE_NUMBER_ID',
    'MPESA_CONSUMER_KEY',
    'MPESA_CONSUMER_SECRET',
    'MPESA_SHORTCODE',
    'MPESA_PASSKEY',
    'MPESA_ENV',
    'MPESA_CALLBACK_URL',
    'SB_URL',
    'SB_SERVICE_ROLE_KEY',
    'ADMIN_PASS',
    'TENANT_DASHBOARD_PASS',
  ];

  log('\n' + colors.bold + 'Environment Variables' + colors.reset);
  
  let allSet = true;
  for (const key of required) {
    const value = process.env[key];
    const isSet = !!value;
    const length = value ? value.length : 0;
    const isPlaceholder = isPlaceholderValue(value);
    
    if (isSet && !isPlaceholder) {
      log(`${key}: SET (${Math.min(length, 50)} chars)`, 'success');
    } else if (isSet && isPlaceholder) {
      log(`${key}: SET but looks like placeholder`, 'warn');
      allSet = false;
    } else {
      log(`${key}: NOT SET`, 'error');
      allSet = false;
    }
  }
  
  return allSet;
}

async function checkMpesaCredentials() {
  log('\n' + colors.bold + 'M-Pesa Configuration' + colors.reset);
  
  try {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    
    if (!consumerKey || !consumerSecret) {
      log('M-Pesa credentials not configured', 'error');
      return false;
    }
    
    // Test OAuth token generation
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const env = process.env.MPESA_ENV || 'sandbox';
    const url = env === 'production'
      ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
      : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    
    const response = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 10000,
    });
    
    if (response.data?.access_token) {
      log(`M-Pesa OAuth working (${env} mode)`, 'success');
      return true;
    } else {
      log('M-Pesa OAuth failed: No token in response', 'error');
      return false;
    }
  } catch (err) {
    log(`M-Pesa OAuth check failed: ${err.message}`, 'error');
    return false;
  }
}

async function checkDatabase() {
  log('\n' + colors.bold + 'Database Connection' + colors.reset);
  
  try {
    // Try to call a simple RPC
    const response = await axios.post(
      `${process.env.SB_URL}/rest/v1/rpc/health_check`,
      {},
      {
        headers: {
          apikey: process.env.SB_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SB_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    ).catch(() => {
      // RPC might not exist, try a simple query instead
      return axios.get(
        `${process.env.SB_URL}/rest/v1/bot_tenants?limit=1`,
        {
          headers: {
            apikey: process.env.SB_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SB_SERVICE_ROLE_KEY}`,
          },
          timeout: 10000,
        }
      );
    });
    
    if (response.status === 200) {
      log('Database connected (Supabase)', 'success');
      return true;
    }
  } catch (err) {
    log(`Database check failed: ${err.message}`, 'error');
    return false;
  }
}

async function checkKassangasTenant() {
  log('\n' + colors.bold + 'Kassangas Tenant Setup' + colors.reset);
  
  try {
    const response = await supabaseGetWithSchemaFallback("bot_tenants?client_phone=ilike.*702245555*");
    
    if (response.data && response.data.length > 0) {
      const tenant = response.data[0];
      log(`Tenant found: ${tenant.client_name}`, 'success');

      const status = String(tenant.status || '').toLowerCase();
      log(`  - Status: ${tenant.status || 'unknown'}`, status === 'active' ? 'success' : 'warn');

      // Some deployments expose only the public table, which may not include these columns.
      if (Object.prototype.hasOwnProperty.call(tenant, 'is_active')) {
        log(`  - Active flag: ${tenant.is_active ? 'Yes' : 'No'}`, tenant.is_active ? 'success' : 'warn');
      } else {
        log('  - Active flag: Not exposed in current schema view', 'info');
      }

      if (Object.prototype.hasOwnProperty.call(tenant, 'whatsapp_access_token')) {
        log(`  - Has WhatsApp token: ${tenant.whatsapp_access_token ? 'Yes' : 'No'}`,
          tenant.whatsapp_access_token ? 'success' : 'warn');
      } else {
        log('  - Has WhatsApp token: Not exposed in current schema view', 'info');
      }

      return status === 'active';
    } else {
      log('Kassangas tenant not found', 'error');
      return false;
    }
  } catch (err) {
    log(`Tenant check failed: ${err.message}`, 'error');
    return false;
  }
}

async function checkProductCatalog() {
  log('\n' + colors.bold + 'Product Catalog' + colors.reset);
  
  try {
    let count = 0;
    let sample = [];

    try {
      const response = await supabaseGetWithSchemaFallback("bot_products?is_active=eq.true&limit=10");
      count = Array.isArray(response.data) ? response.data.length : 0;
      sample = Array.isArray(response.data) ? response.data.slice(0, 3) : [];
    } catch (tableErr) {
      const token = process.env.SB_SERVICE_ROLE_KEY;
      const rpcResponse = await axios.post(
        `${process.env.SB_URL}/rest/v1/rpc/get_catalog`,
        { tenant_phone: "0702245555", q: null },
        {
          headers: {
            apikey: token,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      const items = rpcResponse.data?.items || [];
      count = items.length;
      sample = items.slice(0, 3);
    }

    if (count > 0) {
      log(`Products configured: ${count}`, 'success');
      sample.forEach(p => {
        log(`  - ${p.sku}: ${p.name} (KES ${p.price})`, 'info');
      });
      return true;
    } else {
      log('No products configured yet', 'warn');
      return false;
    }
  } catch (err) {
    log(`Product check failed: ${err.message}`, 'error');
    return false;
  }
}

async function checkPayments() {
  log('\n' + colors.bold + 'Recent Transactions' + colors.reset);
  
  try {
    const response = await supabaseGetWithSchemaFallback("subscriptions?status=in.(completed,active,paid)&order=created_at.desc&limit=5");
    
    const payments = response.data || [];
    if (payments.length > 0) {
      log(`Recent successful payments: ${payments.length}`, 'success');
      payments.forEach(p => {
        log(`  - KES ${p.amount} (${p.status}) - ${new Date(p.created_at).toLocaleDateString()}`, 'info');
      });
      return true;
    } else {
      log('No successful payments yet (expected before launch)', 'warn');
      return true;
    }
  } catch (err) {
    log(`Payment check failed: ${err.message}`, 'error');
    return false;
  }
}

async function runAllChecks() {
  console.log('\n' + colors.bold + colors.blue + '🔍 7-DAY REVENUE IMPLEMENTATION CHECKER\n' + colors.reset);
  
  const checks = [
    { name: 'Server Health', fn: checkServer },
    { name: 'Environment Variables', fn: checkEnvironment },
    { name: 'M-Pesa Configuration', fn: checkMpesaCredentials },
    { name: 'Database Connection', fn: checkDatabase },
    { name: 'Kassangas Tenant', fn: checkKassangasTenant },
    { name: 'Product Catalog', fn: checkProductCatalog },
    { name: 'Payment Processing', fn: checkPayments },
  ];
  
  const results = [];
  
  for (const check of checks) {
    try {
      const passed = await check.fn();
      results.push({ name: check.name, passed });
    } catch (err) {
      results.push({ name: check.name, passed: false, error: err.message });
    }
  }
  
  console.log('\n' + colors.bold + '📊 SUMMARY' + colors.reset);
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  results.forEach(r => {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} ${r.name}`);
  });
  
  console.log(`\n${colors.bold}Score: ${passed}/${total}${colors.reset}`);
  
  if (passed === total) {
    console.log('\n🚀 All systems ready! You can proceed with revenue generation.');
  } else {
    console.log('\n⚠️ Some checks failed. Please review above and fix before going live.');
  }
  
  console.log('\n');
}

runAllChecks().catch(err => {
  log(`Checker failed: ${err.message}`, 'error');
  process.exit(1);
});
