/**
 * AI Jobs Admin Routes
 */
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getAnalyticsSummary } from '../utils/aiJobsService.js';

const router = Router();

// Use service role key for admin operations (bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  const validKey = process.env.ADMIN_KEY || process.env.ADMIN_PASS;
  if (!adminKey || adminKey !== validKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.get('/admin/ai-jobs', requireAdmin, async (req, res) => {
  try {
    const catsRes = await supabase.from('opportunity_categories').select('*').order('display_order');
    const oppsRes = await supabase.from('opportunities').select('*, category:opportunity_categories(name)').order('created_at', { ascending: false }).limit(50);
    const analytics = await getAnalyticsSummary({ days: 30 });
    
    if (catsRes.error) console.error('[AI Jobs Admin] Categories error:', catsRes.error);
    if (oppsRes.error) console.error('[AI Jobs Admin] Opportunities error:', oppsRes.error);
    
    const adminKey = req.query.key || req.headers['x-admin-key'] || process.env.ADMIN_KEY || process.env.ADMIN_PASS || '';
    res.send(renderAdminDashboard(catsRes.data || [], oppsRes.data || [], analytics, adminKey));
  } catch (err) {
    console.error('[AI Jobs Admin] Dashboard error:', err);
    res.status(500).send('Error loading dashboard: ' + err.message);
  }
});

router.post('/admin/ai-jobs/opportunities', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('opportunities').insert([{
      ...req.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }]);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/ai-jobs/opportunities/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('opportunities').update({ ...req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/ai-jobs/opportunities/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('opportunities').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/ai-jobs/analytics', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    res.json(await getAnalyticsSummary({ days }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/ai-jobs/generate-blogs', requireAdmin, async (req, res) => {
  try {
    const { generateBlogPostsForOpportunity, generateAllBlogs, reviewBlog, reviewAllBlogs } = await import('../scripts/blogManager.js');
    const { opportunityId, action, slug } = req.body;
    let result;
    if (action === 'review' && slug) result = await reviewBlog(slug);
    else if (action === 'review') result = await reviewAllBlogs();
    else if (opportunityId) result = await generateBlogPostsForOpportunity(opportunityId);
    else result = await generateAllBlogs();
    res.json(result);
  } catch (err) {
    console.error('[AI Jobs Admin] Blog error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/ai-jobs/blogs', requireAdmin, async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const blogDir = path.join(process.cwd(), 'public', 'blog');
    if (!fs.existsSync(blogDir)) return res.json({ blogs: [] });
    const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.html') && f !== 'index.html');
    const blogs = files.map(f => {
      const slug = f.replace('.html', '');
      const content = fs.readFileSync(path.join(blogDir, f), 'utf8');
      const titleMatch = content.match(/<h1>(.*?)<\/h1>/);
      const title = titleMatch ? titleMatch[1] : slug;
      const hasImage = content.includes('/images/blog/');
      return { slug, title, url: `/blog/${f}`, hasImage, created: fs.statSync(path.join(blogDir, f)).mtime };
    });
    res.json({ blogs, total: blogs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/ai-jobs/blogs', requireAdmin, async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const blogDir = path.join(process.cwd(), 'public', 'blog');
    if (!fs.existsSync(blogDir)) return res.json({ blogs: [] });
    const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.html') && f !== 'index.html');
    const blogs = files.map(f => {
      const slug = f.replace('.html', '');
      const content = fs.readFileSync(path.join(blogDir, f), 'utf8');
      const titleMatch = content.match(/<h1>(.*?)<\/h1>/);
      const title = titleMatch ? titleMatch[1] : slug;
      const hasImage = content.includes('/images/blog/');
      return { slug, title, url: `/blog/${f}`, hasImage, created: fs.statSync(path.join(blogDir, f)).mtime };
    });
    res.json({ blogs, total: blogs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function renderAdminDashboard(categories, opportunities, analytics, adminKey) {
  const ak = adminKey || process.env.ADMIN_KEY || process.env.ADMIN_PASS || '';
  const catsOptions = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  const oppsRows = opportunities.map(o => {
    const safeTitle = (o.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeCategory = (o.category?.name || '-').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
    <tr>
      <td>${safeTitle}</td>
      <td>${safeCategory}</td>
      <td><span class="s-${o.status}">${o.status}</span></td>
      <td>$${o.compensation_max || '-'}</td>
      <td>
        ${o.status !== 'published' ? `<button onclick="updateStatus('${o.id}','published')">Publish</button>` : ''}
        <button onclick="generateBlogs('${o.id}')">Generate Blogs</button>
        <button onclick="deleteOpp('${o.id}')">Delete</button>
      </td>
    </tr>
  `;
  }).join('');

  const publishedOpps = JSON.stringify(opportunities.filter(o => o.status === 'published').map(o => ({ id: o.id, title: o.title })));
  
  const analyticsRows = analytics?.top_pages ? analytics.top_pages.slice(0, 10).map(p => `
    <div style="display:flex;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid rgba(255,255,255,.1)">
      <span style="color:var(--text);font-size:.9rem;word-break:break-all">${p.path}</span>
      <span style="color:var(--accent);font-weight:bold;white-space:nowrap;margin-left:1rem">${p.views} views · ${p.ctr}% CTR</span>
    </div>
  `).join('') : '<p style="color:var(--muted)">No analytics data yet. Start tracking by visiting blog posts.</p>';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>AI Jobs Admin</title><style>
    :root{--bg:#081421;--accent:#ff8a00;--text:#f3f7fa;--muted:#b8c7d6;--card:rgba(255,255,255,.05)}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:1rem}
    h1,h2{color:var(--accent);margin:1rem 0}
    h1{font-size:1.8rem}
    h2{font-size:1.3rem;margin-top:2rem}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:.75rem;margin:1rem 0}
    .stat{background:var(--card);padding:1rem;border-radius:8px;text-align:center}
    .sv{font-size:1.8rem;font-weight:bold;color:var(--accent)}
    .stat-label{font-size:.8rem;color:var(--muted)}
    .card{background:var(--card);padding:1rem;border-radius:8px;margin:1rem 0}
    table{width:100%;border-collapse:collapse;margin:1rem 0;display:block;overflow-x:auto;white-space:nowrap}
    th,td{padding:.6rem;text-align:left;border-bottom:1px solid rgba(255,255,255,.1);font-size:.9rem}
    th{color:var(--accent);position:sticky;top:0;background:var(--bg)}
    .s-published{color:#7ef9c8}
    .s-draft{color:#b8c7d6}
    .s-closed{color:#ff6464}
    form{background:var(--card);padding:1rem;border-radius:8px;margin:1rem 0}
    input,select,textarea{width:100%;padding:.6rem;margin:.4rem 0;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);color:var(--text);border-radius:4px;font-size:16px}
    button{background:var(--accent);color:#000;border:none;padding:.6rem 1rem;border-radius:4px;cursor:pointer;margin:.2rem;font-weight:600;min-height:44px}
    button:hover{opacity:.9}
    .btn-group{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}
    #progressBar{display:none;margin:1rem 0;padding:1rem;background:var(--card);border-radius:8px}
    #progressFill{height:8px;width:0%;background:var(--accent);border-radius:4px;transition:width .3s}
    .hidden{display:none}
    .mobile-stack{display:flex;flex-direction:column;gap:.5rem}
    @media(max-width:600px){
      body{padding:.5rem}
      h1{font-size:1.4rem}
      .stats{grid-template-columns:1fr 1fr}
      table{font-size:.8rem}
      th,td{padding:.4rem}
      .btn-stack{flex-direction:column}
      button{width:100%;margin:.2rem 0}
      .op-actions{display:flex;flex-direction:column;gap:.3rem}
      .op-actions button{width:100%;margin:0}
    }
    @media(min-width:601px){
      .op-actions{display:flex;gap:.3rem;flex-wrap:wrap}
    }
  </style></head><body>
  <h1>AI Jobs Admin</h1>
  
  <div class="stats">
    <div class="stat"><div class="sv">${analytics?.total_views||0}</div><div class="stat-label">Page Views</div></div>
    <div class="stat"><div class="sv">${analytics?.total_clicks||0}</div><div class="stat-label">Clicks</div></div>
    <div class="stat"><div class="sv">${analytics?.overall_ctr||0}%</div><div class="stat-label">CTR</div></div>
    <div class="stat"><div class="sv">${opportunities.length}</div><div class="stat-label">Jobs</div></div>
  </div>

  <div class="card">
    <h2>Top Performing Pages</h2>
    ${analyticsRows}
  </div>

  <div class="btn-group">
    <button onclick="generateAllBlogs()">Generate All Blog Posts</button>
    <button onclick="reviewAllBlogs()">Review All Blog Posts</button>
    <button onclick="loadBlogs()">Refresh Blog List</button>
  </div>

  <h2>Create Opportunity</h2>
  <form id="f">
    <input name="title" placeholder="Job Title" required>
    <select name="category_id" required><option value="">Select Category</option>${catsOptions}</select>
    <input type="number" name="compensation_max" placeholder="Max USD/hr">
    <textarea name="description" placeholder="Job Description" rows="3"></textarea>
    <input name="location_text" placeholder="Location (e.g., Remote)">
    <input name="skills" placeholder="Skills (comma-separated)">
    <input name="referral_url" placeholder="Referral URL (optional)">
    <button type="submit">Create Opportunity</button>
  </form>

  <h2>Opportunities</h2>
  <table>
    <thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Pay</th><th>Actions</th></tr></thead>
    <tbody>${oppsRows}</tbody>
  </table>

  <div id="progressBar"><h3 id="progressTitle">Generating...</h3><div style="background:rgba(255,255,255,.1);border-radius:4px"><div id="progressFill"></div></div></div>
  
  <div class="card hidden" id="blogLinks"><h3>Generated Blog Posts</h3><div id="blogLinksList"></div></div>
  
  <h2>All Blog Posts</h2>
  <div id="allBlogsList">Loading...</div>

  <script>
const AK = '${ak}';

function showProgress(show) {
  document.getElementById('progressBar').style.display = show ? 'block' : 'none';
}

function setProgress(pct) {
  document.getElementById('progressFill').style.width = pct + '%';
}

function setProgressText(text) {
  const el = document.getElementById('progressTitle');
  if (el) el.innerText = text;
}

async function updateStatus(id, s) {
  try {
    const res = await fetch('/admin/ai-jobs/opportunities/' + id + '?key=' + encodeURIComponent(AK), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': AK },
      body: JSON.stringify({ status: s })
    });
    if (!res.ok) throw new Error('Status update failed');
    location.reload();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteOpp(id) {
  if (!confirm('Are you sure you want to delete this opportunity?')) return;
  try {
    const res = await fetch('/admin/ai-jobs/opportunities/' + id + '?key=' + encodeURIComponent(AK), {
      method: 'DELETE',
      headers: { 'x-admin-key': AK }
    });
    if (!res.ok) throw new Error('Delete failed');
    location.reload();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function generateBlogs(id) {
  showProgress(true);
  setProgress(15);
  setProgressText('Generating blog posts for opportunity...');
  try {
    const r = await fetch('/admin/ai-jobs/generate-blogs?key=' + encodeURIComponent(AK), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': AK },
      body: JSON.stringify({ opportunityId: id })
    });
    setProgress(90);
    const d = await r.json();
    setProgress(100);
    if (d.posts && d.posts.length > 0) {
      const l = document.getElementById('blogLinksList');
      l.innerHTML = d.posts.map(function(p) {
        return '<a href="' + p.url + '" target="_blank">' + p.title + '</a>';
      }).join('');
      document.getElementById('blogLinks').style.display = 'block';
      alert('Successfully generated ' + d.posts.length + ' blog posts!');
    } else if (d.error) {
      alert('Error: ' + d.error);
    } else {
      alert('No posts were generated.');
    }
  } catch (err) {
    alert('Error generating blogs: ' + err.message);
  } finally {
    setTimeout(function() { showProgress(false); }, 1500);
    loadBlogs();
  }
}

const publishedOpps = ${publishedOpps};

async function generateAllBlogs() {
  if (!publishedOpps || publishedOpps.length === 0) {
    alert('No published opportunities found. Publish opportunities first!');
    return;
  }
  if (!confirm('Generate blog posts for all ' + publishedOpps.length + ' published opportunities? This will process them one by one.')) return;
  
  showProgress(true);
  let totalGenerated = 0;
  const list = document.getElementById('blogLinksList');
  list.innerHTML = '';
  document.getElementById('blogLinks').style.display = 'block';
  
  for (let i = 0; i < publishedOpps.length; i++) {
    const opp = publishedOpps[i];
    const pct = Math.round(((i + 1) / publishedOpps.length) * 100);
    setProgress(pct);
    setProgressText('Generating (' + (i + 1) + '/' + publishedOpps.length + '): ' + opp.title);
    
    try {
      const r = await fetch('/admin/ai-jobs/generate-blogs?key=' + encodeURIComponent(AK), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': AK },
        body: JSON.stringify({ opportunityId: opp.id })
      });
      const d = await r.json();
      if (d.posts && d.posts.length > 0) {
        totalGenerated += d.posts.length;
        d.posts.forEach(function(p) {
          const a = document.createElement('a');
          a.href = p.url;
          a.target = '_blank';
          a.innerText = p.title;
          list.appendChild(a);
        });
      }
    } catch (e) {
      console.error('Error generating for opp:', opp.title, e);
    }
  }
  
  setProgressText('Generation Complete!');
  alert('Completed! Generated ' + totalGenerated + ' blog posts across ' + publishedOpps.length + ' opportunities.');
  setTimeout(function() { showProgress(false); }, 2000);
  loadBlogs();
}

async function reviewBlog(slug) {
  if (!confirm('Review and improve: ' + slug + '?')) return;
  showProgress(true);
  setProgress(20);
  setProgressText('Reviewing article...');
  try {
    const r = await fetch('/admin/ai-jobs/generate-blogs?key=' + encodeURIComponent(AK), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': AK },
      body: JSON.stringify({ action: 'review', slug: slug })
    });
    setProgress(100);
    const d = await r.json();
    if (d.error) {
      alert('Error: ' + d.error);
    } else {
      alert('Reviewed: ' + (d.slug || slug));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    showProgress(false);
    loadBlogs();
  }
}

async function reviewAllBlogs() {
  if (!confirm('Review ALL blog posts? This may take some time.')) return;
  showProgress(true);
  setProgress(20);
  setProgressText('Reviewing all articles...');
  try {
    const r = await fetch('/admin/ai-jobs/generate-blogs?key=' + encodeURIComponent(AK), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': AK },
      body: JSON.stringify({ action: 'review' })
    });
    setProgress(100);
    const d = await r.json();
    alert('Reviewed ' + (d.reviewed || 0) + ' blog posts');
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    showProgress(false);
    loadBlogs();
  }
}

async function loadBlogs() {
  try {
    const r = await fetch('/admin/ai-jobs/blogs?key=' + encodeURIComponent(AK), {
      headers: { 'x-admin-key': AK }
    });
    const d = await r.json();
    const l = document.getElementById('allBlogsList');
    if (!l) return;
    if (d.blogs && d.blogs.length > 0) {
      l.innerHTML = d.blogs.map(function(b) {
        const titleSafe = (b.title || b.slug).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const cleanSlug = b.slug.replace(/[^a-zA-Z0-9_-]/g, '');
        return '<div style="background:rgba(255,255,255,.05);padding:1rem;border-radius:8px;margin:.5rem 0;display:flex;justify-content:space-between;align-items:center">' +
          '<div>' +
            '<a href="' + b.url + '" target="_blank" style="color:#ff8a00;font-weight:bold">' + titleSafe + '</a>' +
            (b.hasImage ? ' 🖼️' : '') +
            ' <span style="color:#b8c7d6;font-size:.8rem">(' + cleanSlug + ')</span>' +
          '</div>' +
          '<button onclick="reviewBlog(\\\'' + cleanSlug + '\\\')">Review</button>' +
        '</div>';
      }).join('') + '<p style="color:#b8c7d6">Total: ' + d.blogs.length + ' blog posts</p>';
    } else {
      l.innerHTML = '<p style="color:#b8c7d6">No blog posts generated yet. Click "Generate All Blog Posts" or generate per opportunity.</p>';
    }
  } catch (err) {
    console.error('loadBlogs error:', err);
    const l = document.getElementById('allBlogsList');
    if (l) l.innerHTML = '<p style="color:#ff6464">Error loading blog list: ' + err.message + '</p>';
  }
}

document.getElementById('f').onsubmit = async function(e) {
  e.preventDefault();
  const f = e.target;
  try {
    const payload = {
      title: f.title.value,
      category_id: f.category_id.value,
      compensation_max: parseFloat(f.compensation_max.value) || null,
      description: f.description.value,
      location_text: f.location_text.value,
      skills: f.skills.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
      referral_url: f.referral_url.value || null,
      status: 'draft',
      slug: f.title.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    };
    const res = await fetch('/admin/ai-jobs/opportunities?key=' + encodeURIComponent(AK), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': AK },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Create failed');
    location.reload();
  } catch (err) {
    alert('Error creating opportunity: ' + err.message);
  }
};

loadBlogs();
</script></body></html>`;
}

// Analytics endpoint
router.get('/admin/ai-jobs/analytics', requireAdmin, async (req, res) => {
  try {
    const { getAnalyticsSummary } = await import('../utils/analytics.js');
    const days = parseInt(req.query.days) || 30;
    const summary = await getAnalyticsSummary(days);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
