# AI Jobs & Mercor Referral Engine

## Overview

The AI Jobs subsystem is an additive feature that adds an SEO-driven opportunity discovery and Mercor referral engine to the existing AlphaDome platform. It operates independently without affecting existing functionality.

## Architecture

```
AlphaDome
├── Existing Application (untouched)
│   ├── Authentication
│   ├── Tenants
│   ├── WhatsApp Bot
│   └── ...
│
└── AI Work Subsystem (new)
    ├── /ai-jobs/* routes
    ├── Opportunity database
    ├── Category taxonomy
    ├── Referral mapping
    ├── SEO pages
    ├── Analytics tracking
    └── Admin interface
```

## Database Tables (New)

All tables are in the `alphadome` schema and do not affect existing tables:

- `opportunity_sources` - External providers (Mercor, etc.)
- `opportunity_categories` - Professional categories with referral links
- `opportunities` - Individual job listings
- `opportunity_events` - Analytics events
- `referral_links` - Centralized referral URL configuration

## Routes

### Public Routes
- `GET /ai-jobs` - AI Jobs landing page
- `GET /ai-jobs/mercor` - Mercor opportunities page
- `GET /ai-jobs/mercor/:categorySlug` - Category page
- `GET /ai-jobs/mercor/opportunity/:slug` - Individual opportunity page
- `GET /api/opportunities/:id/apply` - Track click and redirect to Mercor
- `POST /api/events` - Track analytics events

### Admin Routes
- `GET /admin/ai-jobs` - Admin dashboard
- `POST /admin/ai-jobs/opportunities` - Create opportunity
- `PUT /admin/ai-jobs/opportunities/:id` - Update opportunity
- `GET /admin/ai-jobs/analytics` - Get analytics data

### SEO
- `GET /sitemap.xml` - Dynamic sitemap
- `GET /robots.txt` - Crawler configuration

## Referral URL Resolution

The system uses a three-tier referral URL resolution:

1. **Job-specific URL** (highest priority) - Individual Mercor job referral link
2. **Category URL** - Category-level Mercor referral link
3. **General URL** (fallback) - General Mercor referral link

## Setup Instructions

### 1. Run Database Migrations

Execute the SQL migration files in order:

```bash
# Part 1: Create tables
psql -f migrations/2026-09-04_create_ai_jobs_schema.sql

# Part 2: More tables
psql -f migrations/2026-09-04_create_ai_jobs_schema_part2.sql

# Part 3: Seed data and RLS
psql -f migrations/2026-09-04_create_ai_jobs_schema_part3.sql
```

### 2. Environment Variables

No new environment variables are required. The system uses existing Supabase credentials.

Optional:
- `SITE_URL` - Canonical URL for SEO (defaults to https://alphadome.com)
- `ADMIN_KEY` - Admin access key (defaults to ADMIN_PASS)

### 3. Verify Installation

1. Start the server: `npm start`
2. Visit `http://localhost:PORT/ai-jobs`
3. Check categories load correctly
4. Test admin at `http://localhost:PORT/admin/ai-jobs`

## Referral URLs

### General
- https://t.mercor.com/tqwsF

### Categories
| Category | Slug | Referral URL |
|----------|------|--------------|
| Medicine | medicine | https://t.mercor.com/H0hIC |
| Law | law | https://t.mercor.com/qmTg8 |
| Software Engineering | software-engineering | https://t.mercor.com/20MWE |
| Data Analysis | data-analysis | https://t.mercor.com/jmluX |
| Finance | finance | https://t.mercor.com/vHKIv |
| Business Operations | business-operations | https://t.mercor.com/LxKC0 |
| Sciences | life-physical-social-sciences | https://t.mercor.com/rWlds |
| Engineering | other-engineering | https://t.mercor.com/axpK4 |
| Arts & Design | arts-design | https://t.mercor.com/uH1OY |
| Language & Audio | language-audio | https://t.mercor.com/g6As3 |
| Humanities | humanities | https://t.mercor.com/OcRv3 |

## Opportunity Lifecycle

States:
- `draft` - Created but not ready for display
- `verified` - Information checked
- `published` - Publicly visible
- `stale` - Not verified recently
- `closed` - No longer accepting applications
- `archived` - Retained for historical value

## Analytics Events

Tracked events:
- `page_view` - General page view
- `category_view` - Category page view
- `opportunity_view` - Individual opportunity view
- `apply_click` - User clicked apply button
- `referral_click` - User clicked referral link
- `external_click` - User clicked external link

## Security

- Referral URLs are validated against allowed domains
- Admin routes require authentication
- RLS policies protect database tables
- No open redirect vulnerabilities

## SEO Features

- Unique meta titles and descriptions per page
- Canonical URLs
- OpenGraph metadata
- JSON-LD structured data (JobPosting schema)
- Dynamic sitemap.xml
- robots.txt configuration
- Semantic HTML structure
- Internal linking between related content

## File Structure

```
routes/
├── aiJobs.js           - Public AI Jobs routes
├── aiJobsAdmin.js      - Admin interface routes
└── sitemap.xml         - Sitemap generator

utils/
├── aiJobsConfig.js     - Referral URL configuration
├── aiJobsService.js    - Database operations
├── aiJobsViews.js      - HTML rendering (landing, category)
└── aiJobsViewsOpp.js   - HTML rendering (opportunity)

migrations/
├── 2026-09-04_create_ai_jobs_schema.sql       - Tables (part 1)
├── 2026-09-04_create_ai_jobs_schema_part2.sql  - Tables (part 2)
└── 2026-09-04_create_ai_jobs_schema_part3.sql  - Seed data & RLS

public/
└── robots.txt          - Crawler configuration
```

## Adding New Opportunity Providers

To add a new provider (e.g., Scale AI, Outlier):

1. Insert into `opportunity_sources` table
2. Create categories with referral URLs
3. Add opportunities linked to the new source
4. The system automatically handles routing and SEO

## Revenue Model

- Mercor pays 20% of eligible referral earnings
- Earnings begin when referred candidate is hired and starts billable work
- Payouts released twice weekly
- No earnings guarantee - quality over quantity

## Support

For issues or questions, refer to the main AlphaDome documentation.
