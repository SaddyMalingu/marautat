/**
 * Generate Product Training Data
 * ----------------------------------
 * Automatically creates context-aware training data from product portfolio
 * This script reads products from the database and generates comprehensive
 * training entries to teach the AI about inventory, pricing, and recommendations.
 * 
 * Usage:
 *   node generate_product_training.js --tenant=254700123456
 *   node generate_product_training.js --tenant-name="Kassangas Music Shop"
 *   node generate_product_training.js --all
 * 
 * Features:
 * - Product knowledge (individual items)
 * - Category expertise (guitars, keyboards, etc.)
 * - Price range awareness
 * - Budget recommendations
 * - Inventory alerts
 * - Brand expertise
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};
args.forEach(arg => {
  const [key, value] = arg.split('=');
  options[key.replace(/^--/, '')] = value || true;
});

const TENANT_PHONE = options.tenant || '254700123456';
const TENANT_NAME = options['tenant-name'] || null;
const PROCESS_ALL = options.all || false;
const DRY_RUN = options['dry-run'] || false;

/**
 * Fetch tenant by phone or name
 */
async function getTenant(phone, name) {
  let query = supabase
    .from('alphadome.bot_tenants')
    .select('*');
  
  if (phone) {
    query = query.eq('client_phone', phone);
  } else if (name) {
    query = query.ilike('client_name', `%${name}%`);
  }
  
  const { data, error } = await query.limit(1).single();
  
  if (error) {
    console.error(`❌ Tenant not found:`, error.message);
    return null;
  }
  
  return data;
}

/**
 * Fetch all products for a tenant
 */
