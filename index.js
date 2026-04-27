const CATEGORIES = ["general", "business", "technology", "entertainment", "health", "science", "sports"];
const COOKIE_NAME = "gaband323_news_session";

export default {
  async fetch(request, env) {
    try {
      await ensureDatabase(env);
      await ensurePresetAdmin(env);

      env.__viewer = await currentUser(request, env).catch(() => null);

      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/") return home(request, env);
      if (path === "/health") return json({ ok: true });
      if (path === "/login") return login(request, env);
      if (path === "/signup") return signup(request, env);
      if (path === "/logout") return logout(request, env);
      if (path === "/settings") return settings(request, env);
      if (path === "/subscribe") return subscribe(request, env);
      if (path === "/article") return article(request, env);
      if (path === "/comment/add") return addComment(request, env);
      if (path === "/comment/delete") return deleteComment(request, env);

      if (path === "/admin") return admin(request, env);
      if (path === "/admin/sync") return adminSync(request, env);
      if (path === "/admin/article/add") return addArticle(request, env);
      if (path === "/admin/article/delete") return deleteArticle(request, env);
      if (path === "/admin/user/update") return adminUpdateUser(request, env);
      if (path === "/admin/user/delete") return adminDeleteUser(request, env);

      return page("Not found", "<h1>404</h1><p>That page does not exist.</p>", env, 404);
    } catch (err) {
      console.error(err);
      return page(
        "Error",
        `<h1>Something broke</h1><p class="error">${esc(err.message || String(err))}</p><pre>${esc(err.stack || "")}</pre>`,
        env,
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureDatabase(env);
      await ensurePresetAdmin(env);
      await runNewsSync(env);
    })());
  }
};

async function ensureDatabase(env) {
  if (!env.DB) throw new Error("Missing D1 binding named DB.");

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      can_comment INTEGER NOT NULL DEFAULT 1,
      email_updates INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      content TEXT,
      url TEXT,
      image_url TEXT,
      source_name TEXT,
      author TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      topic TEXT,
      published_at TEXT,
      is_manual INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url ON articles(url)`).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id)`).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      categories TEXT NOT NULL DEFAULT 'general,technology,business,science,health,sports,entertainment',
      verified INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS login_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function ensureUserSettings(env, userId, fallbackName = "") {
  if (!userId) return;

  const cleanName = String(fallbackName || "")
    .split("@")[0]
    .slice(0, 40) || "Reader";

  await env.DB.prepare(`
    INSERT INTO user_settings (user_id, display_name, can_comment, email_updates)
    VALUES (?, ?, 1, 1)
    ON CONFLICT(user_id) DO NOTHING
  `).bind(userId, cleanName).run();
}

async function ensurePresetAdmin(env) {
  if (!env.ADMIN_PRESET_EMAIL || !env.ADMIN_PRESET_PASSWORD) return;

  const email = String(env.ADMIN_PRESET_EMAIL).trim().toLowerCase();
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();

  if (existing) {
    await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).bind(email).run();
    await ensureUserSettings(env, existing.id, email);
    return;
  }

  const id = crypto.randomUUID();
  const hash = await hashPassword(String(env.ADMIN_PRESET_PASSWORD));

  await env.DB.prepare(`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (?, ?, ?, 'admin')
  `).bind(id, email, hash).run();

  await ensureUserSettings(env, id, email);
}

