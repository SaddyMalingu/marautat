-- ============================================================================
-- SEED SAMPLE OPPORTUNITIES
-- ============================================================================
-- Run this after the main migration to add sample job listings
-- ============================================================================

-- Get the Mercor source ID
DO $$
DECLARE
  mercor_id uuid;
  sw_eng_id uuid;
  data_id uuid;
  finance_id uuid;
BEGIN
  -- Get source ID
  SELECT id INTO mercor_id FROM alphadome.opportunity_sources WHERE slug = 'mercor';
  
  -- Get category IDs
  SELECT id INTO sw_eng_id FROM alphadome.opportunity_categories WHERE slug = 'software-engineering';
  SELECT id INTO data_id FROM alphadome.opportunity_categories WHERE slug = 'data-analysis';
  SELECT id INTO finance_id FROM alphadome.opportunity_categories WHERE slug = 'finance';

  -- Insert sample opportunities
  INSERT INTO alphadome.opportunities (source_id, title, slug, description, category_id, compensation_max, compensation_type, location_text, skills, status, published_at, last_verified_at) VALUES
  (mercor_id, 'ML Engineer, Coding Agent Experience', 'ml-engineer-coding-agent', 'Work on cutting-edge coding agents that help developers write better code. You will train and evaluate AI models that understand and generate code across multiple programming languages.', sw_eng_id, 85, 'hourly', 'Remote', to_jsonb(ARRAY['Python', 'AI/ML', 'Coding Agents', 'LLMs']), 'published', NOW(), NOW()),
  
  (mercor_id, 'Frontend Engineer, AI Products', 'frontend-engineer-ai', 'Build intuitive user interfaces for AI-powered products. Work with React, TypeScript, and modern web technologies to create seamless user experiences.', sw_eng_id, 90, 'hourly', 'Remote', to_jsonb(ARRAY['React', 'TypeScript', 'CSS', 'AI/ML']), 'published', NOW(), NOW()),
  
  (mercor_id, 'Backend Engineer, LLM Infrastructure', 'backend-engineer-llm', 'Design and implement scalable infrastructure for LLM applications. Work on APIs, data pipelines, and model serving systems.', sw_eng_id, 95, 'hourly', 'Remote', to_jsonb(ARRAY['Python', 'Go', 'Distributed Systems', 'LLMs']), 'published', NOW(), NOW()),
  
  (mercor_id, 'Data Scientist, Model Evaluation', 'data-scientist-evaluation', 'Develop evaluation frameworks and benchmarks for AI models. Design experiments and analyze model performance across diverse tasks.', data_id, 75, 'hourly', 'Remote', to_jsonb(ARRAY['Python', 'Statistics', 'Machine Learning', 'Data Analysis']), 'published', NOW(), NOW()),
  
  (mercor_id, 'AI Training Data Specialist', 'ai-training-data-specialist', 'Create and curate high-quality training data for AI models. Ensure data diversity, accuracy, and relevance for model training.', data_id, 65, 'hourly', 'Remote', to_jsonb(ARRAY['Data Annotation', 'Python', 'Quality Assurance', 'AI/ML']), 'published', NOW(), NOW()),
  
  (mercor_id, 'Financial Analyst, AI Applications', 'financial-analyst-ai', 'Apply AI and machine learning techniques to financial analysis. Build models for risk assessment, forecasting, and investment analysis.', finance_id, 80, 'hourly', 'Remote', to_jsonb(ARRAY['Finance', 'Python', 'Machine Learning', 'Statistics']), 'published', NOW(), NOW());

END $$;
