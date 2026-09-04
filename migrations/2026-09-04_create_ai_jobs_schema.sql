-- ============================================================================
-- ALPHADOME AI JOBS & MERCOR REFERRAL ENGINE - MIGRATION (Part 1: Tables)
-- ============================================================================
-- Additive migration: Creates new tables for AI opportunity discovery
-- and Mercor referral tracking without modifying existing tables.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS alphadome;

-- 1. OPPORTUNITY SOURCES
CREATE TABLE IF NOT EXISTS alphadome.opportunity_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  base_url text,
  source_type text DEFAULT 'referral',
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunity_sources_slug ON alphadome.opportunity_sources(slug);
CREATE INDEX IF NOT EXISTS idx_opportunity_sources_active ON alphadome.opportunity_sources(is_active);

-- 2. OPPORTUNITY CATEGORIES
CREATE TABLE IF NOT EXISTS alphadome.opportunity_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  parent_id uuid REFERENCES alphadome.opportunity_categories(id) ON DELETE SET NULL,
  referral_url text,
  seo_title text,
  seo_description text,
  seo_keywords jsonb DEFAULT '[]'::jsonb,
  display_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunity_categories_slug ON alphadome.opportunity_categories(slug);
CREATE INDEX IF NOT EXISTS idx_opportunity_categories_active ON alphadome.opportunity_categories(is_active);

COMMIT;
