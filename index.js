const CATEGORIES = ['general', 'business', 'technology', 'entertainment', 'health', 'science', 'sports'];
const DIGEST_CRON = '0 14 * * *';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api/')) return apiRouter(request, env, ctx);
      if (url.pathname === '/admin') return html(adminPage(), env);
      if (url.pathname === '/login') return html(loginPage(), env);
      if (url.pathname === '/signup') return html(signupPage(), env);
      if (url.pathname === '/subscribe') return html(subscribePage(), env);
      return html(homePage(), env);
    } catch (error) {
      console.error(error);
      return json({ error: error.status ? error.message : 'Server error', details: error.status ? undefined : error.message }, error.status || 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runNewsSync(env));
    if (controller.cron === DIGEST_CRON) ctx.waitUntil(sendDailyDigests(env));
  }
};

async function apiRouter(request, env, ctx) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'GET' && url.pathname === '/api/articles') {
    const category = cleanCategory(url.searchParams.get('category'));
    const q = (url.searchParams.get('q') || '').trim();
    const limit = clamp(Number(url.searchParams.get('limit') || 40), 1, 100);
    const params = [];
    let where = 'WHERE is_deleted = 0';
    if (category) { where += ' AND category = ?'; params.push(category); }
    if (q) { where += ' AND (title LIKE ? OR description LIKE ? OR topic LIKE ? OR source LIKE ?)'; params.push(...Array(4).fill(`%${q}%`)); }
    const rows = await env.DB.prepare(`SELECT * FROM articles ${where} ORDER BY is_pinned DESC, COALESCE(published_at, created_at) DESC LIMIT ?`).bind(...params, limit).all();
    return json({ articles: rows.results || [] });
  }

  if (method === 'GET' && url.pathname === '/api/topics') {
    const rows = await env.DB.prepare(`SELECT topic, COUNT(*) AS count FROM articles WHERE is_deleted = 0 AND topic IS NOT NULL AND topic != '' GROUP BY topic ORDER BY count DESC LIMIT 25`).all();
    return json({ topics: rows.results || [] });
  }

  if (method === 'POST' && url.pathname === '/api/subscribe') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!email) return json({ error: 'Valid email required' }, 400);
    const categories = Array.isArray(body.categories) ? body.categories.map(cleanCategory).filter(Boolean) : CATEGORIES;
    await env.DB.prepare(`INSERT INTO subscribers(email, categories, frequency) VALUES(?, ?, 'daily') ON CONFLICT(email) DO UPDATE SET categories = excluded.categories`).bind(email, categories.join(',')).run();
    return json({ ok: true });
  }

  if (method === 'POST' && url.pathname === '/api/signup') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!email || password.length < 8) return json({ error: 'Email and 8+ character password required' }, 400);
    const isAdmin = adminList(env).includes(email) ? 1 : 0;
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(`INSERT INTO users(email, password_hash, is_admin) VALUES(?, ?, ?) ON CONFLICT(email) DO NOTHING`).bind(email, passwordHash, isAdmin).run();
    const cookie = await createSessionCookie(email, isAdmin, env);
    return json({ ok: true, is_admin: Boolean(isAdmin) }, 200, { 'Set-Cookie': cookie });
  }

  if (method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) return json({ error: 'Invalid login' }, 401);
    const shouldBeAdmin = adminList(env).includes(email) ? 1 : Number(user.is_admin || 0);
    if (shouldBeAdmin !== Number(user.is_admin || 0)) await env.DB.prepare(`UPDATE users SET is_admin = ? WHERE email = ?`).bind(shouldBeAdmin, email).run();
    const cookie = await createSessionCookie(email, shouldBeAdmin, env);
    return json({ ok: true, is_admin: Boolean(shouldBeAdmin) }, 200, { 'Set-Cookie': cookie });
  }

  if (method === 'POST' && url.pathname === '/api/logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': `gn_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
  }

  if (method === 'GET' && url.pathname === '/api/me') {
    const session = await requireSession(request, env, false);
    return json({ user: session });
  }

  if (method === 'POST' && url.pathname === '/api/admin/sync') {
    await requireSession(request, env, true);
    const result = await runNewsSync(env);
    return json(result);
  }

  if (method === 'POST' && url.pathname === '/api/admin/digest') {
    await requireSession(request, env, true);
    const result = await sendDailyDigests(env);
    return json(result);
  }

  if (method === 'POST' && url.pathname === '/api/admin/articles') {
    const session = await requireSession(request, env, true);
    const b = await readJson(request);
    const category = cleanCategory(b.category) || 'general';
    const title = String(b.title || '').trim();
    const urlValue = String(b.url || '').trim();
    if (!title || !isProbablyUrl(urlValue)) return json({ error: 'Title and valid URL required' }, 400);
    await env.DB.prepare(`INSERT INTO articles(title, description, content, url, image_url, source, author, category, topic, published_at, added_by, is_pinned) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, image_url=excluded.image_url, source=excluded.source, category=excluded.category, topic=excluded.topic, updated_at=CURRENT_TIMESTAMP, is_deleted=0`).bind(title, b.description || '', b.content || '', urlValue, b.image_url || '', b.source || 'Manual', b.author || '', category, b.topic || inferTopic(title + ' ' + (b.description || '')), b.published_at || new Date().toISOString(), session.email, b.is_pinned ? 1 : 0).run();
    return json({ ok: true });
  }

  if (method === 'DELETE' && url.pathname.startsWith('/api/admin/articles/')) {
    await requireSession(request, env, true);
    const id = Number(url.pathname.split('/').pop());
    if (!Number.isFinite(id)) return json({ error: 'Bad article id' }, 400);
    await env.DB.prepare(`UPDATE articles SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

async function runNewsSync(env) {
  if (!env.NEWS_API_KEY) return { ok: false, error: 'Missing NEWS_API_KEY secret' };
  const categories = splitEnv(env.FETCH_CATEGORIES || CATEGORIES.join(',')).map(cleanCategory).filter(Boolean);
  let inserted = 0, updated = 0, failed = [];

  for (const category of categories) {
    const endpoint = new URL('https://newsapi.org/v2/top-headlines');
    endpoint.searchParams.set('country', env.NEWS_COUNTRY || 'us');
    endpoint.searchParams.set('category', category);
    endpoint.searchParams.set('pageSize', '25');
    endpoint.searchParams.set('apiKey', env.NEWS_API_KEY);
    try {
      const data = await fetchJson(endpoint.toString());
      for (const item of data.articles || []) {
        if (!item.title || !item.url || item.title === '[Removed]') continue;
        const topic = inferTopic(`${item.title} ${item.description || ''}`);
        const result = await upsertArticle(env, {
          title: item.title,
          description: item.description || '',
          content: item.content || '',
          url: item.url,
          image_url: item.urlToImage || '',
          source: item.source?.name || '',
          author: item.author || '',
          category,
          topic,
          published_at: item.publishedAt || new Date().toISOString(),
          added_by: 'auto'
        });
        if (result.inserted) inserted++; else updated++;
      }
    } catch (e) { failed.push({ category, error: e.message }); }
  }

  for (const query of splitEnv(env.TRENDING_QUERIES || '')) {
    const endpoint = new URL('https://newsapi.org/v2/everything');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('language', env.NEWS_LANG || 'en');
    endpoint.searchParams.set('sortBy', 'publishedAt');
    endpoint.searchParams.set('pageSize', '10');
    endpoint.searchParams.set('apiKey', env.NEWS_API_KEY);
    try {
      const data = await fetchJson(endpoint.toString());
      for (const item of data.articles || []) {
        if (!item.title || !item.url || item.title === '[Removed]') continue;
        const category = classifyCategory(`${item.title} ${item.description || ''}`);
        const result = await upsertArticle(env, {
          title: item.title,
          description: item.description || '',
          content: item.content || '',
          url: item.url,
          image_url: item.urlToImage || '',
          source: item.source?.name || '',
          author: item.author || '',
          category,
          topic: query,
          published_at: item.publishedAt || new Date().toISOString(),
          added_by: 'auto-topic'
        });
        if (result.inserted) inserted++; else updated++;
      }
    } catch (e) { failed.push({ topic: query, error: e.message }); }
  }

  return { ok: failed.length === 0, inserted, updated, failed };
}

async function upsertArticle(env, a) {
  const existing = await env.DB.prepare(`SELECT id FROM articles WHERE url = ?`).bind(a.url).first();
  await env.DB.prepare(`INSERT INTO articles(title, description, content, url, image_url, source, author, category, topic, published_at, added_by) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, image_url=excluded.image_url, source=excluded.source, author=excluded.author, category=excluded.category, topic=excluded.topic, published_at=excluded.published_at, updated_at=CURRENT_TIMESTAMP, is_deleted=0`).bind(a.title, a.description, a.content, a.url, a.image_url, a.source, a.author, a.category, a.topic, a.published_at, a.added_by).run();
  return { inserted: !existing };
}

async function sendDailyDigests(env) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Missing RESEND_API_KEY secret' };
  const subscribers = (await env.DB.prepare(`SELECT * FROM subscribers WHERE verified = 1`).all()).results || [];
  let sent = 0, failed = 0;
  for (const sub of subscribers) {
    const cats = String(sub.categories || '').split(',').map(cleanCategory).filter(Boolean);
    const placeholders = cats.map(() => '?').join(',') || '?';
    const articles = (await env.DB.prepare(`SELECT * FROM articles WHERE is_deleted = 0 AND category IN (${placeholders}) ORDER BY COALESCE(published_at, created_at) DESC LIMIT 12`).bind(...(cats.length ? cats : ['general'])).all()).results || [];
    if (!articles.length) continue;
    const subject = env.DIGEST_SUBJECT || 'Your news update';
    const res = await sendEmail(env, sub.email, subject, digestHtml(env, articles));
    await env.DB.prepare(`INSERT INTO email_log(email, subject, article_count, status, response) VALUES(?, ?, ?, ?, ?)`).bind(sub.email, subject, articles.length, res.ok ? 'sent' : 'failed', JSON.stringify(res).slice(0, 1500)).run();
    if (res.ok) sent++; else failed++;
  }
  return { ok: failed === 0, sent, failed };
}

