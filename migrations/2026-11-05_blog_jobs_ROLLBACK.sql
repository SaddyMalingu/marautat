-- Rollback for 2026-11-05_blog_jobs.sql
--
-- Safe to run at any time: the table holds job progress, not content. Blog pages live in
-- `blog_posts` and are untouched by dropping this. A deploy left without the table answers 503
-- on the two Optimise routes and everything else keeps working.

DROP INDEX IF EXISTS public.blog_jobs_running_idx;
DROP INDEX IF EXISTS public.blog_jobs_scope_created_idx;
DROP INDEX IF EXISTS public.blog_jobs_tenant_created_idx;
DROP TABLE IF EXISTS public.blog_jobs;
