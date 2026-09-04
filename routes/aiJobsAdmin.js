/**
 * AI Jobs Admin Routes
 */
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getAnalyticsSummary } from '../utils/aiJobsService.js';

const router = Router();
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
    const [cats, opps, analytics] = await Promise.all([
      supabase.from('opportunity_categories').select('*').order('display_order'),
      supabase.from('opportunities').select('*, category:opportunity_categories(name)').order('created_at', { ascending: false }).limit(50),
      getAnalyticsSummary({ days: 30 })
    ]);
    res.send(renderAdminDashboard(cats.data || [], opps.data || [], analytics));
  } catch (err) {
    res.status(500).send('Error loading dashboard');
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

router.get('/admin/ai-jobs/analytics', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    res.json(await getAnalyticsSummary({ days }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function renderAdminDashboard(categories, opportunities, analytics) {
  const catsOptions = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  const oppsRows = opportunities.map(o => `<tr><td>${o.title}</td><td>${o.category?.name||'-'}</td><td><span class="s-${o.status}">${o.status}</span></td><td>$${o.compensation_max||'-'}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>AI Jobs Admin</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:20px;background:#081421;color:#f3f7fa}h1,h2{color:#ff8a00}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin:1rem 0}.stat{background:rgba(255,255,255,.05);padding:1rem;border-radius:8px;text-align:center}.sv{font-size:2rem;font-weight:bold;color:#ff8a00}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{padding:.75rem;text-align:left;border-bottom:1px solid rgba(255,255,255,.1)}th{color:#ff8a00}.s-published{color:#7ef9c8}.s-draft{color:#b8c7d6}.s-closed{color:#ff6464}form{background:rgba(255,255,255,.05);padding:1rem;border-radius:8px;margin:1rem 0}input,select,textarea{width:100%;padding:.5rem;margin:.5rem 0;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);color:#f3f7fa;border-radius:4px}button{background:#ff8a00;color:#000;border:none;padding:.5rem 1rem;border-radius:4px;cursor:pointer}</style></head><body><h1>AI Jobs Admin</h1><div class="stats"><div class="stat"><div class="sv">${analytics?.opportunity_views||0}</div><div>Views</div></div><div class="stat"><div class="sv">${analytics?.apply_clicks||0}</div><div>Clicks</div></div><div class="stat"><div class="sv">${opportunities.length}</div><div>Total</div></div></div><h2>Create Opportunity</h2><form id="f"><input name="title" placeholder="Title" required><select name="category_id" required><option value="">Category</option>${catsOptions}</select><input type="number" name="compensation_max" placeholder="Max USD/hr"><textarea name="description" placeholder="Description" rows="3"></textarea><input name="location_text" placeholder="Location"><input name="skills" placeholder="Skills (comma-separated)"><input name="referral_url" placeholder="Referral URL (optional)"><button type="submit">Create</button></form><h2>Opportunities</h2><table><thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Pay</th></tr></thead><tbody>${oppsRows}</tbody></table><script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const f=e.target;await fetch('/admin/ai-jobs/opportunities',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':prompt('Admin key?')},body:JSON.stringify({title:f.title.value,category_id:f.category_id.value,compensation_max:parseFloat(f.compensation_max.value)||null,description:f.description.value,location_text:f.location_text.value,skills:f.skills.value.split(',').map(s=>s.trim()).filter(Boolean),referral_url:f.referral_url.value||null,status:'draft',slug:f.title.value.toLowerCase().replace(/[^a-z0-9]+/g,'-')})});location.reload()}</script></body></html>`;
}

export default router;