async function home(request, env) {
  const url = new URL(request.url);
  const category = cleanCategory(url.searchParams.get("category") || "general");

  let sql = `SELECT * FROM articles`;
  const params = [];

  if (category !== "all") {
    sql += ` WHERE category = ?`;
    params.push(category);
  }

  sql += ` ORDER BY COALESCE(published_at, created_at) DESC LIMIT 60`;

  const rows = await env.DB.prepare(sql).bind(...params).all();

  const cats = ["all", ...CATEGORIES].map(c => {
    return `<a class="chip" href="/?category=${esc(c)}">${esc(label(c))}</a>`;
  }).join("");

  const cards = (rows.results || []).map(a => `
    <article class="card">
      ${a.image_url ? `<img src="${esc(a.image_url)}" alt="">` : `<div class="noimg">${esc(a.category)}</div>`}
      <div class="pad">
        <p class="meta">${esc(label(a.category))} · ${esc(a.source_name || "Unknown source")}</p>
        <h2><a href="/article?id=${encodeURIComponent(a.id)}">${esc(a.title)}</a></h2>
        <p>${esc(a.description || "No description available.")}</p>
      </div>
    </article>
  `).join("");

  return page("Home", `
    <section class="hero">
      <h1>${esc(siteName(env))}</h1>
      <p>Auto-updating news from NewsData.io. Readers can create accounts and comment on stories.</p>
      <p>
        <a class="button" href="/admin">Admin</a>
        ${env.__viewer ? `<a class="button secondary" href="/settings">Settings</a>` : `<a class="button secondary" href="/signup">Create account</a>`}
        <a class="button secondary" href="/subscribe">Subscribe</a>
      </p>
    </section>

    <nav class="chips">${cats}</nav>

    <main class="grid">
      ${cards || `<div class="panel"><h2>No articles yet</h2><p>Log into admin and run sync.</p></div>`}
    </main>
  `, env);
}

async function article(request, env) {
  const id = new URL(request.url).searchParams.get("id");
  const a = await env.DB.prepare(`SELECT * FROM articles WHERE id = ?`).bind(id).first();

  if (!a) return page("Not found", "<h1>Article not found</h1>", env, 404);

  const me = await currentUser(request, env);
  const mySettings = me ? await getUserSettings(env, me.id, me.email) : null;

  const commentRows = await env.DB.prepare(`
    SELECT comments.*, users.email, users.role, COALESCE(user_settings.display_name, users.email) AS display_name
    FROM comments
    JOIN users ON users.id = comments.user_id
    LEFT JOIN user_settings ON user_settings.user_id = users.id
    WHERE comments.article_id = ?
    ORDER BY comments.created_at ASC
  `).bind(id).all();

  const comments = (commentRows.results || []).map(c => {
    const canDelete = me && (me.role === "admin" || me.id === c.user_id);

    return `
      <div class="comment">
        <p><b>${esc(c.display_name || c.email)}</b> <span class="meta">${esc(formatDateTime(c.created_at))}</span></p>
        <p>${esc(c.body)}</p>
        ${canDelete ? `
          <form method="POST" action="/comment/delete">
            <input type="hidden" name="id" value="${esc(c.id)}">
            <input type="hidden" name="article_id" value="${esc(id)}">
            <button class="danger">Delete comment</button>
          </form>
        ` : ""}
      </div>
    `;
  }).join("");

  let commentBox = `<p><a class="button secondary" href="/login">Log in to comment</a> <a class="button secondary" href="/signup">Create account</a></p>`;

  if (me && Number(mySettings?.can_comment ?? 1) === 1) {
    commentBox = `
      <form method="POST" action="/comment/add" class="stack">
        <input type="hidden" name="article_id" value="${esc(id)}">
        <label>Comment as ${esc(mySettings.display_name || me.email)}</label>
        <textarea name="body" maxlength="2000" required placeholder="Add your comment..."></textarea>
        <button>Post comment</button>
      </form>
    `;
  } else if (me) {
    commentBox = `<p class="error">Your account cannot comment right now. An admin can change this.</p>`;
  }

  return page(a.title, `
    <article class="panel article">
      <p><a href="/">← Back</a></p>
      <p class="meta">${esc(label(a.category))} · ${esc(a.source_name || "")}</p>
      <h1>${esc(a.title)}</h1>
      ${a.image_url ? `<img src="${esc(a.image_url)}" alt="">` : ""}
      <p>${esc(a.description || "")}</p>
      <div>${paragraphs(a.content || a.description || "No full content was provided by the API.")}</div>
      ${a.url ? `<p><a class="button" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Open original source</a></p>` : ""}
    </article>

    <section class="panel">
      <h2>Comments</h2>
      ${comments || `<p>No comments yet.</p>`}
      <hr>
      ${commentBox}
    </section>
  `, env);
}