async function sendEmail(env, to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html })
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'gaband-news-site/1.0' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function homePage() { return `
<section class="hero"><div><p class="eyebrow">Auto-updating headlines</p><h1>Gaband News</h1><p>Top stories, topic feeds, categories, and email updates running fully on Cloudflare Workers.</p><div class="actions"><a href="/subscribe">Get email updates</a><a class="secondary" href="/admin">Admin</a></div></div></section>
<section class="toolbar"><input id="q" placeholder="Search news..."/><select id="cat"><option value="">All categories</option>${CATEGORIES.map(c=>`<option>${c}</option>`).join('')}</select></section>
<section id="topics" class="topics"></section><main id="articles" class="grid"></main>
<script>
const $ = s => document.querySelector(s);
async function load(){
 const qs = new URLSearchParams(); if($('#cat').value) qs.set('category',$('#cat').value); if($('#q').value) qs.set('q',$('#q').value);
 const data = await fetch('/api/articles?'+qs).then(r=>r.json());
 $('#articles').innerHTML = data.articles.map(articleCard).join('') || '<p class="muted">No articles yet. Run sync in admin.</p>';
 const topics = await fetch('/api/topics').then(r=>r.json());
 $('#topics').innerHTML = topics.topics.map(t=>'<button onclick="document.querySelector(\'#q\').value=\''+escapeHtml(t.topic)+'\';load()">#'+escapeHtml(t.topic)+' <span>'+t.count+'</span></button>').join('');
}
function articleCard(a){return '<article class="card">'+(a.image_url?'<img src="'+escapeAttr(a.image_url)+'" loading="lazy"/>':'')+'<div><span class="pill">'+escapeHtml(a.category)+'</span><h2><a href="'+escapeAttr(a.url)+'" target="_blank" rel="noreferrer">'+escapeHtml(a.title)+'</a></h2><p>'+escapeHtml(a.description||'')+'</p><footer>'+escapeHtml(a.source||'Unknown source')+' · '+(a.published_at?new Date(a.published_at).toLocaleString():'')+'</footer></div></article>'}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function escapeAttr(s){return escapeHtml(s).replace(new RegExp(String.fromCharCode(96),'g'),'&#96;')}
$('#q').addEventListener('input',()=>setTimeout(load,150)); $('#cat').addEventListener('change',load); load();
</script>`; }

