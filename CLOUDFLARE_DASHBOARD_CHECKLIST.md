# Cloudflare Dashboard Checklist

## Database

- [ ] Create D1 database: `gaband-news-db`
- [ ] Run `migrations/0001_init.sql` in the D1 Console
- [ ] Bind D1 to Worker with variable name: `DB`

## Worker / GitHub Deploy

- [ ] Create Worker from GitHub repo
- [ ] Worker name is `gaband-news-site`
- [ ] Build command: `npm install`
- [ ] Deploy command: `npx wrangler deploy`
- [ ] Root directory: `/`

## Variables

Add as normal variables:

- [ ] `SITE_NAME`
- [ ] `SITE_ORIGIN`
- [ ] `NEWS_COUNTRY`
- [ ] `NEWS_LANG`
- [ ] `ADMIN_EMAILS`
- [ ] `EMAIL_FROM`
- [ ] `DIGEST_SUBJECT`
- [ ] `FETCH_CATEGORIES`
- [ ] `TRENDING_QUERIES`

## Secrets

Add as secrets:

- [ ] `NEWS_API_KEY`
- [ ] `RESEND_API_KEY`
- [ ] `SESSION_SECRET`

## Domain

- [ ] Add custom domain: `news.gaband323.dev`
- [ ] Remove conflicting DNS CNAME if Cloudflare complains

## First Admin

- [ ] Visit `/signup`
- [ ] Sign up with an email listed in `ADMIN_EMAILS`
- [ ] Visit `/admin`
- [ ] Click Sync News
