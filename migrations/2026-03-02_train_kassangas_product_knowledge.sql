-- ============================================================================
-- MIGRATION: Train Kassangas AI with Product Portfolio Knowledge
-- Date: 2026-03-02
-- Purpose: Generate context-aware training data from Kassangas product catalog
-- ============================================================================
-- This migration creates comprehensive training data that teaches the AI about:
-- • Individual product features and specifications
-- • Product categories and collections
-- • Price ranges and value propositions
-- • Inventory status and availability
-- • Product recommendations and comparisons
-- • Brand expertise in musical instruments
-- ============================================================================

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS alphadome;

-- ============================================================================
-- STEP 1: Product Knowledge - Individual Products
-- ============================================================================
-- Train the AI about each specific product in the portfolio

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  bt.id as bot_tenant_id,
  'product_knowledge',
  'Tell me about the ' || p.name,
  CASE 
    WHEN p.description IS NOT NULL AND p.description != '' THEN
      p.name || ' (' || p.sku || '): ' || p.description || 
      ' Priced at ' || p.price || ' ' || p.currency || '. ' ||
      CASE 
        WHEN p.stock_count > 10 THEN 'In stock with good availability.'
        WHEN p.stock_count > 0 THEN 'Limited stock available (' || p.stock_count || ' units).'
        ELSE 'Currently out of stock - ask customer to check back or call for updates.'
      END
    ELSE
      p.name || ' (' || p.sku || ') is available at ' || p.price || ' ' || p.currency || '.'
  END as answer,
  'products',
  85,
  0.95,
  true