function adminPage() { return `
<section class="hero small"><h1>Admin</h1><p>Sync, add, and remove stories. Only emails listed in <code>ADMIN_EMAILS</code> get admin powers after signup/login.</p></section>
<section id="auth" class="panel"><p>Checking login...</p></section>
<section id="admin" class="admin hidden">
 <div class="actions"><button onclick="syncNews()">Run news sync now</button><button onclick="sendDigest()">Send digest now</button><button class="secondary" onclick="logout()">Logout</button></div>
 <pre id="out"></pre>
 <form id="add" class="panel"><h2>Add article</h2><input name="title" placeholder="Title" required><input name="url" placeholder="https://article-url" required><input name="source" placeholder="Source"><select name="category">${CATEGORIES.map(c=>`<option>${c}</option>`).join('')}</select><textarea name="description" placeholder="Description"></textarea><input name="image_url" placeholder="Image URL"><button>Add / update article</button></form>
 <main id="articles" class="list"></main>
</section>
<script>
async function boot(){ const me=await fetch('/api/me').then(r=>r.ok?r.json():null); if(!me?.user){location.href='/login';return} if(!me.user.is_admin){document.querySelector('#auth').innerHTML='<p>You are logged in, but not an admin. Add your email to ADMIN_EMAILS and log in again.</p>';return} document.querySelector('#auth').classList.add('hidden'); document.querySelector('#admin').classList.remove('hidden'); load(); }
async function load(){ const data=await fetch('/api/articles?limit=100').then(r=>r.json()); document.querySelector('#articles').innerHTML=data.articles.map(a=>'<article class="row"><div><b>'+esc(a.title)+'</b><p>'+esc(a.category)+' · '+esc(a.source||'')+'</p></div><button onclick="del('+a.id+')">Delete</button></article>').join('') }
async function syncNews(){out('Syncing...'); out(JSON.stringify(await fetch('/api/admin/sync',{method:'POST'}).then(r=>r.json()),null,2)); load();}
async function sendDigest(){out('Sending...'); out(JSON.stringify(await fetch('/api/admin/digest',{method:'POST'}).then(r=>r.json()),null,2));}
async function del(id){ await fetch('/api/admin/articles/'+id,{method:'DELETE'}); load(); }
async function logout(){ await fetch('/api/logout',{method:'POST'}); location.href='/login'; }
document.querySelector('#add')?.addEventListener('submit',async e=>{e.preventDefault(); const b=Object.fromEntries(new FormData(e.target)); out(JSON.stringify(await fetch('/api/admin/articles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()),null,2)); e.target.reset(); load();});
function out(s){document.querySelector('#out').textContent=s} function esc(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))} boot();
</script>`; }

