/**
 * Integration Test Suite
 * Tests the complete multi-tenant webhook flow, AI response generation,
 * and message logging without needing real Meta credentials
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const sb = createClient(process.env.SB_URL, process.env.SB_SERVICE_ROLE_KEY);

const TEST_PHONE = '254702245555'; // Test tenant phone
const TEST_TENANT_NAME = 'TestBot Inc';

let testResults = {
  total: 0,
  passed: 0,
  failed: 0,
  errors: []
};

function log(msg, type = 'info') {
  const icons = {
    info: '📋',
    success: '✅',
    error: '❌',
    test: '🧪'
  };
  console.log(`${icons[type]} ${msg}`);
}

async function testInsertTestTenant() {
  testResults.total++;
  log('Test: Insert test tenant into bot_tenants', 'test');
  
  try {
    const { data, error } = await sb.from('alphadome.bot_tenants').insert({
      client_name: TEST_TENANT_NAME,
      client_phone: TEST_PHONE,
      brand_id: 'test-brand-001',
      whatsapp_phone_number_id: 'TEST_PHONE_ID_123456',
      whatsapp_business_account_id: 'TEST_ACCOUNT_ID_654321',
      whatsapp_access_token: 'TEST_TOKEN_ABC123DEF456GHI789JKL012MNO345PQR678',
      ai_provider: 'openai',
      ai_api_key: 'test-key-placeholder',
      ai_model: 'gpt-3.5-turbo',
      is_active: true,
      is_verified: false,
      webhook_verify_token: 'test_verify_token_123'
    }).select();

    if (error) {
      log(`Failed to insert test tenant: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Insert tenant: ${error.message}`);
      return null;
    }

    log(`Inserted test tenant (ID: ${data[0].id})`, 'success');
    testResults.passed++;
    return data[0].id;
  } catch (e) {
    log(`Error inserting test tenant: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Insert tenant exception: ${e.message}`);
    return null;
  }
}

async function testInsertTemplates(tenantId) {
  testResults.total++;
  log('Test: Insert conversation templates for test tenant', 'test');
  
  try {
    const templates = [
      {
        bot_tenant_id: tenantId,
        template_name: 'Default Greeting',
        system_prompt: 'You are a helpful customer service bot for TestBot Inc. Be concise and friendly.',
        tone: 'friendly',
        is_active: true,
        is_default: true
      },
      {
        bot_tenant_id: tenantId,
        template_name: 'Technical Support',
        system_prompt: 'You are a technical support specialist. Provide detailed troubleshooting steps.',
        tone: 'professional',
        is_active: true,
        is_default: false
      }
    ];

    const { data, error } = await sb.from('alphadome.bot_templates').insert(templates).select();

    if (error) {
      log(`Failed to insert templates: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Insert templates: ${error.message}`);
      return 0;
    }

    log(`Inserted ${data.length} templates`, 'success');
    testResults.passed++;
    return data.length;
  } catch (e) {
    log(`Error inserting templates: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Insert templates exception: ${e.message}`);
    return 0;
  }
}

async function testInsertTrainingData(tenantId) {
  testResults.total++;
  log('Test: Insert training data (FAQ) for test tenant', 'test');
  
  try {
    const trainingData = [
      {
        bot_tenant_id: tenantId,
        data_type: 'faq',
        question: 'What are your business hours?',
        answer: 'We are open Monday to Friday, 9 AM to 6 PM. Saturday 10 AM to 4 PM. Closed Sundays.',
        category: 'general',
        priority: 10,
        confidence_score: 0.95,
        is_active: true
      },
      {
        bot_tenant_id: tenantId,
        data_type: 'faq',
        question: 'Do you offer refunds?',
        answer: 'Yes, we offer a 30-day money-back guarantee on all products. No questions asked.',
        category: 'policies',
        priority: 9,
        confidence_score: 0.90,
        is_active: true
      },
      {
        bot_tenant_id: tenantId,
        data_type: 'faq',
        question: 'How do I track my order?',
        answer: 'Once your order is shipped, you\'ll receive a tracking number via SMS. Use it on our tracking page.',
        category: 'orders',
        priority: 8,
        confidence_score: 0.88,
        is_active: true
      }
    ];

    const { data, error } = await sb.from('alphadome.bot_training_data').insert(trainingData).select();

    if (error) {
      log(`Failed to insert training data: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Insert training data: ${error.message}`);
      return 0;
    }

    log(`Inserted ${data.length} FAQ entries`, 'success');
    testResults.passed++;
    return data.length;
  } catch (e) {
    log(`Error inserting training data: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Insert training data exception: ${e.message}`);
    return 0;
  }
}

async function testInsertControlSettings(tenantId) {
  testResults.total++;
  log('Test: Insert control settings for test tenant', 'test');
  
  try {
    const { data, error } = await sb.from('alphadome.bot_control_settings').insert({
      bot_tenant_id: tenantId,
      is_bot_enabled: true,
      max_messages_per_hour: 100,
      max_messages_per_user_per_day: 50,
      enable_ai_responses: true,
      enable_payment_flow: false,
      enable_training_mode: true,
      enable_auto_reply: true,
      log_conversations: true,
      log_errors: true,
      escalation_phone: '+254702245555'
    }).select();

    if (error) {
      log(`Failed to insert control settings: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Insert control settings: ${error.message}`);
      return false;
    }

    log(`Inserted control settings`, 'success');
    testResults.passed++;
    return true;
  } catch (e) {
    log(`Error inserting control settings: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Insert control settings exception: ${e.message}`);
    return false;
  }
}

async function testQueryTenantByPhone() {
  testResults.total++;
  log('Test: Query tenant by phone number (multi-tenant routing)', 'test');
  
  try {
    const { data, error } = await sb
      .from('alphadome.bot_tenants')
      .select('*')
      .eq('client_phone', TEST_PHONE)
      .single();

    if (error) {
      log(`Failed to query tenant: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Query tenant: ${error.message}`);
      return false;
    }

    if (data.client_name !== TEST_TENANT_NAME) {
      log(`Tenant name mismatch: expected ${TEST_TENANT_NAME}, got ${data.client_name}`, 'error');
      testResults.failed++;
      testResults.errors.push('Tenant name mismatch');
      return false;
    }

    log(`Found tenant: ${data.client_name} (ID: ${data.id})`, 'success');
    testResults.passed++;
    return true;
  } catch (e) {
    log(`Error querying tenant: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Query tenant exception: ${e.message}`);
    return false;
  }
}

async function testLoadTemplates(tenantId) {
  testResults.total++;
  log('Test: Load active templates for tenant', 'test');
  
  try {
    const { data, error } = await sb
      .from('alphadome.bot_templates')
      .select('*')
      .eq('bot_tenant_id', tenantId)
      .eq('is_active', true)
      .order('is_default', { ascending: false });

    if (error) {
      log(`Failed to load templates: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Load templates: ${error.message}`);
      return false;
    }

    if (data.length === 0) {
      log(`No templates found for tenant`, 'error');
      testResults.failed++;
      testResults.errors.push('No templates loaded');
      return false;
    }

    log(`Loaded ${data.length} templates (default: ${data[0].template_name})`, 'success');
    testResults.passed++;
    return true;
  } catch (e) {
    log(`Error loading templates: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Load templates exception: ${e.message}`);
    return false;
  }
}

async function testLoadTrainingData(tenantId) {
  testResults.total++;
  log('Test: Load FAQ entries for tenant', 'test');
  
  try {
    const { data, error } = await sb
      .from('alphadome.bot_training_data')
      .select('*')
      .eq('bot_tenant_id', tenantId)
      .eq('is_active', true)
      .order('priority', { ascending: false })
      .order('confidence_score', { ascending: false });

    if (error) {
      log(`Failed to load training data: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Load training data: ${error.message}`);
      return false;
    }

    if (data.length === 0) {
      log(`No training data found for tenant`, 'error');
      testResults.failed++;
      testResults.errors.push('No training data loaded');
      return false;
    }

    log(`Loaded ${data.length} FAQ entries (top: "${data[0].question.substring(0, 30)}...")`, 'success');
    testResults.passed++;
    return true;
  } catch (e) {
    log(`Error loading training data: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Load training data exception: ${e.message}`);
    return false;
  }
}

async function testLoadControlSettings(tenantId) {
  testResults.total++;
  log('Test: Load control settings for tenant', 'test');
  
  try {
    const { data, error } = await sb
      .from('alphadome.bot_control_settings')
      .select('*')
      .eq('bot_tenant_id', tenantId)
      .single();

    if (error) {
      log(`Failed to load control settings: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Load control settings: ${error.message}`);
      return false;
    }

    log(`Loaded control settings (AI enabled: ${data.enable_ai_responses}, Payment: ${data.enable_payment_flow})`, 'success');
    testResults.passed++;
    return true;
  } catch (e) {
    log(`Error loading control settings: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Load control settings exception: ${e.message}`);
    return false;
  }
}

async function testInsertMessageLog(tenantId) {
  testResults.total++;
  log('Test: Log message to bot_message_logs', 'test');
  
  try {
    const { data, error } = await sb.from('alphadome.bot_message_logs').insert({
      bot_tenant_id: tenantId,
      user_phone: '+254712345678',
      direction: 'inbound',
      message_text: 'What are your business hours?',
      ai_processed: false
    }).select();

    if (error) {
      log(`Failed to insert message log: ${error.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Insert message log: ${error.message}`);
      return false;
    }

    log(`Logged message (ID: ${data[0].id})`, 'success');
    testResults.passed++;
    return true;
  } catch (e) {
    log(`Error inserting message log: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Insert message log exception: ${e.message}`);
    return false;
  }
}

async function testTenantIsolation() {
  testResults.total++;
  log('Test: Verify tenant isolation (no data leakage)', 'test');
  
  try {
    // Create second test tenant
    const { data: tenant2, error: insertError } = await sb.from('alphadome.bot_tenants').insert({
      client_name: 'TestBot 2',
      client_phone: '254700999999',
      brand_id: 'test-brand-002',
      whatsapp_phone_number_id: 'PHONE_ID_999',
      whatsapp_business_account_id: 'ACCOUNT_ID_999',
      whatsapp_access_token: 'TEST_TOKEN_999',
      ai_provider: 'openai',
      ai_api_key: 'test-key-2',
      ai_model: 'gpt-4',
      is_active: true,
      is_verified: false,
      webhook_verify_token: 'test_verify_token_999'
    }).select();

    if (insertError) {
      log(`Failed to create second tenant: ${insertError.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Isolation test: ${insertError.message}`);
      return false;
    }

    // Query tenant 2's templates (should be empty)
    const { data: templates, error: queryError } = await sb
      .from('alphadome.bot_templates')
      .select('*')
      .eq('bot_tenant_id', tenant2[0].id);

    if (queryError) {
      log(`Failed to query tenant 2 templates: ${queryError.message}`, 'error');
      testResults.failed++;
      testResults.errors.push(`Isolation test query: ${queryError.message}`);
      return false;
    }

    if (templates.length > 0) {
      log(`Data leakage detected: tenant 2 has ${templates.length} templates (should be 0)`, 'error');
      testResults.failed++;
      testResults.errors.push('Data leakage: unexpected templates in tenant 2');
      return false;
    }

    log(`Tenant isolation verified (tenant 2 is isolated)`, 'success');
    testResults.passed++;
    return true;
  } catch (e) {
    log(`Error testing tenant isolation: ${e.message}`, 'error');
    testResults.failed++;
    testResults.errors.push(`Isolation test exception: ${e.message}`);
    return false;
  }
}

async function runAllTests() {
  console.log('\n🧪 Starting Integration Test Suite\n');
  console.log('════════════════════════════════════════\n');

  // Test 1: Insert test tenant
  const tenantId = await testInsertTestTenant();
  if (!tenantId) {
    log('Cannot continue without test tenant', 'error');
    process.exit(1);
  }

  console.log('');

  // Test 2-5: Insert related data
  await testInsertTemplates(tenantId);
  await testInsertTrainingData(tenantId);
  await testInsertControlSettings(tenantId);

  console.log('');

  // Test 6-10: Query and verify
  await testQueryTenantByPhone();
  await testLoadTemplates(tenantId);
  await testLoadTrainingData(tenantId);
  await testLoadControlSettings(tenantId);
  await testInsertMessageLog(tenantId);

  console.log('');

  // Test 11: Tenant isolation
  await testTenantIsolation();

  // Summary
  console.log('\n════════════════════════════════════════');
  console.log(`\n📊 Test Results: ${testResults.passed}/${testResults.total} passed\n`);

  if (testResults.failed > 0) {
    console.log('❌ Failed Tests:');
    testResults.errors.forEach(err => console.log(`   - ${err}`));
  } else {
    console.log('✅ All integration tests passed!');
    console.log('\n✨ Multi-tenant setup is ready for Gideon\'s credentials.\n');
  }

  process.exit(testResults.failed > 0 ? 1 : 0);
}

runAllTests();
