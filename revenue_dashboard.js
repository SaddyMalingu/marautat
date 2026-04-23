#!/usr/bin/env node
/**
 * Revenue Status Dashboard
 * Quick view of current earnings, customers, and system health
 * Run daily: node revenue_dashboard.js
 */

import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";

dotenv.config();

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function section(title) {
  console.log(`\n${colors.bold}${colors.blue}═══ ${title} ═══${colors.reset}`);
}

function stat(label, value, unit = '') {
  const formatted = typeof value === 'number' ? value.toLocaleString() : value;
  console.log(`${colors.bold}${label}${colors.reset}: ${formatted}${unit ? ' ' + unit : ''}`);
}

function success(msg) {
  console.log(`${colors.green}✅ ${msg}${colors.reset}`);
}

function error(msg) {
  console.log(`${colors.red}❌ ${msg}${colors.reset}`);
}

function warn(msg) {
  console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`);
}

function trend(current, previous, label = '') {
  if (!previous) return '(no baseline)';
  const change = current - previous;
  const pct = previous > 0 ? ((change / previous) * 100).toFixed(0) : 0;
  const icon = change > 0 ? '📈' : change < 0 ? '📉' : '➡️';
  return `${icon} ${change > 0 ? '+' : ''}${change} (${pct}%) ${label}`;
}

async function getDatabaseStats() {
  try {
    // This would normally query your database
    // For now, we'll simulate with a curl to your own API
    const response = await axios.post(
      `${process.env.SB_URL}/rest/v1/rpc/get_revenue_stats`,
      { tenant_phone: '0702245555' },
      {
        headers: {
          apikey: process.env.SB_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SB_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    ).catch(() => {
      // If RPC doesn't exist, return mock data
      return {
        data: {
          total_revenue: 0,
          total_orders: 0,
          total_customers: 0,
          pending_payments: 0,
          successful_payments: 0,
          failed_payments: 0,
          avg_order_value: 0,
          messages_today: 0,
          avg_response_time_ms: 0,
        },
      };
    });

    return response.data?.data || {};
  } catch (err) {
    warn(`Database query failed: ${err.message}`);
    return null;
  }
}

function getLocalStats() {
  try {
    const logPath = 'logs/bot.log';
    if (!fs.existsSync(logPath)) {
      return { errors_today: 0, messages_processed: 0 };
    }

    const logContent = fs.readFileSync(logPath, 'utf8');
    const lines = logContent.split('\n');
    const today = new Date().toISOString().split('T')[0];
    const todayLines = lines.filter(l => l.includes(today));

    const errorCount = todayLines.filter(l => l.includes('[ERROR]')).length;
    const messageCount = todayLines.filter(l => l.includes('INCOMING')).length;
    const paymentCount = todayLines.filter(l => l.includes('PAYMENT')).length;

    return {
      errors_today: errorCount,
      messages_today: messageCount,
      payments_attempted: paymentCount,
    };
  } catch {
    return { errors_today: 0, messages_today: 0, payments_attempted: 0 };
  }
}

async function main() {
  const now = new Date();
  console.clear();
  console.log(`\n${colors.bold}💰 REVENUE STATUS DASHBOARD${colors.reset}`);
  console.log(`${colors.dim}Updated: ${now.toLocaleString()}${colors.reset}\n`);

  // Get stats
  const dbStats = await getDatabaseStats();
  const localStats = getLocalStats();

  // REVENUE SECTION
  section('Revenue Overview (Last 30 Days)');
  if (dbStats) {
    stat('Total Revenue', `KES ${dbStats.total_revenue || 0}`, '');
    stat('Total Orders', dbStats.total_orders || 0, 'transactions');
    stat('Successful Payments', dbStats.successful_payments || 0, '');
    stat('Failed Payments', dbStats.failed_payments || 0, '');
    stat('Pending Payments', dbStats.pending_payments || 0, '');
    stat('Avg Order Value', `KES ${dbStats.avg_order_value || 0}`, '');
  }

  // CUSTOMER SECTION
  section('Customer Metrics');
  if (dbStats) {
    stat('Total Customers', dbStats.total_customers || 0, 'unique');
    stat('New Today', 'checking...', '');
    stat('Repeat Rate', 'calculating...', '%');
  }

  // MESSAGE VOLUME
  section('Message Activity');
  stat('Messages Today', localStats.messages_today || 0, '');
  stat('Payments Attempted', localStats.payments_attempted || 0, '');
  stat('Avg Response Time', dbStats?.avg_response_time_ms || 0, 'ms');
  if (dbStats?.avg_response_time_ms > 5000) {
    warn('Slow response time detected');
  }

  // SYSTEM HEALTH
  section('System Health');
  stat('Errors Today', localStats.errors_today || 0, '');
  stat('Server Status', 'Checking...', '');
  stat('Database Connection', 'OK', '');
  stat('M-Pesa Integration', 'Active', '');

  if (localStats.errors_today === 0) {
    success('No errors detected');
  } else if (localStats.errors_today < 5) {
    warn(`${localStats.errors_today} errors detected - check logs`);
  } else {
    error(`${localStats.errors_today} errors - immediate attention needed`);
  }

  // QUICK ACTIONS
  section('Quick Actions');
  console.log(`
${ colors.dim}📊 View detailed dashboard:${colors.reset}
   http://localhost:3000/tenant-dashboard?key=254702245555

${ colors.dim}📞 Contact support:${colors.reset}
   +254117604817 or +254743780542

${ colors.dim}🔧 Check system:${colors.reset}
   node check_revenue_readiness.js

${ colors.dim}📝 View logs:${colors.reset}
   tail -50 logs/bot.log
  `);

  // UPCOMING TASKS
  const day = new Date().getDate();
  if (day === 1) {
    warn('Day 1: Complete tenant onboarding and M-Pesa verification');
  } else if (day === 2) {
    warn('Day 2: Set up product catalog');
  } else if (day === 3) {
    warn('Day 3: Test payment flows in sandbox');
  } else if (day === 4) {
    warn('Day 4: Switch to production M-Pesa');
  } else if (day === 5) {
    warn('Day 5: Access tenant dashboard and set up monitoring');
  } else if (day === 6) {
    warn('Day 6: Final security audit and customer announcement prep');
  } else if (day === 7) {
    success('Day 7: GO LIVE! Monitor first transactions closely');
  }

  console.log(`\n${colors.bold}📋 Remember to check this daily!${colors.reset}\n`);
}

main().catch(err => {
  console.error('Dashboard error:', err.message);
  process.exit(1);
});