function loginPage() { return authShell('Login', '/api/login', 'Log in', 'Need an account? <a href="/signup">Sign up</a>'); }
function signupPage() { return authShell('Sign up', '/api/signup', 'Create account', 'Already have one? <a href="/login">Log in</a>'); }
function authShell(title, endpoint, button, foot) { return `<section class="authbox"><h1>${title}</h1><form id="f"><input name="email" type="email" placeholder="Email" required><input name="password" type="password" placeholder="Password" minlength="8" required><button>${button}</button></form><p>${foot}</p><pre id="out"></pre></section><script>f.onsubmit=async e=>{e.preventDefault();const b=Object.fromEntries(new FormData(f));const r=await fetch('${endpoint}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json(); if(r.ok) location.href=j.is_admin?'/admin':'/'; else out.textContent=j.error||'Error';}</script>`; }
function subscribePage() { return `<section class="authbox"><h1>Email updates</h1><p>Pick categories and get a daily digest.</p><form id="f"><input name="email" type="email" placeholder="Email" required><div class="checks">${CATEGORIES.map(c=>`<label><input type="checkbox" name="categories" value="${c}" checked> ${c}</label>`).join('')}</div><button>Subscribe</button></form><pre id="out"></pre></section><script>f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f);const b={email:fd.get('email'),categories:fd.getAll('categories')};const r=await fetch('/api/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});out.textContent=r.ok?'Subscribed. Nice.':(await r.text())}</script>`; }