async function addComment(request, env) {
  const me = await currentUser(request, env);
  if (!me) return redirect("/login");

  const settings = await getUserSettings(env, me.id, me.email);
  if (Number(settings.can_comment) !== 1) {
    return page(
      "Comment blocked",
      `<section class="panel"><h1>Commenting disabled</h1><p>Your account cannot comment right now.</p></section>`,
      env,
      403
    );
  }

  const form = await request.formData();
  const articleId = String(form.get("article_id") || "");
  const body = String(form.get("body") || "").trim().slice(0, 2000);

  if (!articleId || !body) return redirect(`/article?id=${encodeURIComponent(articleId)}`);

  await env.DB.prepare(`
    INSERT INTO comments (id, article_id, user_id, body)
    VALUES (?, ?, ?, ?)
  `).bind(crypto.randomUUID(), articleId, me.id, body).run();

  return redirect(`/article?id=${encodeURIComponent(articleId)}`);
}

async function deleteComment(request, env) {
  const me = await currentUser(request, env);
  if (!me) return redirect("/login");

  const form = await request.formData();
  const id = String(form.get("id") || "");
  const articleId = String(form.get("article_id") || "");
  const comment = await env.DB.prepare(`SELECT * FROM comments WHERE id = ?`).bind(id).first();

  if (comment && (me.role === "admin" || comment.user_id === me.id)) {
    await env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(id).run();
  }

  return redirect(`/article?id=${encodeURIComponent(articleId)}`);
}

async function login(request, env) {
  if (request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");

    const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return page("Login", loginForm("Invalid email or password."), env, 401);
    }

    await ensureUserSettings(env, user.id, user.email);
    return createSession(env, user.id, user.role === "admin" ? "/admin" : "/settings");
  }

  return page("Login", loginForm(""), env);
}

function loginForm(error) {
  return `
    <section class="panel auth">
      <h1>Login</h1>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <form method="POST" action="/login" class="stack">
        <label>Email</label>
        <input name="email" type="email" required>
        <label>Password</label>
        <input name="password" type="password" required>
        <button>Login</button>
      </form>
      <p><a href="/signup">Create a reader account</a></p>
    </section>
  `;
}

async function signup(request, env) {
  if (request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");
    const displayName = String(form.get("display_name") || "").trim().slice(0, 40);

    if (!email || !password || password.length < 8) {
      return page("Create account", signupForm("Use a valid email and an 8+ character password."), env, 400);
    }

    const id = crypto.randomUUID();
    const role = isAdminEmail(env, email) ? "admin" : "user";
    const hash = await hashPassword(password);

    try {
      await env.DB.prepare(`
        INSERT INTO users (id, email, password_hash, role)
        VALUES (?, ?, ?, ?)
      `).bind(id, email, hash, role).run();

      await ensureUserSettings(env, id, displayName || email);

      if (displayName) {
        await env.DB.prepare(`
          UPDATE user_settings
          SET display_name = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `).bind(displayName, id).run();
      }

      return createSession(env, id, role === "admin" ? "/admin" : "/settings");
    } catch (e) {
      return page("Create account", signupForm("That email is probably already registered."), env, 400);
    }
  }

  return page("Create account", signupForm(""), env);
}

function signupForm(error) {
  return `
    <section class="panel auth">
      <h1>Create reader account</h1>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <form method="POST" action="/signup" class="stack">
        <label>Display name</label>
        <input name="display_name" maxlength="40" placeholder="How your comments should appear">
        <label>Email</label>
        <input name="email" type="email" required>
        <label>Password</label>
        <input name="password" type="password" minlength="8" required>
        <button>Create account</button>
      </form>
      <p><a href="/login">Already have an account?</a></p>
    </section>
  `;
}

