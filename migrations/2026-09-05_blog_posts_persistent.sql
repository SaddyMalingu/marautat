-- ============================================================
-- PERSISTENT BLOG STORAGE
-- Safeguards all existing and future blog posts
-- ============================================================

-- Create blog posts table in public schema (where opportunities lives)
CREATE TABLE IF NOT EXISTS public.blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  html_content text NOT NULL,
  opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL,
  category text DEFAULT 'general',
  thumbnail_url text,
  meta_description text,
  status text DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  view_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON public.blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_opportunity ON public.blog_posts(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON public.blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON public.blog_posts(category);

-- Enable RLS
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

-- Public can read published posts
CREATE POLICY "Public can read published posts" ON public.blog_posts
  FOR SELECT USING (status = 'published');

-- Grant permissions
GRANT SELECT ON public.blog_posts TO anon;
GRANT ALL ON public.blog_posts TO authenticated;

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_blog_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for auto-updating
DROP TRIGGER IF EXISTS trigger_blog_updated_at ON public.blog_posts;
CREATE TRIGGER trigger_blog_updated_at
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_blog_updated_at();

