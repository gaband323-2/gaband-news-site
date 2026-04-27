const CATEGORIES = [
  "general",
  "business",
  "technology",
  "entertainment",
  "health",
  "science",
  "sports"
];

const COOKIE_NAME = "gaband323_news_session";

export default {
  async fetch(request, env, ctx) {
    try {
      await ensurePresetAdmin(env);

      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/") return homePage(request, env);
      if (path === "/login") return loginPage(request, env);
      if (path === "/signup") return signupPage(request, env);
      if (path === "/logout") return logout(request, env);
      if (path === "/code-login") return codeLoginPage(request, env);
      if (path.startsWith("/article/")) return articlePage(request, env);

      if (path === "/admin") return adminPage(request, env);
      if (path === "/admin/sync") return adminSync(request, env);
      if (path === "/admin/digest") return adminSendDigest(request, env);
      if (path === "/admin/article/save") return adminSaveArticle(request, env);
      if (path === "/admin/article/delete") return adminDeleteArticle(request, env);
      if (path === "/admin/user/save") return adminSaveUser(request, env);
      if (path === "/admin/user/delete") return adminDeleteUser(request, env);
      if (path === "/admin/code/save") return adminSaveCode(request, env);
      if (path === "/admin/code/delete") return adminDeleteCode(request, env);

      if (path === "/subscribe") return subscribePage(request, env);
      if (path === "/api/news/sync") return apiSync(request, env);
      if (path === "/api/articles") return apiArticles(request, env);

      return htmlPage("Not Found", `<h1>404</h1><p>That page does not exist.</p>`, env, 404);
    } catch (err) {
      return htmlPage(
        "Error",
        `<h1>Something broke</h1><pre>${escapeHtml(err.stack || err.message || String(err))}</pre>`,
        env,
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env));
  }
};

async function runScheduled(event, env) {
  await ensurePresetAdmin(env);

  if (event.cron && event.cron.includes("0 14")) {
    await sendDigest(env);
    return;
  }

  await runNewsSync(env);
}

