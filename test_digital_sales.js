#!/usr/bin/env node

/**
 * Test script for Kassangas Digital Sales API
 * 
 * Usage:
 *   node test_digital_sales.js              # Run all tests
 *   node test_digital_sales.js --sandbox    # Test in sandbox mode
 *   node test_digital_sales.js --check-log  # Show recent transactions
 * 
 * This script tests the provider abstraction and sales endpoints
 * WITHOUT requiring live API keys (uses sandbox mode).
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_PASS || 'your-admin-password';

const args = process.argv.slice(2);
const mode = args[0] || '--all';

// Test utilities
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test cases
async function testBuyProduct() {
  log('\n✓ TEST: Buy Digital Product', 'blue');
  
  const testCases = [
    { sku: 'SAF-DAILY-1GB', desc: 'Safaricom Daily 1GB' },
    { sku: 'ATL-DAILY-1.5GB', desc: 'Airtel Daily 1.5GB' },
    { sku: 'AIRTIME-LOAD', desc: 'Airtime Top Up' },
  ];

  for (const tc of testCases) {
    try {
      const response = await axios.post(`${BASE_URL}/api/kassangas/buy-product`, {
        phone: '254786817637',
        sku: tc.sku,
        visitor_id: 'test-visitor-001',
        merchant_code: 'TEST-MERCHANT-001',
      });

      const { success, transaction_id, product, amount_kes, status } = response.data;

      if (success) {
        log(`  ✓ ${tc.desc} - TXN: ${transaction_id} - KES ${amount_kes} - ${status}`, 'green');
      } else {
        log(`  ✗ ${tc.desc} - Error: ${response.data.message}`, 'red');
      }
    } catch (err) {
      log(`  ✗ ${tc.desc} - Network error: ${err.message}`, 'red');
    }

    await sleep(500);
  }
}

async function testSalesHistory() {
  log('\n✓ TEST: Sales History', 'blue');

  try {
    const response = await axios.get(`${BASE_URL}/api/kassangas/sales/history`, {
      params: {
        visitor_id: 'test-visitor-001',
      },
    });

    const { history } = response.data;
    log(`  Found ${history.length} transactions`, 'green');

    if (history.length > 0) {
      const latest = history[0];
      log(`  Latest: TXN ${latest.transaction_id} - ${latest.status}`, 'green');
    }
  } catch (err) {
    log(`  Error: ${err.message}`, 'red');
  }
}

async function testTransactionStatus() {
  log('\n✓ TEST: Transaction Status', 'blue');

  try {
    const response = await axios.get(
      `${BASE_URL}/api/kassangas/sales/status/TXN-123456-TEST`
    );

    const { transaction_id, status } = response.data;
    log(`  Status: ${status}`, 'green');
  } catch (err) {
    log(`  Error: ${err.message}`, 'red');
  }
}

async function testAdminDashboard() {
  log('\n✓ TEST: Admin Dashboard', 'blue');

  try {
    const response = await axios.get(
      `${BASE_URL}/admin/api/kassangas/sales-dashboard`,
      {
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      }
    );

    const { stats } = response.data;
    log(`  Mode: ${stats.mode}`, 'green');
    log(`  Provider: ${stats.active_provider}`, 'green');
    log(`  Status: ${stats.provider_status}`, 'green');
    log(`  Total Sales: ${stats.total_sales}`, 'green');
    log(`  Successful: ${stats.successful}`, 'green');
    log(`  Failed: ${stats.failed}`, 'green');
    log(`  Revenue: KES ${stats.total_revenue_kes}`, 'green');
  } catch (err) {
    log(`  Error: ${err.message}`, 'red');
  }
}

async function testProviderConfig() {
  log('\n✓ TEST: Provider Config (Read-Only)', 'blue');

  try {
    const response = await axios.post(
      `${BASE_URL}/admin/api/kassangas/provider-config`,
      {
        provider: 'reloadly',
        mode: 'sandbox',
      },
      {
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      }
    );

    log(`  Current Provider: ${response.data.current_provider}`, 'green');
    log(`  Current Mode: ${response.data.current_mode}`, 'green');
    log(`  Message: ${response.data.message}`, 'yellow');
  } catch (err) {
    log(`  Error: ${err.message}`, 'red');
  }
}

async function checkTransactionLog() {
  log('\n✓ Checking Transaction Log', 'blue');

  const logPath = path.join(__dirname, 'logs', 'digital_sales_transactions.jsonl');

  try {
    if (!fs.existsSync(logPath)) {
      log(`  Log file not found: ${logPath}`, 'yellow');
      return;
    }

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    log(`  Total transactions logged: ${lines.length}`, 'green');

    if (lines.length > 0) {
      const lastTxn = JSON.parse(lines[lines.length - 1]);
      log(`  Latest: ${lastTxn.transaction_id} - ${lastTxn.status}`, 'green');
    }

    // Show summary
    const txns = lines.map(l => JSON.parse(l));
    const successful = txns.filter(t => t.ok).length;
    const failed = txns.filter(t => !t.ok).length;

    log(`  Successful: ${successful}, Failed: ${failed}`, 'green');
  } catch (err) {
    log(`  Error reading log: ${err.message}`, 'red');
  }
}

async function runAllTests() {
  log('═══════════════════════════════════════════════════════════', 'blue');
  log('  Kassangas Digital Sales API - Test Suite', 'blue');
  log('═══════════════════════════════════════════════════════════', 'blue');

  await testBuyProduct();
  await sleep(1000);
  await testSalesHistory();
  await sleep(500);
  await testTransactionStatus();
  await sleep(500);
  await testAdminDashboard();
  await sleep(500);
  await testProviderConfig();
  await sleep(500);
  await checkTransactionLog();

  log('\n═══════════════════════════════════════════════════════════', 'blue');
  log('  Tests Complete', 'blue');
  log('═══════════════════════════════════════════════════════════', 'blue');
}

// Main
(async () => {
  try {
    if (mode === '--sandbox') {
      await testBuyProduct();
    } else if (mode === '--check-log') {
      await checkTransactionLog();
    } else if (mode === '--admin') {
      await testAdminDashboard();
    } else {
      await runAllTests();
    }
  } catch (err) {
    log(`Fatal error: ${err.message}`, 'red');
    process.exit(1);
  }
})();
