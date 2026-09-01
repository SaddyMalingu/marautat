# Alphadome: Digital Transformation Platform
## WhatsApp Bot + AI Agents + 3.0 Systems + Physical Robots

This repo contains the **Alphadome WhatsApp bot** powering a complete digital transformation ecosystem for African brands.

### What is Alphadome?
Alphadome is a blockchain-powered AI platform that transforms 1000 African brands into digital enterprises. Each client gets:
- **Custom 3.0 Information Systems** (databases, dashboards, AI automation)
- **Brand-Specific AI Agents** (sales, support, operations, 24/7)
- **Physical Avatar Robots** (branded kiosks embodying AI agents)
- **Blockchain Crowdfunding** (community-funded growth with equity ownership)
- **WhatsApp Integration** (customer engagement and lead handling)

**Founder:** David Saddy Malingu  
**Mission:** Make the Afrika rock the most valuable digital asset in the world by empowering African brands  
**Timeline:** 1000 clients in 24 months (Alpha 1 Squad program)  
**Pricing:** Founder's Package (1,000 KES/month) or Custom Alpha 1 (enterprise)

### Key Resources
📄 **Knowledge Base:** [alphadome_knowledge_base_full.json](./alphadome_knowledge_base_full.json)  
🌐 **Landing Site Content:** [LANDING_SITE_CONTENT.md](./LANDING_SITE_CONTENT.md)  
💼 **Investor Pitch:** [INVESTOR_PITCH.md](./INVESTOR_PITCH.md)  
🎯 **Client Onboarding:** [CLIENT_ONBOARDING_PLAYBOOK.md](./CLIENT_ONBOARDING_PLAYBOOK.md)  
🤖 **Bot Context:** [utils/alphadomeBrandContext.js](./utils/alphadomeBrandContext.js)  

---

## Admin Catalog Upload (Dashboard)

This repo contains the Alphadome WhatsApp bot with multi‑tenant routing, product catalog, and portfolio support.

## Admin Catalog Upload (Dashboard)

Start the server and open:

- http://localhost:3000/admin?key=YOUR_ADMIN_PASS

You can upload:
- Products (JSON)
- Product images (named by SKU)
- CSV catalog import

### Required env vars

- `ADMIN_PASS`
- `SB_URL`
- `SB_SERVICE_ROLE_KEY`

### Upload Flow

1. Run DB migrations:
   - `migrations/2026-02-06_insert_kassangas_test_tenant_and_products.sql`
   - `migrations/2026-02-07_create_product_portfolio_tables.sql`
   - `migrations/2026-02-06_create_product_variants_table.sql`
   - `migrations/2026-02-07_seed_portfolio_rpc.sql`

2. Start server:

```powershell
npm start
```

3. Open dashboard:

```text
http://localhost:3000/admin?key=YOUR_ADMIN_PASS
```

## CLI Upload Test

```powershell
node admin/upload_test.js
```

## Simple Upload Test (Auto‑SKU)

```powershell
node admin/simple_upload_test.js
```

## CSV Import Test

```powershell
node admin/upload_csv_test.js
```

## Notes

- Images should be named by SKU (e.g., `KASS-GTR-001.jpg`).
- The upload endpoint uses the RPC `public.seed_portfolio` to bypass Supabase schema cache issues.
