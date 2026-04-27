# Gaband News — Cloudflare Dashboard Deployment

This project is built as a **Cloudflare Worker**, not a static Pages-only site, because it needs:

- D1 database access
- Cron auto-updates
- Admin API endpoints
- Email digest sending
- Server-side secrets

You can still deploy it mostly from the Cloudflare website/dashboard by connecting a GitHub repo to Workers Builds.

## 1. Put this project in GitHub

Create a GitHub repo, upload these files, then commit/push.

Recommended repo name:

```txt
gaband-news-site
```

## 2. Create the D1 database in Cloudflare dashboard

1. Open Cloudflare Dashboard.
2. Go to **Workers & Pages**.
3. Go to **D1 SQL Database**.
4. Select **Create database**.
5. Name it:

```txt
gaband-news-db
```

6. Open the new database.
7. Go to **Console**.
8. Copy the SQL from:

```txt
migrations/0001_init.sql
```

9. Paste it into the D1 Console and run it.

That creates the article, user, subscriber, and email log tables.

## 3. Create the Worker from GitHub in Cloudflare dashboard

1. Go to **Workers & Pages**.
2. Select **Create application**.
3. Choose **Import a repository**.
4. Connect/select the GitHub repo containing this project.
5. Create it as a **Worker** project, not a static Pages project.

Use these build settings:

```txt
Framework preset: None
Build command: npm install
Deploy command: npx wrangler deploy
Root directory: /
```

Important: the Worker name in Cloudflare should match the `name` in `wrangler.toml`:

```txt
gaband-news-site
```

## 4. Add the D1 binding in the dashboard

1. Open the Worker project.
2. Go to **Settings**.
3. Go to **Bindings**.
4. Add a **D1 database binding**.
5. Set the variable/binding name exactly to:

```txt
DB
```

6. Select the `gaband-news-db` database.
7. Save.
8. Redeploy after saving bindings.

The code expects `env.DB`, so the binding must be named `DB`.

## 5. Add environment variables and secrets in the dashboard

Open the Worker project, then go to:

```txt
Settings → Variables and Secrets
```

Add these as **variables**:

```txt
SITE_NAME=Gaband News
SITE_ORIGIN=https://news.gaband323.dev
NEWS_COUNTRY=us
NEWS_LANG=en
ADMIN_EMAILS=your-email@example.com
EMAIL_FROM=Gaband News <updates@news.gaband323.dev>
DIGEST_SUBJECT=Your Gaband News update
FETCH_CATEGORIES=general,business,technology,entertainment,health,science,sports
TRENDING_QUERIES=AI,Cloudflare,Roblox,Discord,Los Angeles,transportation
```

Change `ADMIN_EMAILS` to the email addresses allowed to become admins. Separate multiple admins with commas:

```txt
ADMIN_EMAILS=zach@example.com,chris@example.com
```

Add these as **secrets**:

```txt
NEWS_API_KEY=your_newsapi_key
RESEND_API_KEY=your_resend_key
SESSION_SECRET=a_long_random_secret_value
```

Use a long random value for `SESSION_SECRET`; 32+ characters is fine.

## 6. Add the custom domain

1. Open the Worker project.
2. Go to **Settings**.
3. Go to **Domains & Routes**.
4. Select **Add**.
5. Choose **Custom Domain**.
6. Enter:

```txt
news.gaband323.dev
```

7. Save.

Do not keep an existing conflicting CNAME record for `news.gaband323.dev`. Cloudflare custom domains for Workers cannot be added on top of an existing CNAME for the same hostname.

## 7. Make sure cron triggers are active

The project already includes this in `wrangler.toml`:

```toml
[triggers]
crons = ["*/30 * * * *", "0 14 * * *"]
```

That means:

- Fetch news every 30 minutes.
- Send daily digest around 14:00 UTC.

If the dashboard does not show them after deploy, open the Worker settings and check **Triggers / Cron Triggers**.

## 8. First admin login

After deployment, visit:

```txt
https://news.gaband323.dev/signup
```

Sign up using an email listed in `ADMIN_EMAILS`.

Then go to:

```txt
https://news.gaband323.dev/admin
```

From there you can:

- Sync news manually
- Send a test digest
- Add manual news articles
- Delete articles

## 9. Email setup note

Resend usually requires you to verify the sending domain before using a custom `from` address like:

```txt
updates@news.gaband323.dev
```

If email sending fails, check Resend’s domain verification/DNS records first.

## 10. News API note

This project uses NewsAPI by default:

```txt
https://newsapi.org
```

If NewsAPI blocks your production use or you outgrow the free tier, swap the fetch logic in `src/index.js` for GNews, Mediastack, The Guardian API, or another provider.