function html(body, env) { return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtmlServer(env.SITE_NAME || 'Gaband News')}</title><style>${css()}</style></head><body><nav><a class="brand" href="/">${escapeHtmlServer(env.SITE_NAME || 'Gaband News')}</a><div><a href="/subscribe">Subscribe</a><a href="/admin">Admin</a></div></nav>${body}</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
function css(){return `:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#eef2ff;background:#09090b}body{margin:0;background:radial-gradient(circle at top left,#1f2937,#09090b 45%);min-height:100vh}nav{display:flex;justify-content:space-between;align-items:center;padding:18px 6vw;position:sticky;top:0;backdrop-filter:blur(14px);background:#09090bbd;border-bottom:1px solid #ffffff14;z-index:4}a{color:inherit}nav a{text-decoration:none;margin-left:16px}.brand{font-weight:900;margin-left:0}.hero{padding:70px 6vw 45px}.hero.small{padding:38px 6vw}.hero h1{font-size:clamp(42px,8vw,86px);line-height:.92;margin:0 0 18px}.hero p{color:#cbd5e1;font-size:18px;max-width:760px}.eyebrow{color:#93c5fd!important;text-transform:uppercase;letter-spacing:.16em;font-size:13px!important}.actions{display:flex;gap:12px;flex-wrap:wrap}.actions a,button{background:#60a5fa;color:#020617;border:0;border-radius:14px;padding:12px 16px;font-weight:800;text-decoration:none;cursor:pointer}.actions .secondary,button.secondary{background:#27272a;color:#fff}.toolbar{display:flex;gap:12px;padding:0 6vw 22px}input,select,textarea{width:100%;box-sizing:border-box;border:1px solid #ffffff1c;background:#111827;color:#fff;border-radius:14px;padding:13px}textarea{min-height:100px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:18px;padding:0 6vw 50px}.card,.panel,.authbox,.row{background:#0f172acc;border:1px solid #ffffff17;border-radius:24px;box-shadow:0 20px 70px #0008}.card{overflow:hidden}.card img{width:100%;height:180px;object-fit:cover;background:#111}.card div{padding:18px}.card h2{font-size:19px;line-height:1.2}.card p,.muted,footer{color:#cbd5e1}.pill{background:#1d4ed8;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:800}.topics{padding:0 6vw 18px;display:flex;gap:8px;flex-wrap:wrap}.topics button{background:#1f2937;color:#dbeafe;padding:8px 11px}.authbox{max-width:430px;margin:60px auto;padding:28px}.authbox h1{font-size:38px;margin-top:0}.panel{padding:22px;margin:20px 6vw}.admin{padding-bottom:60px}.hidden{display:none}.list{padding:0 6vw;display:grid;gap:12px}.row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px 18px}.checks{display:grid;gap:8px;margin:14px 0}pre{white-space:pre-wrap;color:#bfdbfe}`}
function digestHtml(env, articles){return `<div style="font-family:Arial,sans-serif;background:#f6f8fb;padding:24px"><div style="max-width:680px;margin:auto;background:white;border-radius:18px;padding:24px"><h1>${escapeHtmlServer(env.SITE_NAME || 'Gaband News')}</h1><p>Here are the latest stories.</p>${articles.map(a=>`<div style="border-top:1px solid #eee;padding:16px 0"><p style="font-size:12px;text-transform:uppercase;color:#2563eb;font-weight:bold">${escapeHtmlServer(a.category)}</p><h2><a href="${escapeHtmlServer(a.url)}">${escapeHtmlServer(a.title)}</a></h2><p>${escapeHtmlServer(a.description||'')}</p><small>${escapeHtmlServer(a.source||'')}</small></div>`).join('')}</div></div>`}