async function getProducts(tenantId) {
  const { data, error } = await supabase
    .from('alphadome.bot_products')
    .select('*')
    .eq('bot_tenant_id', tenantId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  
  if (error) {
    console.error(`❌ Error fetching products:`, error.message);
    return [];
  }
  
  return data || [];
}

/**
 * Generate product knowledge entries
 */
function generateProductKnowledge(tenant, products) {
  const entries = [];
  
  for (const product of products) {
    const description = product.description || '';
    const stockStatus = product.stock_count > 10 
      ? 'In stock with good availability.'
      : product.stock_count > 0 
        ? `Limited stock available (${product.stock_count} units).`
        : 'Currently out of stock - ask customer to check back or call for updates.';
    
    const answer = description
      ? `${product.name} (${product.sku}): ${description} Priced at ${product.price} ${product.currency}. ${stockStatus}`
      : `${product.name} (${product.sku}) is available at ${product.price} ${product.currency}.`;
    
    entries.push({
      bot_tenant_id: tenant.id,
      data_type: 'product_knowledge',
      question: `Tell me about the ${product.name}`,
      answer,
      category: 'products',
      priority: 85,
      confidence_score: 0.95,
      is_active: true
    });
  }
  
  return entries;
}

/**
 * Generate category expertise entries
 */
function generateCategoryExpertise(tenant, products) {
  const entries = [];
  const categories = {};
  
  // Group products by category
  for (const product of products) {
    const category = product.metadata?.category || 
                    (product.name.toLowerCase().includes('guitar') ? 'guitars' : null) ||
                    (product.name.toLowerCase().includes('keyboard') ? 'keyboards' : null) ||
                    (product.name.toLowerCase().includes('mic') ? 'microphones' : null) ||
                    'accessories';
    
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(product);
  }
  
  // Generate entries for each category
  for (const [category, items] of Object.entries(categories)) {
    if (items.length === 0) continue;
    
    const productList = items
      .map(p => `${p.name} (${p.price} ${p.currency})`)
      .join(', ');
    
    let question, answer;
    
    switch (category) {
      case 'guitars':
        question = 'What guitars do you have?';
        answer = `We have a great selection of guitars: ${productList}. All guitars come with quality assurance. Would you like details on any specific model?`;
        break;
      case 'keyboards':
        question = 'Do you sell keyboards or pianos?';
        answer = `Yes! We stock keyboards and digital pianos: ${productList}. Perfect for both beginners and professionals. Need more details?`;
        break;
      case 'microphones':
        question = 'What microphones do you have?';
        answer = `Our microphone selection includes: ${productList}. Great for studios, live performances, and home recording.`;
        break;
      case 'accessories':
        question = 'What accessories do you have?';
        answer = `We carry essential accessories including: ${productList}. These are essential for maintaining and protecting your instruments.`;
        break;
      default:
        question = `What ${category} do you have?`;
        answer = `Our ${category} selection includes: ${productList}. Let me know if you need more details!`;
    }
    
    entries.push({
      bot_tenant_id: tenant.id,
      data_type: 'category_knowledge',
      question,
      answer,
      category: 'products',
      priority: 90,
      confidence_score: 0.98,
      is_active: true
    });
  }
  
  return entries;
}

/**
 * Generate price range awareness
 */
function generatePriceAwareness(tenant, products) {
  const entries = [];
  const prices = products.map(p => p.price).filter(p => p > 0);
  
  if (prices.length === 0) return entries;
  
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  
  entries.push({
    bot_tenant_id: tenant.id,
    data_type: 'price_knowledge',
    question: 'What is your price range?',
    answer: `Our products range from ${minPrice} ${products[0].currency} for accessories like strings and cables, up to ${maxPrice} ${products[0].currency} for premium instruments. We have options for every budget. What's your price range?`,
    category: 'pricing',
    priority: 80,
    confidence_score: 0.92,
    is_active: true
  });
  
  return entries;
}

/**
 * Generate budget recommendations
 */
function generateBudgetRecommendations(tenant, products) {
  const entries = [];
  const currency = products[0]?.currency || 'KES';
  
  // Under 10,000
  const affordable = products.filter(p => p.price < 10000 && p.price > 0);
  if (affordable.length > 0) {
    const list = affordable
      .slice(0, 5)
      .map(p => `${p.name} (${p.price} ${currency})`)
      .join(', ');
    
    entries.push({
      bot_tenant_id: tenant.id,
      data_type: 'recommendation',
      question: 'What do you have under 10000?',
      answer: `Great starter options under 10,000 ${currency}: ${list}. These are perfect for beginners or as accessories to your setup.`,
      category: 'products',
      priority: 75,
      confidence_score: 0.90,
      is_active: true
    });
  }
  
  // 10,000 - 30,000
  const midRange = products.filter(p => p.price >= 10000 && p.price <= 30000);
  if (midRange.length > 0) {
    const list = midRange
      .slice(0, 5)
      .map(p => `${p.name} (${p.price} ${currency})`)
      .join(', ');
    
    entries.push({
      bot_tenant_id: tenant.id,
      data_type: 'recommendation',
      question: 'What do you have between 10000 and 30000?',
      answer: `Quality instruments in the 10,000-30,000 ${currency} range: ${list}. Excellent choices for intermediate players and serious hobbyists.`,
      category: 'products',
      priority: 75,
      confidence_score: 0.90,
      is_active: true
    });
  }
  
  return entries;
}

/**
 * Generate inventory awareness
 */
function generateInventoryAwareness(tenant, products) {
  const entries = [];
  const currency = products[0]?.currency || 'KES';
  
  // Popular/high-value items
  const avgPrice = products.reduce((sum, p) => sum + (p.price || 0), 0) / products.length;
  const popular = products
    .filter(p => p.price >= avgPrice * 0.8 && p.price > 0)
    .slice(0, 4);
  
  if (popular.length > 0) {
    const list = popular
      .map(p => {
        const stockStatus = p.stock_count > 5 ? 'In stock' :
                           p.stock_count > 0 ? 'Limited stock' :
                           'Available on request';
        return `${p.name} (${p.price} ${currency}) - ${stockStatus}`;
      })
      .join(', ');
    
    entries.push({
      bot_tenant_id: tenant.id,
      data_type: 'inventory',
      question: 'What are your most popular items?',
      answer: `Our best-selling instruments include: ${list}. These are customer favorites for quality and value.`,
      category: 'products',
      priority: 85,
      confidence_score: 0.93,
      is_active: true
    });
  }
  
  // Low stock alerts
  const lowStock = products.filter(p => p.stock_count > 0 && p.stock_count <= 5 && p.price > 5000);
  if (lowStock.length > 0) {
    const list = lowStock
      .map(p => `${p.name} (${p.stock_count} left)`)
      .join(', ');
    
    entries.push({
      bot_tenant_id: tenant.id,
      data_type: 'inventory_alert',
      question: 'What items are running low?',
      answer: `These popular items have limited stock: ${list}. I recommend ordering soon or calling us at ${tenant.client_phone} to reserve.`,
      category: 'inventory',
      priority: 70,
      confidence_score: 0.88,
      is_active: true
    });
  }
  
  return entries;
}

/**
 * Generate brand expertise
 */
function generateBrandExpertise(tenant, products) {
  const entries = [];
  const prices = products.map(p => p.price).filter(p => p > 0);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const currency = products[0]?.currency || 'KES';
  
  entries.push({
    bot_tenant_id: tenant.id,
    data_type: 'brand_knowledge',
    question: `Why should I buy from ${tenant.client_name}?`,
    answer: `${tenant.client_name} is your trusted source for quality products. We offer: ✓ Wide selection from ${minPrice} to ${maxPrice} ${currency} ✓ ${products.length} items in stock ✓ Expert advice ✓ Quality assurance ✓ Great customer service. Visit us or call ${tenant.client_phone}!`,
    category: 'general',
    priority: 95,
    confidence_score: 0.98,
    is_active: true
  });
  
  return entries;
}

/**
 * Delete old training data for a tenant (specific types only)
 */
async function cleanOldTraining(tenantId) {
  const dataTypes = [
    'product_knowledge',
    'category_knowledge',
    'price_knowledge',
    'recommendation',
    'inventory',
    'inventory_alert',
    'brand_knowledge'
  ];
  
  const { error } = await supabase
    .from('alphadome.bot_training_data')
    .delete()
    .eq('bot_tenant_id', tenantId)
    .in('data_type', dataTypes);
  
  if (error) {
    console.error(`❌ Error cleaning old training:`, error.message);
    return false;
  }
  
  return true;
}

/**
 * Insert training data in batches
 */
async function insertTrainingData(entries) {
  const batchSize = 50;
  let inserted = 0;
  
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const { error } = await supabase
      .from('alphadome.bot_training_data')
      .insert(batch);
    
    if (error) {
      console.error(`❌ Error inserting batch ${i / batchSize + 1}:`, error.message);
    } else {
      inserted += batch.length;
    }
  }
  
  return inserted;
}

