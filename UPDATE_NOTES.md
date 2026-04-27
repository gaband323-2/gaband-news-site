# Gaband323 News update notes

This version changes the site name to **Gaband323 News** and adds:

- On-site article pages at `/article/:id`.
- Admin-created accounts from `/admin`.
- Admin-created login codes from `/admin`.
- Code login page at `/code-login`.
- Preset admin login support using `ADMIN_PRESET_EMAIL` and `ADMIN_PRESET_PASSWORD`.

## Required D1 SQL update

Run this in your D1 console if your database already exists:

```sql
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_codes_code ON login_codes(code);
```

## New Cloudflare variables/secrets

Normal variable:

```txt
ADMIN_PRESET_EMAIL=your-email@example.com
SITE_NAME=Gaband323 News
```

Secret:

```txt
ADMIN_PRESET_PASSWORD=make-a-real-password-8-chars-or-more
```

Then log in at `/login` using that preset email/password. Once inside `/admin`, you can add other accounts or make login codes.
