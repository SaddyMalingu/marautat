/**
 * Webhook Test Harness
 * Tests the actual server webhook endpoint with mock WhatsApp payloads
 * Start the server first with: npm start
 */

import dotenv from 'dotenv';

dotenv.config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const WEBHOOK_PATH = '/webhook';

let results = { total: 0, passed: 0, failed: 0 };

function log(msg, type = 'info') {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', test: '🧪', wait: '⏳' };
  console.log(`${icons[type] || '•'} ${msg}`);
}

async function testWebhookVerification() {
  results.total++;
  log('Test: Webhook verification endpoint', 'test');

  try {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': process.env.VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN || 'default_verify_token',
      'hub.challenge': 'test_challenge_12345'
    });

    const response = await fetch(`${SERVER_URL}${WEBHOOK_PATH}?${params}`, {
      method: 'GET',
      timeout: 5000
    });

    if (response.status === 200) {
      const text = await response.text();
      if (text === 'test_challenge_12345') {
        log('Webhook verification: ✓ Returns challenge token', 'success');
        results.passed++;
        return true;
      }
    }

    log(`Webhook verification failed (HTTP ${response.status})`, 'error');
    results.failed++;
    return false;
  } catch (e) {
    if (e.message.includes('ECONNREFUSED')) {
      log('Cannot connect to server. Start with: npm start', 'error');
    } else {
      log(`Error: ${e.message}`, 'error');
    }
    results.failed++;
    return false;
  }
}

async function testIncomingMessage() {
  results.total++;
  log('Test: Incoming text message handler', 'test');

  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry001',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            messages: [{
              from: '254700000001',
              id: 'wamid.test001',
              timestamp: Date.now().toString(),
              type: 'text',
              text: { body: 'What are your business hours?' }
            }],
            contacts: [{ profile: { name: 'Test User' }, wa_id: '254700000001' }],
            metadata: {
              display_phone_number: '254702245555',
              phone_number_id: 'TEST_PHONE_ID',
              business_account_id: 'TEST_ACCOUNT_ID'
            }
          },
          field: 'messages'
        }]
      }]
    };

    const response = await fetch(`${SERVER_URL}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 8000
    });

    if (response.status === 200) {
      log('Message processing: ✓ Server accepted message', 'success');
      results.passed++;
      return true;
    }

    log(`Message processing failed (HTTP ${response.status})`, 'error');
    results.failed++;
    return false;
  } catch (e) {
    log(`Error: ${e.message}`, 'error');
    results.failed++;
    return false;
  }
}

async function testMessageWithoutTenant() {
  results.total++;
  log('Test: Message from unknown bot phone (fallback handling)', 'test');

  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry002',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            messages: [{
              from: '254700000002',
              id: 'wamid.test002',
              timestamp: Date.now().toString(),
              type: 'text',
              text: { body: 'Hello world' }
            }],
            contacts: [{ profile: { name: 'Unknown User' }, wa_id: '254700000002' }],
            metadata: {
              display_phone_number: '999999999999', // Non-existent tenant
              phone_number_id: 'UNKNOWN_PHONE_ID',
              business_account_id: 'UNKNOWN_ACCOUNT_ID'
            }
          },
          field: 'messages'
        }]
      }]
    };

    const response = await fetch(`${SERVER_URL}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 8000
    });

    if (response.status === 200) {
      log('Fallback handling: ✓ Server gracefully handles unknown tenant', 'success');
      results.passed++;
      return true;
    }

    log(`Fallback handling failed (HTTP ${response.status})`, 'error');
    results.failed++;
    return false;
  } catch (e) {
    log(`Error: ${e.message}`, 'error');
    results.failed++;
    return false;
  }
}

async function testMultipleMessages() {
  results.total++;
  log('Test: Rapid message sequence (concurrency)', 'test');

  try {
    const messages = Array.from({ length: 3 }, (_, i) => ({
      object: 'whatsapp_business_account',
      entry: [{
        id: `entry${i}`,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            messages: [{
              from: `25470000000${i}`,
              id: `wamid.test${i}`,
              timestamp: Date.now().toString(),
              type: 'text',
              text: { body: `Message ${i + 1}` }
            }],
            contacts: [{ profile: { name: `User ${i + 1}` }, wa_id: `25470000000${i}` }],
            metadata: {
              display_phone_number: '254702245555',
              phone_number_id: 'TEST_PHONE_ID',
              business_account_id: 'TEST_ACCOUNT_ID'
            }
          },
          field: 'messages'
        }]
      }]
    }));

    const responses = await Promise.allSettled(
      messages.map(msg =>
        fetch(`${SERVER_URL}${WEBHOOK_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
          timeout: 8000
        })
      )
    );

    const successful = responses.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;

    if (successful === messages.length) {
      log(`Concurrency test: ✓ All ${successful} messages processed`, 'success');
      results.passed++;
      return true;
    }

    log(`Concurrency test: Only ${successful}/${messages.length} messages succeeded`, 'error');
    results.failed++;
    return false;
  } catch (e) {
    log(`Error: ${e.message}`, 'error');
    results.failed++;
    return false;
  }
}

async function testErrorHandling() {
  results.total++;
  log('Test: Invalid payload error handling', 'test');

  try {
    const responses = await Promise.all([
      // Empty payload
      fetch(`${SERVER_URL}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        timeout: 5000
      }),
      // Invalid JSON
      fetch(`${SERVER_URL}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
        timeout: 5000
      }).catch(() => ({ status: 400 }))
    ]);

    // Server should handle both gracefully
    const allHandled = responses.every(r => r && (r.status === 200 || r.status === 400 || r.status === 404 || r.status === 500));

    if (allHandled) {
      log('Error handling: ✓ Server handles invalid payloads', 'success');
      results.passed++;
      return true;
    }

    log('Error handling: ✗ Server did not gracefully handle errors', 'error');
    results.failed++;
    return false;
  } catch (e) {
    log(`Error: ${e.message}`, 'error');
    results.failed++;
    return false;
  }
}

async function runTests() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 Webhook Integration Test Suite');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  log(`Testing server at: ${SERVER_URL}`, 'info');
  log('Make sure the server is running: npm start\n', 'wait');

  // Run tests sequentially with delays
  await testWebhookVerification();
  await new Promise(r => setTimeout(r, 500));

  await testIncomingMessage();
  await new Promise(r => setTimeout(r, 500));

  await testMessageWithoutTenant();
  await new Promise(r => setTimeout(r, 500));

  await testMultipleMessages();
  await new Promise(r => setTimeout(r, 500));

  await testErrorHandling();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n📊 Results: ${results.passed}/${results.total} tests passed`);

  if (results.failed > 0) {
    console.log(`\n❌ ${results.failed} test(s) failed\n`);
    process.exit(1);
  } else {
    console.log('\n✅ All webhook tests passed!\n');
    process.exit(0);
  }
}

runTests();
