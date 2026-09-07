import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __f = fileURLToPath(import.meta.url);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BLOG = path.join(process.cwd(), 'public', 'blog');

async function backup() {
  console.log('[BACKUP] Starting...');
  
  if (!fs.existsSync(BLOG)) {
    console.log('[BACKUP] No blog directory found');
    return { error: 'No blog directory' };
  }
  
  const files = fs.readdirSync(BLOG).filter(f => f.endsWith('.html') && f !== 'index.html');
  console.log('[BACKUP] Found ' + files.length + ' posts');
  
  let saved = 0;
  for (const file of files) {
    try {
      const slug = file.replace('.html', '');
      const htmlContent = fs.readFileSync(path.join(BLOG, file), 'utf8');
      
      // Extract title
      const titleMatch = htmlContent.match(/<h1>(.*?)<\/h1>/);
      const title = titleMatch ? titleMatch[1] : slug;
      
      // Extract meta description
      const descMatch = htmlContent.match(/<meta name="description" content="(.*?)"/);
      const metaDescription = descMatch ? descMatch[1] : '';
      
      // Extract thumbnail
      const imgMatch = htmlContent.match(/<img src="(\/images\/blog\/[^"]+)"/);
      const thumbnailUrl = imgMatch ? imgMatch[1] : null;
      
      // Extract content (between article tags)
      const contentMatch = htmlContent.match(/<article>([\s\S]*?)<\/article>/);
      const content = contentMatch ? contentMatch[1] : htmlContent;
      
      const { error } = await sb.from('blog_posts').upsert({
        slug,
        title,
        content,
        html_content: htmlContent,
        category: 'general',
        thumbnail_url: thumbnailUrl,
        meta_description: metaDescription,
        status: 'published'
      }, { onConflict: 'slug' });
      
      if (error) {
        console.error('[BACKUP] Error saving ' + slug + ':', error.message);
      } else {
        saved++;
        console.log('[BACKUP] Saved: ' + slug);
      }
    } catch (e) {
      console.error('[BACKUP] Error processing ' + file + ':', e.message);
    }
  }
  
  console.log('[BACKUP] Complete: ' + saved + '/' + files.length + ' posts saved');
  return { success: true, saved, total: files.length };
}

backup().then(r => console.log(JSON.stringify(r))).catch(console.error);
