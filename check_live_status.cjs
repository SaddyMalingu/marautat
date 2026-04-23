#!/usr/bin/env node
const axios = require('axios');

const baseUrl = 'https://alphadome.onrender.com';
const key = 'myverify123';

console.log('\n' + '='.repeat(70));
console.log('🔍 LIVE RENDER DEPLOYMENT STATUS');
console.log('='.repeat(70) + '\n');

async function checkHealth() {
  try {
    console.log('📊 Health Check:');
    const res = await axios.get(`${baseUrl}/admin/health?key=${key}`, { timeout: 10000 });
    console.log(`   ✅ Server is Up`);
    console.log(`   Status: ${res.data?.status || 'ok'}`);
    return true;
  } catch (err) {
    console.log(`   ❌ Failed: ${err.message}`);
    return false;
  }
}

async function checkOpsOverview() {
  try {
    console.log('\n💰 Revenue & Outreach Metrics:');
    const res = await axios.get(`${baseUrl}/admin/ops-overview?key=${key}`, { timeout: 10000 });
    const ops = res.data;
    
    console.log(`   Revenue (KES): ${(ops.revenue_kes || 0).toLocaleString()}`);
    console.log(`   Attempts (7d): ${ops.attempts_7d || 0}`);
    console.log(`   Conversion Rate: ${ops.conversion_rate_pct || 0}%`);
    console.log(`   Incoming Messages (24h): ${ops.incoming_24h || 0}`);
    console.log(`   Hot Leads: ${ops.hot_leads_count || 0}`);
    console.log(`   Failed Payments: ${ops.failed_count || 0}`);
    console.log(`   Pending Payments: ${ops.pending_count || 0}`);
    console.log(`   COD Queue: ${ops.cod_count || 0}`);
    
    if (ops.operations && ops.operations.length > 0) {
      console.log('\n   Recent Operations:');
      ops.operations.slice(0, 3).forEach(op => console.log(`     • ${op}`));
    }
    
    return ops;
  } catch (err) {
    console.log(`   ❌ Failed: ${err.message}`);
    if (err.response?.data) {
      console.log(`   Response: ${JSON.stringify(err.response.data).substring(0, 200)}`);
    }
    return null;
  }
}

async function checkPerformanceReport() {
  try {
    console.log('\n📈 Performance Report (Daily):');
    const res = await axios.get(`${baseUrl}/admin/performance-report?key=${key}&period=daily`, { timeout: 10000 });
    const report = res.data;
    const summary = report.summary || {};
    
    console.log(`   Band: ${report.performance_band || 'unknown'}`);
    console.log(`   Revenue: KES ${(summary.revenue_kes || 0).toLocaleString()}`);
    console.log(`   Conversion: ${summary.conversion_rate_pct || 0}%`);
    console.log(`   Hot Leads: ${summary.hot_leads_count || 0}`);
    
    if (report.action_plan && report.action_plan.length > 0) {
      console.log('\n   Action Plan (top 3):');
      report.action_plan.slice(0, 3).forEach(action => console.log(`     ▪ ${action}`));
    }
    
    return report;
  } catch (err) {
    console.log(`   ❌ Failed: ${err.message}`);
    return null;
  }
}

async function checkHotLeads() {
  try {
    console.log('\n🔥 Hot Leads Details:');
    const res = await axios.get(`${baseUrl}/admin/ops-overview?key=${key}`, { timeout: 10000 });
    const ops = res.data;
    
    if (ops.hot_leads && ops.hot_leads.length > 0) {
      console.log(`   Found ${ops.hot_leads.length} hot leads:`);
      ops.hot_leads.slice(0, 5).forEach(lead => {
        console.log(`     • Phone: ${lead.phone || 'unknown'} | Status: ${lead.status} | Action: ${lead.action_hint}`);
      });
    } else {
      console.log(`   ℹ️  No hot leads (expected - campaigns not sent yet)`);
    }
  } catch (err) {
    console.log(`   ❌ Failed: ${err.message}`);
  }
}

async function run() {
  await checkHealth();
  const ops = await checkOpsOverview();
  await checkPerformanceReport();
  await checkHotLeads();
  
  console.log('\n' + '='.repeat(70));
  if (ops && ops.revenue_kes === 0) {
    console.log('\n⚠️  REVENUE STATUS: Zero revenue so far');
    console.log('   Why? Campaigns haven\'t been sent yet');
    console.log('\n✅ NEXT STEP: Launch first outreach campaign!');
    console.log('   Command: npm run campaign:send -- --to 254712345678 --template kenya --lang en');
  }
  console.log('='.repeat(70) + '\n');
}

run();