async function requireSession(request, env, mustAdmin = false) { const raw = getCookie(request, 'gn_session'); if (!raw) throw httpError('Not logged in', 401); const session = await verifySession(raw, env); if (!session) throw httpError('Bad session', 401); if (mustAdmin && !session.is_admin) throw httpError('Admin required', 403); return session; }
function getCookie(request, name){ const c=request.headers.get('cookie')||''; return c.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1); }
async function createSessionCookie(email, isAdmin, env){ const payload = b64url(JSON.stringify({ email, is_admin:Boolean(isAdmin), exp: Date.now()+1000*60*60*24*14 })); const sig = await hmac(payload, env.SESSION_SECRET || 'dev-secret-change-me'); return `gn_session=${payload}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60*60*24*14}`; }
async function verifySession(raw, env){ const [payload,sig]=String(raw).split('.'); if(!payload||!sig) return null; if(await hmac(payload, env.SESSION_SECRET || 'dev-secret-change-me') !== sig) return null; const obj=JSON.parse(atobUrl(payload)); if(obj.exp < Date.now()) return null; return obj; }
async function hmac(value, secret){ const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']); return b64urlBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))); }
async function hashPassword(password){ const salt=crypto.getRandomValues(new Uint8Array(16)); const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:120000,hash:'SHA-256'}, key, 256); return `pbkdf2$120000$${b64urlBytes(salt)}$${b64urlBytes(new Uint8Array(bits))}`; }
async function verifyPassword(password, stored){ const [alg,it,saltB,hashB]=String(stored).split('$'); if(alg!=='pbkdf2') return false; const salt=bytesFromB64url(saltB); const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:Number(it),hash:'SHA-256'}, key, 256); return b64urlBytes(new Uint8Array(bits))===hashB; }
function b64url(s){return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')} function atobUrl(s){return atob(s.replace(/-/g,'+').replace(/_/g,'/'))} function b64urlBytes(bytes){let s=''; bytes.forEach(b=>s+=String.fromCharCode(b)); return b64url(s)} function bytesFromB64url(s){return Uint8Array.from(atobUrl(s), c=>c.charCodeAt(0))}
function adminList(env){ return splitEnv(env.ADMIN_EMAILS || '').map(normalizeEmail).filter(Boolean); } function splitEnv(s){return String(s||'').split(',').map(x=>x.trim()).filter(Boolean)} function normalizeEmail(e){ e=String(e||'').trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)?e:'' } function cleanCategory(c){ c=String(c||'').toLowerCase().trim(); return CATEGORIES.includes(c)?c:'' } function clamp(n,min,max){return Math.max(min,Math.min(max,Number.isFinite(n)?n:min))} function isProbablyUrl(s){ try{const u=new URL(s); return ['http:','https:'].includes(u.protocol)}catch{return false} }
function classifyCategory(text){ text=text.toLowerCase(); if(/ai|tech|software|cloud|robot|cyber|apple|google|microsoft/.test(text))return'technology'; if(/stock|market|business|company|economy|inflation/.test(text))return'business'; if(/movie|music|celebrity|tv|game/.test(text))return'entertainment'; if(/health|doctor|hospital|virus|disease/.test(text))return'health'; if(/science|space|climate|research/.test(text))return'science'; if(/sport|nba|nfl|mlb|soccer/.test(text))return'sports'; return'general'; }
function inferTopic(text){ const t=String(text||'').toLowerCase(); const pairs=[['AI','ai|openai|anthropic|chatgpt|model'],['Cloudflare','cloudflare|workers|d1'],['Roblox','roblox|robux'],['Discord','discord'],['Transit','train|metro|transit|rail|amtrak'],['Politics','president|congress|election'],['Economy','market|stock|inflation'],['Weather','storm|weather|rain|heat'],['Entertainment','movie|music|tv']]; for(const [name,re] of pairs) if(new RegExp(re).test(t)) return name; return ''; }
function escapeHtmlServer(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function json(obj, status=200, headers={}){return new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json',...headers}})} async function readJson(req){return JSON.parse(await req.text()||'{}')} function httpError(message, status){ const e=new Error(message); e.status=status; return e; }