async function homePage(request, env) {
  const url = new URL(request.url);
  const category = cleanCategory(url.searchParams.get("category") || "general");
  const q = (url.searchParams.get("q") || "").trim();

  let sql = `
    SELECT *
    FROM articles
    WHERE 1=1
  `;
  const params = [];

  if (category && category !== "all") {
    sql += ` AND category = ?`;
    params.push(category);
  }

  if (q) {
    sql += ` AND (title LIKE ? OR description LIKE ? OR topic LIKE ? OR source_name LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  sql += ` ORDER BY COALESCE(published_at, created_at) DESC LIMIT 60`;

  const articles = await env.DB.prepare(sql).bind(...params).all();

  const articleCards = (articles.results || []).map(articleCard).join("") || `
    <div class="empty">
      <h2>No articles yet</h2>
      <p>Run a news sync from the admin page, or wait for the scheduled sync.</p>
    </div>
  `;

  const categoryLinks = ["all", ...CATEGORIES].map(c => {
    const active = c === category ? "active" : "";
    return `<a class="chip ${active}" href="/?category=${encodeURIComponent(c)}">${escapeHtml(label(c))}</a>`;
  }).join("");

  return htmlPage("Home", `
    <section class="hero">
      <div>
        <p class="eyebrow">Auto-updating headlines</p>
        <h1>${escapeHtml(siteName(env))}</h1>
        <p>Top stories, categorized and synced automatically from NewsData.io.</p>
      </div>
      <div class="hero-actions">
        <a class="button" href="/subscribe">Email updates</a>
        <a class="button secondary" href="/admin">Admin</a>
      </div>
    </section>

    <form class="searchbar" method="GET" action="/">
      <input name="q" value="${escapeHtml(q)}" placeholder="Search articles, topics, sources..." />
      <input type="hidden" name="category" value="${escapeHtml(category)}" />
      <button>Search</button>
    </form>

    <nav class="chips">${categoryLinks}</nav>

    <main class="grid">
      ${articleCards}
    </main>
  `, env);
}

function articleCard(article) {
  const image = article.image_url
    ? `<img src="${escapeAttr(article.image_url)}" alt="" loading="lazy" />`
    : `<div class="no-image">${escapeHtml(article.category || "news")}</div>`;

  return `
    <article class="card">
      <a href="/article/${encodeURIComponent(article.id)}" class="image-link">${image}</a>
      <div class="card-body">
        <div class="meta">
          <span>${escapeHtml(label(article.category || "general"))}</span>
          <span>${escapeHtml(article.source_name || "Unknown source")}</span>
        </div>
        <h2><a href="/article/${encodeURIComponent(article.id)}">${escapeHtml(article.title)}</a></h2>
        <p>${escapeHtml(article.description || article.content || "No description available.")}</p>
        <div class="card-footer">
          <span>${escapeHtml(formatDate(article.published_at || article.created_at))}</span>
          ${article.topic ? `<span>#${escapeHtml(article.topic)}</span>` : ""}
        </div>
      </div>
    </article>
  `;
}

async function articlePage(request, env) {
  const id = decodeURIComponent(new URL(request.url).pathname.replace("/article/", ""));
  const article = await env.DB.prepare(`SELECT * FROM articles WHERE id = ?`).bind(id).first();

  if (!article) {
    return htmlPage("Article not found", `<h1>Article not found</h1><p>This article does not exist.</p>`, env, 404);
  }

  const image = article.image_url
    ? `<img class="article-image" src="${escapeAttr(article.image_url)}" alt="" />`
    : "";

  return htmlPage(article.title, `
    <article class="article-page">
      <a href="/" class="back">← Back to news</a>
      <p class="eyebrow">${escapeHtml(label(article.category || "general"))} · ${escapeHtml(article.source_name || "Unknown source")}</p>
      <h1>${escapeHtml(article.title)}</h1>
      <p class="article-date">${escapeHtml(formatDate(article.published_at || article.created_at))}</p>
      ${image}
      <p class="lead">${escapeHtml(article.description || "")}</p>
      <div class="article-content">
        ${paragraphs(article.content || article.description || "No full article text was provided by the news API. Open the original source for the full story.")}
      </div>
      ${article.url ? `<a class="button" href="${escapeAttr(article.url)}" target="_blank" rel="noopener noreferrer">Open original source</a>` : ""}
    </article>
  `, env);
}

async function loginPage(request, env) {
  if (request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");

    const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();

    if (!user) {
      return htmlPage("Login", loginForm("Invalid email or password."), env, 401);
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return htmlPage("Login", loginForm("Invalid email or password."), env, 401);
    }

    return createSessionResponse(env, user.id, "/admin");
  }

  return htmlPage("Login", loginForm(), env);
}

function loginForm(error = "") {
  return `
    <section class="auth">
      <h1>Login</h1>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <form method="POST" action="/login">
        <label>Email</label>
        <input name="email" type="email" required />
        <label>Password</label>
        <input name="password" type="password" required />
        <button>Login</button>
      </form>
      <p><a href="/code-login">Use a login code instead</a></p>
    </section>
  `;
}

async function signupPage(request, env) {
  if (request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");

    if (!email || !password || password.length < 8) {
      return htmlPage("Signup", signupForm("Use a valid email and an 8+ character password."), env, 400);
    }

    const role = isAdminEmail(env, email) ? "admin" : "user";
    const id = crypto.randomUUID();
    const hash = await hashPassword(password);

    try {
      await env.DB.prepare(`
        INSERT INTO users (id, email, password_hash, role)
        VALUES (?, ?, ?, ?)
      `).bind(id, email, hash, role).run();

      return createSessionResponse(env, id, role === "admin" ? "/admin" : "/");
    } catch (e) {
      return htmlPage("Signup", signupForm("That email may already be registered."), env, 400);
    }
  }

  return htmlPage("Signup", signupForm(), env);
}

function signupForm(error = "") {
  return `
    <section class="auth">
      <h1>Create account</h1>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <form method="POST" action="/signup">
        <label>Email</label>
        <input name="email" type="email" required />
        <label>Password</label>
        <input name="password" type="password" minlength="8" required />
        <button>Sign up</button>
      </form>
      <p><a href="/login">Already have an account?</a></p>
    </section>
  `;
}

async function codeLoginPage(request, env) {
  if (request.method === "POST") {
    const form = await request.formData();
    const code = String(form.get("code") || "").trim();

    const record = await env.DB.prepare(`
      SELECT * FROM login_codes
      WHERE code = ?
    `).bind(code).first();

    if (!record) {
      return htmlPage("Code Login", codeLoginForm("Invalid code."), env, 401);
    }

    if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
      return htmlPage("Code Login", codeLoginForm("This code has expired."), env, 401);
    }

    if (Number(record.uses || 0) >= Number(record.max_uses || 1)) {
      return htmlPage("Code Login", codeLoginForm("This code has already been used."), env, 401);
    }

    const email = `code-${crypto.randomUUID().slice(0, 8)}@local.gaband323.dev`;
    const passwordHash = await hashPassword(crypto.randomUUID());
    const userId = crypto.randomUUID();
    const role = Number(record.is_admin) === 1 ? "admin" : "user";

    await env.DB.prepare(`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).bind(userId, email, passwordHash, role).run();

    await env.DB.prepare(`
      UPDATE login_codes
      SET uses = uses + 1
      WHERE id = ?
    `).bind(record.id).run();

    return createSessionResponse(env, userId, role === "admin" ? "/admin" : "/");
  }

  return htmlPage("Code Login", codeLoginForm(), env);
}

