-- ============================================================================
-- ALPHADOME AI JOBS & MERCOR REFERRAL ENGINE - MIGRATION (Part 3: Seed Data & RLS)
-- ============================================================================

BEGIN;

-- Insert Mercor as opportunity source
INSERT INTO alphadome.opportunity_sources (name, slug, base_url, source_type, is_active)
VALUES ('Mercor', 'mercor', 'https://t.mercor.com', 'referral', true)
ON CONFLICT (slug) DO NOTHING;

-- Insert categories with referral links
INSERT INTO alphadome.opportunity_categories (name, slug, description, referral_url, seo_title, seo_description, display_order, is_active) VALUES
('Software Engineering', 'software-engineering', 'Software engineering opportunities including frontend, backend, full-stack, and AI/ML engineering roles.', 'https://t.mercor.com/20MWE', 'Mercor Software Engineering Jobs | AlphaDome', 'Discover software engineering opportunities on Mercor. Apply through AlphaDome referral links.', 1, true),
('Data Analysis', 'data-analysis', 'Data analysis and data science opportunities including analytics, machine learning, and AI training roles.', 'https://t.mercor.com/jmluX', 'Mercor Data Analysis Jobs | AlphaDome', 'Explore data analysis and data science opportunities on Mercor.', 2, true),
('Finance', 'finance', 'Finance opportunities including financial analysis, accounting, and fintech roles.', 'https://t.mercor.com/vHKIv', 'Mercor Finance Opportunities | AlphaDome', 'Discover finance opportunities on Mercor. Apply through AlphaDome referral links.', 3, true),
('Medicine', 'medicine', 'Medical and healthcare opportunities including clinical research, medical writing, and healthcare AI.', 'https://t.mercor.com/H0hIC', 'Mercor Medicine Opportunities | AlphaDome', 'Explore medical and healthcare opportunities on Mercor.', 4, true),
('Law', 'law', 'Legal opportunities including legal research, contract analysis, and legal AI training.', 'https://t.mercor.com/qmTg8', 'Mercor Law Opportunities | AlphaDome', 'Discover legal opportunities on Mercor. Apply for legal research and AI training roles.', 5, true),
('Business Operations', 'business-operations', 'Business operations opportunities including project management and business strategy.', 'https://t.mercor.com/LxKC0', 'Mercor Business Operations Jobs | AlphaDome', 'Explore business operations opportunities on Mercor.', 6, true),
('Life, Physical & Social Sciences', 'life-physical-social-sciences', 'Science opportunities including biology, chemistry, physics, and social science research.', 'https://t.mercor.com/rWlds', 'Mercor Science Opportunities | AlphaDome', 'Discover science opportunities on Mercor.', 7, true),
('Other Engineering', 'other-engineering', 'Engineering opportunities including mechanical, electrical, civil, and chemical engineering.', 'https://t.mercor.com/axpK4', 'Mercor Engineering Jobs | AlphaDome', 'Explore engineering opportunities on Mercor.', 8, true),
('Arts & Design', 'arts-design', 'Arts and design opportunities including graphic design, UX/UI design, and creative direction.', 'https://t.mercor.com/uH1OY', 'Mercor Arts & Design Jobs | AlphaDome', 'Discover arts and design opportunities on Mercor.', 9, true),
('Language & Audio', 'language-audio', 'Language and audio opportunities including translation, transcription, and language AI training.', 'https://t.mercor.com/g6As3', 'Mercor Language & Audio Jobs | AlphaDome', 'Explore language and audio opportunities on Mercor.', 10, true),
('Humanities', 'humanities', 'Humanities opportunities including history, philosophy, literature, and cultural research.', 'https://t.mercor.com/OcRv3', 'Mercor Humanities Opportunities | AlphaDome', 'Discover humanities opportunities on Mercor.', 11, true)
ON CONFLICT (slug) DO NOTHING;

-- Insert general referral link
INSERT INTO alphadome.referral_links (link_key, link_type, referral_url, is_active)
VALUES ('mercor-general', 'general', 'https://t.mercor.com/tqwsF', true)
ON CONFLICT (link_key) DO NOTHING;

-- Enable RLS
ALTER TABLE alphadome.opportunity_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE alphadome.opportunity_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE alphadome.opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE alphadome.opportunity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alphadome.referral_links ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Public can read active sources" ON alphadome.opportunity_sources
  FOR SELECT USING (is_active = true);

CREATE POLICY "Public can read active categories" ON alphadome.opportunity_categories
  FOR SELECT USING (is_active = true);

CREATE POLICY "Public can read published opportunities" ON alphadome.opportunities
  FOR SELECT USING (status = 'published');

CREATE POLICY "Public can insert events" ON alphadome.opportunity_events
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Public can read active referral links" ON alphadome.referral_links
  FOR SELECT USING (is_active = true);

COMMIT;