FROM alphadome.bot_tenants bt
JOIN alphadome.bot_products p ON p.bot_tenant_id = bt.id
WHERE bt.client_phone = '254700123456'
  AND p.is_active = true
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 2: Category Expertise - Guitars
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'category_knowledge',
  'What guitars do you have?',
  'We have a great selection of guitars: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES)',
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND (p.metadata->>'category' = 'guitars' 
           OR p.name ILIKE '%guitar%'
           OR p.sku LIKE '%GTR%')
      AND p.is_active = true
  ) || '. All guitars come with quality assurance. Would you like details on any specific model?',
  'products',
  90,
  0.98,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
  AND EXISTS (
    SELECT 1 FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND (p.metadata->>'category' = 'guitars' OR p.name ILIKE '%guitar%')
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 3: Category Expertise - Keyboards
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'category_knowledge',
  'Do you sell keyboards or pianos?',
  'Yes! We stock keyboards and digital pianos: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES)',
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND (p.metadata->>'category' = 'keyboards' 
           OR p.name ILIKE '%keyboard%'
           OR p.name ILIKE '%piano%'
           OR p.sku LIKE '%KBD%')
      AND p.is_active = true
  ) || '. Perfect for both beginners and professionals. Need more details?',
  'products',
  90,
  0.98,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
  AND EXISTS (
    SELECT 1 FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND (p.metadata->>'category' = 'keyboards' OR p.name ILIKE '%keyboard%')
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 4: Category Expertise - Accessories
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'category_knowledge',
  'What accessories do you have?',
  'We carry essential accessories including: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES)',
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND (p.metadata->>'category' = 'accessories' 
           OR p.metadata->>'tags' LIKE '%accessory%'
           OR p.name ILIKE '%string%'
           OR p.name ILIKE '%case%'
           OR p.name ILIKE '%cable%')
      AND p.is_active = true
  ) || '. These are essential for maintaining and protecting your instruments.',
  'products',
  85,
  0.95,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
  AND EXISTS (
    SELECT 1 FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND (p.metadata->>'category' = 'accessories')
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 5: Category Expertise - Audio Equipment
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'category_knowledge',
  'What audio equipment do you have?',
  'Our audio equipment selection includes: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES)',
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND (p.metadata->>'category' IN ('microphones', 'amplifiers', 'mixers', 'audio')
           OR p.name ILIKE '%mic%'
           OR p.name ILIKE '%amp%'
           OR p.name ILIKE '%speaker%')
      AND p.is_active = true
  ) || '. Perfect for studios, live performances, and home practice.',
  'products',
  85,
  0.95,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
  AND EXISTS (
    SELECT 1 FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND (p.metadata->>'category' IN ('microphones', 'amplifiers', 'audio'))
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 6: Price Range Awareness
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'price_knowledge',
  'What is your price range?',
  'Our products range from ' || 
  (SELECT MIN(price) FROM alphadome.bot_products WHERE bot_tenant_id = alphadome.bot_tenants.id AND is_active = true AND price > 0) || 
  ' KES for accessories like strings and cables, up to ' ||
  (SELECT MAX(price) FROM alphadome.bot_products WHERE bot_tenant_id = alphadome.bot_tenants.id AND is_active = true) ||
  ' KES for premium instruments like keyboards and professional equipment. We have options for every budget. What''s your price range?',
  'pricing',
  80,
  0.92,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 7: Budget Recommendations - Entry Level
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'recommendation',
  'What do you have under 10000 KES?',
  'Great starter options under 10,000 KES: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES)',
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND p.price < 10000
      AND p.is_active = true
    ORDER BY p.price DESC
    LIMIT 5
  ) || '. These are perfect for beginners or as accessories to your setup.',
  'products',
  75,
  0.90,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
  AND EXISTS (
    SELECT 1 FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id AND p.price < 10000
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 8: Budget Recommendations - Mid Range
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'recommendation',
  'What do you have between 10000 and 30000 KES?',
  'Quality instruments in the 10,000-30,000 KES range: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES)',
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND p.price BETWEEN 10000 AND 30000
      AND p.is_active = true
    ORDER BY p.price
    LIMIT 5
  ) || '. Excellent choices for intermediate players and serious hobbyists.',
  'products',
  75,
  0.90,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
  AND EXISTS (
    SELECT 1 FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id AND p.price BETWEEN 10000 AND 30000
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 9: Inventory Awareness - Popular Items
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'inventory',
  'What are your most popular items?',
  'Our best-selling instruments include: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES) - ' ||
      CASE 
        WHEN p.stock_count > 5 THEN 'In stock'
        WHEN p.stock_count > 0 THEN 'Limited stock'
        ELSE 'Available on request'
      END,
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND p.is_active = true
      AND p.price >= (
        SELECT AVG(price) * 0.8 
        FROM alphadome.bot_products 
        WHERE bot_tenant_id = p.bot_tenant_id AND price > 0
      )
    ORDER BY p.price DESC
    LIMIT 4
  ) || '. These are customer favorites for quality and value.',
  'products',
  85,
  0.93,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 10: Quick Access Items - Low Stock Alert
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  bt.id,
  'inventory_alert',
  'What items are running low?',
  CASE 
    WHEN COUNT(*) > 0 THEN
      'These popular items have limited stock: ' ||
      string_agg(
        p.name || ' (' || p.stock_count || ' left)',
        ', '
      ) ||
      '. I recommend ordering soon or calling us at ' || bt.client_phone || ' to reserve.'
    ELSE
      'All our current items are well-stocked!'
  END as answer,
  'inventory',
  70,
  0.88,
  true
FROM alphadome.bot_tenants bt
JOIN alphadome.bot_products p ON p.bot_tenant_id = bt.id
WHERE bt.client_phone = '254700123456'
  AND p.is_active = true
  AND p.stock_count > 0
  AND p.stock_count <= 5
  AND p.price > 5000