function codeLoginForm(error = "") {
  return `
    <section class="auth">
      <h1>Login with code</h1>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <form method="POST" action="/code-login">
        <label>Login code</label>
        <input name="code" required />
        <button>Continue</button>
      </form>
      <p><a href="/login">Use email/password instead</a></p>
    </section>
  `;
}

async function logout(request, env) {
  const cookie = getCookie(request, COOKIE_NAME);

  if (cookie) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(cookie).run();
  }

  return redirect("/", {
    "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  });
}

async function adminPage(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const articles = await env.DB.prepare(`
    SELECT *
    FROM articles
    ORDER BY COALESCE(published_at, created_at) DESC
    LIMIT 40
  `).all();

  const users = await env.DB.prepare(`
    SELECT id, email, role, created_at
    FROM users
    ORDER BY created_at DESC
    LIMIT 100
  `).all();

  const codes = await env.DB.prepare(`
    SELECT *
    FROM login_codes
    ORDER BY created_at DESC
    LIMIT 100
  `).all();

  return htmlPage("Admin", `
    <section class="admin-head">
      <div>
        <p class="eyebrow">Admin dashboard</p>
        <h1>${escapeHtml(siteName(env))}</h1>
        <p>Logged in as ${escapeHtml(user.email)}</p>
      </div>
      <div class="hero-actions">
        <form method="POST" action="/admin/sync"><button>Sync news now</button></form>
        <form method="POST" action="/admin/digest"><button class="secondary">Send digest now</button></form>
      </div>
    </section>

    <section class="panel">
      <h2>Add / update article</h2>
      <form method="POST" action="/admin/article/save" class="stack">
        <input name="id" placeholder="Optional ID. Leave blank for new article." />
        <input name="title" placeholder="Title" required />
        <input name="description" placeholder="Description" />
        <textarea name="content" placeholder="Article content"></textarea>
        <input name="url" placeholder="Original source URL" />
        <input name="image_url" placeholder="Image URL" />
        <input name="source_name" placeholder="Source name" />
        <input name="author" placeholder="Author" />
        <select name="category">${CATEGORIES.map(c => `<option value="${c}">${label(c)}</option>`).join("")}</select>
        <input name="topic" placeholder="Topic/tag" />
        <button>Save article</button>
      </form>
    </section>

    <section class="panel">
      <h2>Articles</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Title</th><th>Category</th><th>Source</th><th></th></tr></thead>
          <tbody>
            ${(articles.results || []).map(a => `
              <tr>
                <td><a href="/article/${encodeURIComponent(a.id)}">${escapeHtml(a.title)}</a></td>
                <td>${escapeHtml(a.category)}</td>
                <td>${escapeHtml(a.source_name || "")}</td>
                <td>
                  <form method="POST" action="/admin/article/delete">
                    <input type="hidden" name="id" value="${escapeAttr(a.id)}" />
                    <button class="danger">Delete</button>
                  </form>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Add / update account</h2>
      <form method="POST" action="/admin/user/save" class="stack">
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password. Leave blank to keep existing password." />
        <select name="role">
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button>Save user</button>
      </form>
    </section>

    <section class="panel">
      <h2>Accounts</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${(users.results || []).map(u => `
              <tr>
                <td>${escapeHtml(u.email)}</td>
                <td>${escapeHtml(u.role)}</td>
                <td>${escapeHtml(formatDate(u.created_at))}</td>
                <td>
                  <form method="POST" action="/admin/user/delete">
                    <input type="hidden" name="id" value="${escapeAttr(u.id)}" />
                    <button class="danger">Delete</button>
                  </form>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Create login code</h2>
      <form method="POST" action="/admin/code/save" class="stack">
        <input name="code" placeholder="Code. Leave blank to generate one." />
        <label><input type="checkbox" name="is_admin" value="1" /> Admin code</label>
        <input name="max_uses" type="number" min="1" value="1" />
        <input name="expires_at" type="datetime-local" />
        <button>Create code</button>
      </form>
    </section>

    <section class="panel">
      <h2>Login codes</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Code</th><th>Admin?</th><th>Uses</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            ${(codes.results || []).map(c => `
              <tr>
                <td><code>${escapeHtml(c.code)}</code></td>
                <td>${Number(c.is_admin) === 1 ? "Yes" : "No"}</td>
                <td>${escapeHtml(String(c.uses))}/${escapeHtml(String(c.max_uses))}</td>
                <td>${escapeHtml(c.expires_at || "Never")}</td>
                <td>
                  <form method="POST" action="/admin/code/delete">
                    <input type="hidden" name="id" value="${escapeAttr(c.id)}" />
                    <button class="danger">Delete</button>
                  </form>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `, env);
}

async function adminSync(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const result = await runNewsSync(env);
  return htmlPage("Sync complete", `
    <h1>Sync complete</h1>
    <pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
    <p><a href="/admin">Back to admin</a></p>
  `, env);
}

async function adminSendDigest(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const result = await sendDigest(env);
  return htmlPage("Digest", `
    <h1>Digest send attempted</h1>
    <pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
    <p><a href="/admin">Back to admin</a></p>
  `, env);
}

async function adminSaveArticle(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const form = await request.formData();
  const id = String(form.get("id") || "").trim() || crypto.randomUUID();

  const article = {
    id,
    title: String(form.get("title") || "").trim(),
    description: String(form.get("description") || "").trim(),
    content: String(form.get("content") || "").trim(),
    url: String(form.get("url") || "").trim(),
    image_url: String(form.get("image_url") || "").trim(),
    source_name: String(form.get("source_name") || "").trim(),
    author: String(form.get("author") || "").trim(),
    category: cleanCategory(String(form.get("category") || "general")),
    topic: String(form.get("topic") || "").trim(),
    published_at: new Date().toISOString(),
    is_manual: 1
  };

  if (!article.title) {
    return htmlPage("Missing title", `<h1>Missing title</h1><p>Article title is required.</p>`, env, 400);
  }

  await env.DB.prepare(`
    INSERT INTO articles (
      id, title, description, content, url, image_url, source_name, author,
      category, topic, published_at, is_manual
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      content = excluded.content,
      url = excluded.url,
      image_url = excluded.image_url,
      source_name = excluded.source_name,
      author = excluded.author,
      category = excluded.category,
      topic = excluded.topic,
      published_at = excluded.published_at,
      is_manual = excluded.is_manual
  `).bind(
    article.id,
    article.title,
    article.description,
    article.content,
    article.url,
    article.image_url,
    article.source_name,
    article.author,
    article.category,
    article.topic,
    article.published_at,
    article.is_manual
  ).run();

  return redirect("/admin");
}

async function adminDeleteArticle(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const form = await request.formData();
  const id = String(form.get("id") || "");
  await env.DB.prepare(`DELETE FROM articles WHERE id = ?`).bind(id).run();

  return redirect("/admin");
}

async function adminSaveUser(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  const role = String(form.get("role") || "user") === "admin" ? "admin" : "user";

  if (!email) return redirect("/admin");

  const existing = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();

  if (existing) {
    if (password) {
      const hash = await hashPassword(password);
      await env.DB.prepare(`
        UPDATE users
        SET role = ?, password_hash = ?
        WHERE email = ?
      `).bind(role, hash, email).run();
    } else {
      await env.DB.prepare(`
        UPDATE users
        SET role = ?
        WHERE email = ?
      `).bind(role, email).run();
    }
  } else {
    if (!password || password.length < 8) {
      return htmlPage("Password required", `<h1>Password required</h1><p>New users need an 8+ character password.</p><p><a href="/admin">Back</a></p>`, env, 400);
    }

    const hash = await hashPassword(password);
    await env.DB.prepare(`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).bind(crypto.randomUUID(), email, hash, role).run();
  }

  return redirect("/admin");
}

async function adminDeleteUser(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const form = await request.formData();
  const id = String(form.get("id") || "");

  if (id === admin.id) {
    return htmlPage("Cannot delete yourself", `<h1>Nope</h1><p>You cannot delete your own account while logged in.</p><p><a href="/admin">Back</a></p>`, env, 400);
  }

  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();

  return redirect("/admin");
}

async function adminSaveCode(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const form = await request.formData();
  const code = String(form.get("code") || "").trim() || generateCode();
  const isAdmin = form.get("is_admin") === "1" ? 1 : 0;
  const maxUses = Math.max(1, Number(form.get("max_uses") || 1));
  const expiresRaw = String(form.get("expires_at") || "").trim();
  const expiresAt = expiresRaw ? new Date(expiresRaw).toISOString() : null;

  await env.DB.prepare(`
    INSERT INTO login_codes (code, is_admin, max_uses, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).bind(code, isAdmin, maxUses, expiresAt, user.id).run();

  return redirect("/admin");
}

async function adminDeleteCode(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const form = await request.formData();
  const id = String(form.get("id") || "");
  await env.DB.prepare(`DELETE FROM login_codes WHERE id = ?`).bind(id).run();

  return redirect("/admin");
}

async function subscribePage(request, env) {
  if (request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    const categories = form.getAll("categories").map(String).map(cleanCategory).filter(Boolean).join(",");

    if (!email) {
      return htmlPage("Subscribe", subscribeForm("Enter a valid email."), env, 400);
    }

    await env.DB.prepare(`
      INSERT INTO subscriptions (id, email, categories, verified)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(email) DO UPDATE SET
        categories = excluded.categories,
        verified = 1
    `).bind(crypto.randomUUID(), email, categories || CATEGORIES.join(",")).run();

    return htmlPage("Subscribed", `
      <section class="auth">
        <h1>You’re subscribed</h1>
        <p>You’ll get updates from ${escapeHtml(siteName(env))}.</p>
        <p><a href="/">Back to news</a></p>
      </section>
    `, env);
  }

  return htmlPage("Subscribe", subscribeForm(), env);
}

function subscribeForm(error = "") {
  return `
    <section class="auth">
      <h1>Email updates</h1>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <form method="POST" action="/subscribe">
        <label>Email</label>
        <input name="email" type="email" required />
        <label>Categories</label>
        <div class="checks">
          ${CATEGORIES.map(c => `
            <label><input type="checkbox" name="categories" value="${c}" checked /> ${label(c)}</label>
          `).join("")}
        </div>
        <button>Subscribe</button>
      </form>
    </section>
  `;
}

async function apiSync(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return json({ ok: false, error: "Unauthorized" }, 401);

  const result = await runNewsSync(env);
  return json(result);
}

async function apiArticles(request, env) {
  const url = new URL(request.url);
  const category = cleanCategory(url.searchParams.get("category") || "general");

  let q = `
    SELECT *
    FROM articles
  `;
  const params = [];

  if (category && category !== "all") {
    q += ` WHERE category = ?`;
    params.push(category);
  }

  q += ` ORDER BY COALESCE(published_at, created_at) DESC LIMIT 50`;

  const result = await env.DB.prepare(q).bind(...params).all();
  return json({ ok: true, articles: result.results || [] });
}

async function runNewsSync(env) {
  if (!env.NEWS_API_KEY) {
    return { ok: false, error: "Missing NEWS_API_KEY secret" };
  }

  const categories = splitEnv(env.FETCH_CATEGORIES || CATEGORIES.join(","))
    .map(cleanCategory)
    .filter(Boolean);

  let inserted = 0;
  let updated = 0;
  const failed = [];

  const newsDataCategoryMap = {
    general: "top",
    business: "business",
    technology: "technology",
    entertainment: "entertainment",
    health: "health",
    science: "science",
    sports: "sports"
  };

  for (const category of categories) {
    const endpoint = new URL("https://newsdata.io/api/1/latest");
    endpoint.searchParams.set("apikey", env.NEWS_API_KEY);
    endpoint.searchParams.set("country", env.NEWS_COUNTRY || "us");
    endpoint.searchParams.set("language", env.NEWS_LANG || "en");
    endpoint.searchParams.set("category", newsDataCategoryMap[category] || "top");

    try {
      const data = await fetchJson(endpoint.toString());

      if (data.status && data.status !== "success") {
        throw new Error(data.message || data.results?.message || "NewsData.io returned an error");
      }

      for (const item of data.results || []) {
        const didInsert = await saveNewsDataArticle(env, item, category, "");
        if (didInsert === "inserted") inserted++;
        if (didInsert === "updated") updated++;
      }
    } catch (e) {
      failed.push({ category, error: e.message });
    }
  }

  for (const query of splitEnv(env.TRENDING_QUERIES || "")) {
    const endpoint = new URL("https://newsdata.io/api/1/latest");
    endpoint.searchParams.set("apikey", env.NEWS_API_KEY);
    endpoint.searchParams.set("language", env.NEWS_LANG || "en");
    endpoint.searchParams.set("q", query);

    if (env.NEWS_COUNTRY) {
      endpoint.searchParams.set("country", env.NEWS_COUNTRY);
    }

    try {
      const data = await fetchJson(endpoint.toString());

      if (data.status && data.status !== "success") {
        throw new Error(data.message || data.results?.message || "NewsData.io returned an error");
      }

      for (const item of data.results || []) {
        const text = `${item.title || ""} ${item.description || ""}`;
        const category = cleanCategory(classifyCategory(text)) || "general";
        const didInsert = await saveNewsDataArticle(env, item, category, query);
        if (didInsert === "inserted") inserted++;
        if (didInsert === "updated") updated++;
      }
    } catch (e) {
      failed.push({ topic: query, error: e.message });
    }
  }

  return {
    ok: failed.length === 0,
    provider: "newsdata.io",
    inserted,
    updated,
    failed
  };
}

async function saveNewsDataArticle(env, item, category, topicOverride = "") {
  const title = item.title || "";
  const articleUrl = item.link || item.url || "";

  if (!title || !articleUrl || title === "[Removed]") return "skipped";

  const existing = await env.DB.prepare(`SELECT id FROM articles WHERE url = ?`).bind(articleUrl).first();

  const id = existing?.id || crypto.randomUUID();
  const description = item.description || item.content || "";
  const content = item.content || item.description || "";
  const sourceName = item.source_name || item.source_id || item.source_url || "NewsData.io";
  const author = Array.isArray(item.creator)
    ? item.creator.filter(Boolean).join(", ")
    : item.creator || "";
  const imageUrl = item.image_url || "";
  const topic = topicOverride || inferTopic(`${title} ${description}`) || "";
  const publishedAt = item.pubDate || item.pubDateTZ || new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO articles (
      id, title, description, content, url, image_url, source_name, author,
      category, topic, published_at, is_manual
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      content = excluded.content,
      image_url = excluded.image_url,
      source_name = excluded.source_name,
      author = excluded.author,
      category = excluded.category,
      topic = excluded.topic,
      published_at = excluded.published_at
  `).bind(
    id,
    title,
    description,
    content,
    articleUrl,
    imageUrl,
    sourceName,
    author,
    cleanCategory(category) || "general",
    topic,
    publishedAt
  ).run();

  return existing ? "updated" : "inserted";
}

async function sendDigest(env) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: "Missing RESEND_API_KEY secret" };
  }

  const subs = await env.DB.prepare(`
    SELECT *
    FROM subscriptions
    WHERE verified = 1
    LIMIT 200
  `).all();

  const articles = await env.DB.prepare(`
    SELECT *
    FROM articles
    ORDER BY COALESCE(published_at, created_at) DESC
    LIMIT 10
  `).all();

  if (!subs.results?.length) {
    return { ok: true, sent: 0, message: "No subscribers." };
  }

  const articleList = (articles.results || []).map(a => `
    <li>
      <a href="${escapeAttr(siteOrigin(env))}/article/${encodeURIComponent(a.id)}">${escapeHtml(a.title)}</a>
      <br><small>${escapeHtml(a.source_name || "")} · ${escapeHtml(label(a.category || "general"))}</small>
    </li>
  `).join("");

  let sent = 0;
  const failed = [];

  for (const sub of subs.results) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || "Gaband323 News <updates@news.gaband323.dev>",
          to: sub.email,
          subject: env.DIGEST_SUBJECT || "Your Gaband323 News Update",
          html: `
            <h1>${escapeHtml(siteName(env))}</h1>
            <p>Here are the latest headlines.</p>
            <ul>${articleList}</ul>
            <p><a href="${escapeAttr(siteOrigin(env))}">Open ${escapeHtml(siteName(env))}</a></p>
          `
        })
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      sent++;
    } catch (e) {
      failed.push({ email: sub.email, error: e.message });
    }
  }

  return { ok: failed.length === 0, sent, failed };
}