/**
 * Main execution
 */
async function main() {
  console.log('\n🤖 Product Training Data Generator\n');
  console.log('================================\n');
  
  // Get tenant
  const tenant = await getTenant(TENANT_PHONE, TENANT_NAME);
  if (!tenant) {
    console.error('❌ No tenant found. Exiting.');
    process.exit(1);
  }
  
  console.log(`✅ Tenant: ${tenant.client_name} (${tenant.client_phone})\n`);
  
  // Get products
  const products = await getProducts(tenant.id);
  if (products.length === 0) {
    console.error('❌ No products found for this tenant. Add products first.');
    process.exit(1);
  }
  
  console.log(`✅ Found ${products.length} products\n`);
  
  // Generate training entries
  console.log('🔄 Generating training data...\n');
  
  const allEntries = [
    ...generateProductKnowledge(tenant, products),
    ...generateCategoryExpertise(tenant, products),
    ...generatePriceAwareness(tenant, products),
    ...generateBudgetRecommendations(tenant, products),
    ...generateInventoryAwareness(tenant, products),
    ...generateBrandExpertise(tenant, products)
  ];
  
  console.log(`📊 Generated ${allEntries.length} training entries:`);
  console.log(`   - ${generateProductKnowledge(tenant, products).length} product knowledge`);
  console.log(`   - ${generateCategoryExpertise(tenant, products).length} category expertise`);
  console.log(`   - ${generatePriceAwareness(tenant, products).length} price awareness`);
  console.log(`   - ${generateBudgetRecommendations(tenant, products).length} budget recommendations`);
  console.log(`   - ${generateInventoryAwareness(tenant, products).length} inventory awareness`);
  console.log(`   - ${generateBrandExpertise(tenant, products).length} brand expertise\n`);
  
  if (DRY_RUN) {
    console.log('🔍 DRY RUN - Showing sample entries:\n');
    allEntries.slice(0, 3).forEach((entry, idx) => {
      console.log(`Entry ${idx + 1}:`);
      console.log(`  Type: ${entry.data_type}`);
      console.log(`  Q: ${entry.question}`);
      console.log(`  A: ${entry.answer.substring(0, 100)}...\n`);
    });
    console.log('✅ Dry run complete. Run without --dry-run to save to database.');
    return;
  }
  
  // Clean old training data
  console.log('🧹 Cleaning old product training data...');
  const cleaned = await cleanOldTraining(tenant.id);
  if (!cleaned) {
    console.error('⚠️  Warning: Could not clean old training data. Proceeding anyway...\n');
  } else {
    console.log('✅ Old training data cleaned\n');
  }
  
  // Insert new training data
  console.log('💾 Inserting new training data...');
  const inserted = await insertTrainingData(allEntries);
  console.log(`✅ Inserted ${inserted} / ${allEntries.length} entries\n`);
  
  // Verify
  const { data: verifyData } = await supabase
    .from('alphadome.bot_training_data')
    .select('data_type')
    .eq('bot_tenant_id', tenant.id);
  
  const counts = {};
  (verifyData || []).forEach(item => {
    counts[item.data_type] = (counts[item.data_type] || 0) + 1;
  });
  
  console.log('📈 Training data summary:');
  Object.entries(counts).forEach(([type, count]) => {
    console.log(`   ${type}: ${count}`);
  });
  
  console.log('\n✅ COMPLETE! Training data has been generated.\n');
  console.log('Next steps:');
  console.log('1. Test the bot with product-related questions');
  console.log('2. Verify responses include product knowledge');
  console.log('3. Adjust priorities or confidence scores if needed\n');
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