GROUP BY bt.id, bt.client_phone
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 11: Beginner Recommendations
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'recommendation',
  'I''m a beginner, what do you recommend?',
  'Perfect! For beginners, I recommend: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES) - Great starter option',
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND p.is_active = true
      AND (
        p.description ILIKE '%beginner%'
        OR p.description ILIKE '%starter%'
        OR p.metadata->>'tags' LIKE '%beginner%'
        OR p.price < (
          SELECT AVG(price) * 0.7
          FROM alphadome.bot_products
          WHERE bot_tenant_id = p.bot_tenant_id AND price > 1000
        )
      )
    ORDER BY p.price
    LIMIT 3
  ) || '. We can also recommend accessories to get you started!',
  'products',
  90,
  0.95,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 12: Professional Equipment
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'recommendation',
  'What professional equipment do you have?',
  'Our professional-grade instruments include: ' || 
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES)',
      ', '
    )
    FROM alphadome.bot_products p
    WHERE p.bot_tenant_id = alphadome.bot_tenants.id
      AND p.is_active = true
      AND p.price > (
        SELECT AVG(price) * 1.5
        FROM alphadome.bot_products
        WHERE bot_tenant_id = p.bot_tenant_id AND price > 0
      )
    ORDER BY p.price DESC
    LIMIT 4
  ) || '. These offer exceptional quality for serious musicians and professionals.',
  'products',
  85,
  0.93,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 13: Brand Expertise & Value Proposition
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  id,
  'brand_knowledge',
  'Why should I buy from Kassangas?',
  'Kassangas Music Shop is Nairobi''s trusted source for quality musical instruments. We offer: ✓ Wide selection from ' || 
  (SELECT MIN(price) FROM alphadome.bot_products WHERE bot_tenant_id = alphadome.bot_tenants.id AND price > 0) || 
  ' to ' ||
  (SELECT MAX(price) FROM alphadome.bot_products WHERE bot_tenant_id = alphadome.bot_tenants.id) ||
  ' KES ✓ ' ||
  (SELECT COUNT(*) FROM alphadome.bot_products WHERE bot_tenant_id = alphadome.bot_tenants.id AND is_active = true) ||
  ' instruments in stock ✓ Expert advice ✓ Quality assurance ✓ Repair services ✓ Flexible payment options. Visit us or call ' || client_phone || '!',
  'general',
  95,
  0.98,
  true
FROM alphadome.bot_tenants
WHERE client_phone = '254700123456'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 14: Collection Awareness - Featured Items
-- ============================================================================

INSERT INTO alphadome.bot_training_data (
  bot_tenant_id,
  data_type,
  question,
  answer,
  category,
  priority,
  confidence_score,
  is_active
)
SELECT
  bt.id,
  'collection',
  'What are your featured products?',
  'Check out our featured collection: ' ||
  (
    SELECT string_agg(
      p.name || ' (' || p.price || ' KES)',
      ', '
    )
    FROM alphadome.bot_products p
    JOIN alphadome.bot_collection_items ci ON ci.product_id = p.id
    JOIN alphadome.bot_collections c ON c.id = ci.collection_id
    WHERE p.bot_tenant_id = bt.id
      AND c.name = 'Featured'
      AND p.is_active = true
    ORDER BY ci.sort_order
  ) || '. These are our top picks for quality and value!',
  'products',
  90,
  0.95,
  true
FROM alphadome.bot_tenants bt
WHERE bt.client_phone = '254700123456'
  AND EXISTS (
    SELECT 1 FROM alphadome.bot_collections c
    WHERE c.bot_tenant_id = bt.id AND c.name = 'Featured'
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- VERIFICATION & TESTING
-- ============================================================================

-- Count training entries created
SELECT 
  'Training Data Created' as check_name,
  data_type,
  category,
  COUNT(*) as count
FROM alphadome.bot_training_data
WHERE bot_tenant_id IN (
  SELECT id FROM alphadome.bot_tenants WHERE client_phone = '254700123456'
)
GROUP BY data_type, category
ORDER BY data_type, category;

-- Show sample training data
SELECT 
  data_type,
  LEFT(question, 50) as question_preview,
  LEFT(answer, 100) as answer_preview,
  priority,
  confidence_score
FROM alphadome.bot_training_data
WHERE bot_tenant_id IN (
  SELECT id FROM alphadome.bot_tenants WHERE client_phone = '254700123456'
)
ORDER BY priority DESC, created_at DESC
LIMIT 10;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================