async function ensurePresetAdmin(env) {
  try {
    if (!env.DB) return;
    if (!env.ADMIN_PRESET_EMAIL || !env.ADMIN_PRESET_PASSWORD) return;

    const email = String(env.ADMIN_PRESET_EMAIL).trim().toLowerCase();
    const password = String(env.ADMIN_PRESET_PASSWORD);

    if (!email || !password) return;

    const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();

    if (existing) {
      await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).bind(email).run();
      return;
    }

    const hash = await hashPassword(password);

    await env.DB.prepare(`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).bind(crypto.randomUUID(), email, hash).run();
  } catch (e) {
    console.error("ensurePresetAdmin failed:", e && e.stack ? e.stack : e);
  }
}
async function requireAdmin(request, env) {
  const user = await getCurrentUser(request, env);

  if (!user || user.role !== "admin") {
    return redirect("/login");
  }

  return user;
}

async function getCurrentUser(request, env) {
  const sessionId = getCookie(request, COOKIE_NAME);
  if (!sessionId) return null;

  const row = await env.DB.prepare(`
    SELECT users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
  `).bind(sessionId, new Date().toISOString()).first();

  return row || null;
}

async function createSessionResponse(env, userId, location) {
  const sessionId = crypto.randomUUID();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(sessionId, userId, expires.toISOString()).run();

  return redirect(location, {
    "Set-Cookie": `${COOKIE_NAME}=${sessionId}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`
  });
}

async function hashPassword(password) {
  const salt = crypto.randomUUID();
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `${salt}:${arrayBufferToHex(digest)}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return arrayBufferToHex(digest) === hash;
}

function arrayBufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Gaband323News/1.0"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

function classifyCategory(text) {
  const t = text.toLowerCase();

  if (/\b(ai|tech|software|cloudflare|roblox|discord|app|cyber|security|data|computer)\b/.test(t)) return "technology";
  if (/\b(stock|market|business|company|economy|bank|money|retail|price)\b/.test(t)) return "business";
  if (/\b(movie|music|game|celebrity|tv|streaming|entertainment)\b/.test(t)) return "entertainment";
  if (/\b(health|doctor|hospital|virus|medical|medicine|disease|fitness)\b/.test(t)) return "health";
  if (/\b(science|space|nasa|climate|research|study|physics|biology)\b/.test(t)) return "science";
  if (/\b(sports|nba|nfl|mlb|soccer|football|baseball|basketball|olympic)\b/.test(t)) return "sports";

  return "general";
}

function inferTopic(text) {
  const t = text.toLowerCase();

  if (t.includes("cloudflare")) return "Cloudflare";
  if (t.includes("roblox")) return "Roblox";
  if (t.includes("discord")) return "Discord";
  if (t.includes("artificial intelligence") || t.includes(" ai ")) return "AI";
  if (t.includes("los angeles")) return "Los Angeles";
  if (t.includes("california")) return "California";
  if (t.includes("election")) return "Election";
  if (t.includes("security")) return "Security";

  return "";
}

function splitEnv(value) {
  return String(value || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function cleanCategory(value) {
  const c = String(value || "").toLowerCase().trim();

  if (c === "tech") return "technology";
  if (c === "top") return "general";
  if (c === "all") return "all";
  if (CATEGORIES.includes(c)) return c;

  return "general";
}

function isAdminEmail(env, email) {
  return splitEnv(env.ADMIN_EMAILS || "")
    .map(e => e.toLowerCase())
    .includes(String(email || "").toLowerCase());
}

function generateCode() {
  return `GABAND-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const parts = cookie.split(";").map(c => c.trim());

  for (const part of parts) {
    const [k, ...v] = part.split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }

  return "";
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers
    }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function htmlPage(title, body, env, status = 200) {
  const name = siteName(env);

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · ${escapeHtml(name)}</title>
  <style>
    :root {
      --bg: #09090b;
      --panel: #111114;
      --panel2: #18181b;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --border: #27272a;
      --brand: #4ade80;
      --danger: #fb7185;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0
