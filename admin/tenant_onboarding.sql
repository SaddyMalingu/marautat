-- Tenant Onboarding SQL Script (Generated: 2026-02-28)
-- For each tenant, update missing details (Meta IDs, contact info, etc.) before activation.

-- =====================
-- Tenants WITH WhatsApp Numbers
-- =====================
INSERT INTO alphadome.bot_tenants (
  client_name,
  client_phone,
  brand_id,
  is_active,
  is_verified,
  metadata
) VALUES
('Coach Dawn 3.0', '254748621563', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Soma Katiba 3.0', '254722717865', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Malingu Global Supplies 3.0', '254799721460', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Agent Purity 3.0', '254720486791', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Denim & Diamonds 3.0', '254728746015', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('One Odundo 3.0', '254720566608', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Tour Guide Dennis 3.0', '254704953642', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Coach Peter 3.0', '254720737106', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Vet Martin 3.0', '254727058824', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Rahim Boutique 3.0', '254722777391', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('House of Annie Events & Tours 3.0', '254769892450', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Agent Saleh 3.0', '254746252088', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Agent Tekla 3.0', '254715221606', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Lifeline Cancer Trust 3.0', '254724727390', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Bijo Gas and Accessories 3.0', '254714968909', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Mawani 3.0', '254759457202', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Sharon Beauty 3.0', '254716543542', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Dr. Cindy 3.0', '254707348513', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Virtual Assistant Abby 3.0', '254707148096', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Malingu Contractor 3.0', '254729530472', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Mary Msoh Communications Solutions 3.0', '254795006968', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('General Apollo 3.0', '254708623514', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Building Plans 3.0', '254716783715', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Craydel Africa Travel 3.0', '254722881541', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Elegance Aesthetic Spa 3.0', '254727990228', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Amir 3.0', '254708446848', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('PBC 3.0', '254715371211', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials')),
('Urban Craft 3.0', '254716439810', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Pending Meta credentials'));

-- =====================
-- Tenants WITHOUT WhatsApp Numbers (Priority Outreach List)
-- =====================
-- Add WhatsApp contact and Meta credentials before onboarding
-- Example:
-- ('TENANT_NAME', 'WHATSAPP_NUMBER', '1af71403-b4c3-4eac-9aab-48ee2576a9bb', false, false, jsonb_build_object('notes','Priority outreach'))
--
-- Donkeytopia
-- The Winning Team HR Solutions 3.0
-- Dr. Sally Freeman 3.0
-- Professor Leon Aaron 3.0
-- Dr. Ransford Antwi 3.0
-- Sky Garden 3.0
-- Carolyn Abbot
-- Dr. Sabu Abraham
-- Patmag School Uniform 3.0
-- Nila Pharmaceuticals 3.0
-- Victoria Beauty 3.0
-- Donki Brands 3.0
-- The Branch Restaurant 3.0
-- The Peach 3.0
-- The Curve 3.0
-- Galitoz 3.0
-- Denri 3.0
-- Unifi 3.0
-- Mamy 3.0
-- Lady Luck 3.0
-- Baus Optical 3.0
-- Aboosto 3.0
-- Ebrahim Electronics 3.0
-- Kam Pharmacy 3.0
-- Penda Health 3.0
-- Olakira 3.0
-- Beauty Square 3.0
-- Anupi Fashions 3.0