async function settings(request, env) {
  const me = await currentUser(request, env);
  if (!me) return redirect("/login");

  if (request.method === "POST") {
    const form = await request.formData();
    const displayName = String(form.get("display_name") || "").trim().slice(0, 40) || me.email.split("@")[0];
    const emailUpdates = form.get("email_updates") === "1" ? 1 : 0;

    await ensureUserSettings(env, me.id, me.email);

    await env.DB.prepare(`
      UPDATE user_settings
      SET display_name = ?, email_updates = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).bind(displayName, emailUpdates, me.id).run();

    return redirect("/settings");
  }

  const s = await getUserSettings(env, me.id, me.email);

  return page("Settings", `
    <section class="panel auth">
      <h1>User settings</h1>
      <p class="meta">Signed in as ${esc(me.email)} · ${esc(me.role)}</p>
      <form method="POST" action="/settings" class="stack">
        <label>Display name</label>
        <input name="display_name" maxlength="40" value="${esc(s.display_name || "")}">
        <label><input type="checkbox" name="email_updates" value="1" ${Number(s.email_updates) === 1 ? "checked" : ""}> Email updates</label>
        <p>Comment permission: <b>${Number(s.can_comment) === 1 ? "Allowed" : "Disabled by admin"}</b></p>
        <button>Save settings</button>
      </form>
    </section>
  `, env);
}

async function logout(request, env) {
  const sid = getCookie(request, COOKIE_NAME);
  if (sid) await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();

  return redirect("/", {
    "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  });
}

async function admin(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const articles = await env.DB.prepare(`
    SELECT *
    FROM articles
    ORDER BY COALESCE(published_at, created_at) DESC
    LIMIT 50
  `).all();

  const users = await env.DB.prepare(`
    SELECT users.id, users.email, users.role, users.created_at,
           COALESCE(user_settings.display_name, users.email) AS display_name,
           COALESCE(user_settings.can_comment, 1) AS can_comment,
           COALESCE(user_settings.email_updates, 1) AS email_updates
    FROM users
    LEFT JOIN user_settings ON user_settings.user_id = users.id
    ORDER BY users.created_at DESC
    LIMIT 200
  `).all();

  const articleRows = (articles.results || []).map(a => `
    <tr>
      <td>${esc(a.title)}</td>
      <td>${esc(a.category)}</td>
      <td>${esc(a.source_name || "")}</td>
      <td>
        <form method="POST" action="/admin/article/delete">
          <input type="hidden" name="id" value="${esc(a.id)}">
          <button class="danger">Delete</button>
        </form>
      </td>
    </tr>
  `).join("");

  const userRows = (users.results || []).map(u => `
    <tr>
      <td>
        <form method="POST" action="/admin/user/update" class="stack compact">
          <input type="hidden" name="id" value="${esc(u.id)}">
          <input name="display_name" value="${esc(u.display_name || "")}" maxlength="40">
          <span class="meta">${esc(u.email)}</span>
      </td>
      <td>
          <select name="role">
            <option value="user" ${u.role === "user" ? "selected" : ""}>User</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
          </select>
      </td>
      <td>
          <label><input type="checkbox" name="can_comment" value="1" ${Number(u.can_comment) === 1 ? "checked" : ""}> Can comment</label><br>
          <label><input type="checkbox" name="email_updates" value="1" ${Number(u.email_updates) === 1 ? "checked" : ""}> Email updates</label>
      </td>
      <td>
          <button>Save</button>
        </form>
        ${u.id !== user.id ? `
          <form method="POST" action="/admin/user/delete" onsubmit="return confirm('Delete this user and their comments?')">
            <input type="hidden" name="id" value="${esc(u.id)}">
            <button class="danger">Delete user</button>
          </form>
        ` : `<span class="meta">Current admin</span>`}
      </td>
    </tr>
  `).join("");

  return page("Admin", `
    <section class="hero">
      <h1>Admin</h1>
      <p>Logged in as ${esc(user.email)}</p>
      <p>
        <a class="button secondary" href="/">Site</a>
        <a class="button secondary" href="/settings">Settings</a>
        <a class="button secondary" href="/logout">Logout</a>
      </p>
    </section>

    <section class="panel">
      <h2>Sync news</h2>
      <form method="POST" action="/admin/sync">
        <button>Sync NewsData.io now</button>
      </form>
    </section>

    <section class="panel">
      <h2>Add article</h2>
      <form method="POST" action="/admin/article/add" class="stack">
        <input name="title" placeholder="Title" required>
        <input name="description" placeholder="Description">
        <textarea name="content" placeholder="Content"></textarea>
        <input name="url" placeholder="Original source URL">
        <input name="image_url" placeholder="Image URL">
        <input name="source_name" placeholder="Source name">
        <select name="category">${CATEGORIES.map(c => `<option value="${c}">${label(c)}</option>`).join("")}</select>
        <button>Add article</button>
      </form>
    </section>

    <section class="panel">
      <h2>User management</h2>
      <p class="meta">Admins can change display names, roles, email-update preferences, and whether an account can comment.</p>
      <div class="tablewrap">
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Settings</th><th>Actions</th></tr></thead>
          <tbody>${userRows}</tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Articles</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Title</th><th>Category</th><th>Source</th><th></th></tr></thead>
          <tbody>${articleRows}</tbody>
        </table>
      </div>
    </section>
  `, env);
}

async function adminUpdateUser(request, env) {
  const adminUser = await requireAdmin(request, env);
  if (adminUser instanceof Response) return adminUser;

  const form = await request.formData();
  const id = String(form.get("id") || "");
  const role = String(form.get("role") || "user") === "admin" ? "admin" : "user";
  const displayName = String(form.get("display_name") || "").trim().slice(0, 40) || "Reader";
  const canComment = form.get("can_comment") === "1" ? 1 : 0;
  const emailUpdates = form.get("email_updates") === "1" ? 1 : 0;

  await env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role, id).run();
  await ensureUserSettings(env, id, displayName);

  await env.DB.prepare(`
    UPDATE user_settings
    SET display_name = ?, can_comment = ?, email_updates = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).bind(displayName, canComment, emailUpdates, id).run();

  return redirect("/admin");
}

async function adminDeleteUser(request, env) {
  const adminUser = await requireAdmin(request, env);
  if (adminUser instanceof Response) return adminUser;

  const form = await request.formData();
  const id = String(form.get("id") || "");

  if (!id || id === adminUser.id) return redirect("/admin");

  await env.DB.prepare(`DELETE FROM comments WHERE user_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM user_settings WHERE user_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();

  return redirect("/admin");
}

async function adminSync(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const result = await runNewsSync(env);

  return page("Sync result", `
    <section class="panel">
      <h1>Sync result</h1>
      <pre>${esc(JSON.stringify(result, null, 2))}</pre>
      <p><a class="button" href="/admin">Back</a></p>
    </section>
  `, env);
}

async function addArticle(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const form = await request.formData();

  await env.DB.prepare(`
    INSERT INTO articles (
      id, title, description, content, url, image_url, source_name,
      category, topic, published_at, is_manual
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    crypto.randomUUID(),
    String(form.get("title") || "").trim(),
    String(form.get("description") || "").trim(),
    String(form.get("content") || "").trim(),
    String(form.get("url") || "").trim(),
    String(form.get("image_url") || "").trim(),
    String(form.get("source_name") || "").trim(),
    cleanCategory(form.get("category") || "general"),
    "",
    new Date().toISOString()
  ).run();

  return redirect("/admin");
}

async function deleteArticle(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;

  const form = await request.formData();
  const id = String(form.get("id") || "");

  await env.DB.prepare(`DELETE FROM comments WHERE article_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM articles WHERE id = ?`).bind(id).run();

  return redirect("/admin");
}

async function subscribe(request, env) {
  if (request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();

    if (!email) return page("Subscribe", subscribeForm("Enter an email."), env, 400);

    await env.DB.prepare(`
      INSERT INTO subscriptions (id, email, categories, verified)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(email) DO UPDATE SET verified = 1
    `).bind(crypto.randomUUID(), email, CATEGORIES.join(",")).run();

    return page(
      "Subscribed",
      `<section class="panel"><h1>Subscribed</h1><p>${esc(email)} is subscribed.</p><p><a href="/">Back</a></p></section>`,
      env
    );
  }

  return page("Subscribe", subscribeForm(""), env);
}

function subscribeForm(error) {
  return `
    <section class="panel auth">
      <h1>Subscribe</h1>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <form method="POST" action="/subscribe" class="stack">
        <label>Email</label>
        <input name="email" type="email" required>
        <button>Subscribe</button>
      </form>
    </section>
  `;
}

async function runNewsSync(env) {
  if (!env.NEWS_API_KEY) return { ok: false, error: "Missing NEWS_API_KEY secret." };

  const categories = splitEnv(env.FETCH_CATEGORIES || CATEGORIES.join(","));
  const map = {
    general: "top",
    business: "business",
    technology: "technology",
    entertainment: "entertainment",
    health: "health",
    science: "science",
    sports: "sports"
  };

  let inserted = 0;
  let updated = 0;
  const failed = [];

  for (const categoryRaw of categories) {
    const category = cleanCategory(categoryRaw);
    const endpoint = new URL("https://newsdata.io/api/1/latest");

    endpoint.searchParams.set("apikey", env.NEWS_API_KEY);
    endpoint.searchParams.set("country", env.NEWS_COUNTRY || "us");
    endpoint.searchParams.set("language", env.NEWS_LANG || "en");
    endpoint.searchParams.set("category", map[category] || "top");

    try {
      const res = await fetch(endpoint.toString());
      const data = await res.json();

      if (!res.ok || (data.status && data.status !== "success")) {
        throw new Error(data.message || `HTTP ${res.status}`);
      }

      for (const item of data.results || []) {
        const result = await saveNewsItem(env, item, category);

        if (result === "inserted") inserted++;
        if (result === "updated") updated++;
      }
    } catch (e) {
      failed.push({ category, error: e.message });
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

async function saveNewsItem(env, item, category) {
  const title = item.title || "";
  const url = item.link || item.url || "";

  if (!title || !url) return "skipped";

  const existing = await env.DB.prepare(`SELECT id FROM articles WHERE url = ?`).bind(url).first();
  const id = existing?.id || crypto.randomUUID();

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
      published_at = excluded.published_at
  `).bind(
    id,
    title,
    item.description || item.content || "",
    item.content || item.description || "",
    url,
    item.image_url || "",
    item.source_name || item.source_id || "NewsData.io",
    Array.isArray(item.creator) ? item.creator.join(", ") : item.creator || "",
    cleanCategory(category),
    "",
    item.pubDate || new Date().toISOString()
  ).run();

  return existing ? "updated" : "inserted";
}

async function requireAdmin(request, env) {
  const user = await currentUser(request, env);

  if (!user || user.role !== "admin") return redirect("/login");

  return user;
}

async function currentUser(request, env) {
  const sid = getCookie(request, COOKIE_NAME);
  if (!sid) return null;

  const user = await env.DB.prepare(`
    SELECT users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
  `).bind(sid, new Date().toISOString()).first();

  if (user) await ensureUserSettings(env, user.id, user.email);

  return user;
}

async function getUserSettings(env, userId, email = "") {
  await ensureUserSettings(env, userId, email);

  return await env.DB.prepare(`SELECT * FROM user_settings WHERE user_id = ?`).bind(userId).first();
}

async function createSession(env, userId, location) {
  const sid = crypto.randomUUID();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(sid, userId, expires.toISOString()).run();

  return redirect(location, {
    "Set-Cookie": `${COOKIE_NAME}=${sid}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`
  });
}

async function hashPassword(password) {
  const salt = crypto.randomUUID();
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return `${salt}:${hex(digest)}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;

  const [salt, hash] = stored.split(":");
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return hex(digest) === hash;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, "0")).join("");
}

function page(title, body, env, status = 200) {
  const viewer = env.__viewer;

  const nav = `
    <nav>
      <a href="/">News</a>
      ${viewer ? `<a href="/settings">Settings</a>` : `<a href="/signup">Sign up</a>`}
      <a href="/subscribe">Subscribe</a>
      ${viewer?.role === "admin" ? `<a href="/admin">Admin</a>` : ""}
      ${viewer ? `<a href="/logout">Logout</a>` : `<a href="/login">Login</a>`}
    </nav>
  `;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · ${esc(siteName(env))}</title>
  <style>
    body{margin:0;background:#09090b;color:#f4f4f5;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    a{color:inherit;text-decoration:none}
    a:hover{color:#4ade80}
    header{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;background:#111114;border-bottom:1px solid #27272a}
    header b{color:#4ade80}
    nav{display:flex;gap:14px;color:#a1a1aa;flex-wrap:wrap}
    .wrap{max-width:1100px;margin:0 auto;padding:28px 18px}
    .hero,.panel,.card,.comment{background:#111114;border:1px solid #27272a;border-radius:18px;padding:20px;margin-bottom:16px}
    h1{font-size:clamp(32px,6vw,58px);line-height:1;margin:0 0 12px}
    p,.meta{color:#a1a1aa}
    .button,button{background:#4ade80;color:#09090b;border:0;border-radius:999px;padding:10px 14px;font-weight:800;display:inline-block;cursor:pointer}
    .secondary{background:#18181b;color:#f4f4f5;border:1px solid #27272a}
    .danger{background:#fb7185;color:#09090b;margin-top:6px}
    input,textarea,select{width:100%;box-sizing:border-box;background:#0c0c0f;color:#f4f4f5;border:1px solid #27272a;border-radius:12px;padding:11px;font:inherit}
    input[type="checkbox"]{width:auto}
    textarea{min-height:120px}
    label{color:#a1a1aa}
    .stack{display:grid;gap:10px}
    .compact{gap:6px}
    .auth{max-width:460px;margin:30px auto}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
    .card{padding:0;overflow:hidden}
    .card img,.noimg{width:100%;height:160px;object-fit:cover;background:#18181b;display:grid;place-items:center;color:#a1a1aa}
    .pad{padding:16px}
    .chips{display:flex;gap:8px;overflow:auto;margin-bottom:16px}
    .chip{background:#18181b;border:1px solid #27272a;border-radius:999px;padding:8px 12px;color:#a1a1aa}
    .article img{max-width:100%;border-radius:14px}
    .error{color:#fb7185}
    .tablewrap{overflow:auto}
    table{width:100%;border-collapse:collapse;min-width:650px}
    th,td{border-bottom:1px solid #27272a;padding:10px;text-align:left;vertical-align:top}
    pre{white-space:pre-wrap;background:#050507;border:1px solid #27272a;border-radius:12px;padding:12px;overflow:auto}
    hr{border:0;border-top:1px solid #27272a;margin:18px 0}
  </style>
</head>
<body>
  <header>
    <a href="/"><b>G</b> ${esc(siteName(env))}</a>
    ${nav}
  </header>

  <main class="wrap">${body}</main>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, ...headers }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function paragraphs(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => `<p>${esc(x)}</p>`)
    .join("");
}

function siteName(env) {
  return env.SITE_NAME || "Gaband323 News";
}

function cleanCategory(value) {
  const c = String(value || "").toLowerCase().trim();

  if (c === "top") return "general";
  if (c === "all") return "all";
  if (CATEGORIES.includes(c)) return c;

  return "general";
}

function splitEnv(value) {
  return String(value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function label(value) {
  const v = String(value || "");

  if (v === "all") return "All";

  return v.charAt(0).toUpperCase() + v.slice(1);
}

function formatDateTime(value) {
  if (!value) return "";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);

  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function isAdminEmail(env, email) {
  return splitEnv(env.ADMIN_EMAILS || "")
    .map(x => x.toLowerCase())
    .includes(String(email || "").toLowerCase());
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";

  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");

    if (k === name) return decodeURIComponent(v.join("="));
  }

  return "";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
