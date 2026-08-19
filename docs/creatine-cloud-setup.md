# Creatine tracker cloud setup

The tracker remains usable without an account. Signed-in users store only their tracker profile and factual dose events in Supabase; estimated progress is calculated in the browser and is not persisted.

## Environment

The Vercel Supabase integration must provide these variables to production, preview, and development:

- `PUBLIC_SUPABASE_URL`
- `PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)

Only variables prefixed with `PUBLIC_` are bundled into the browser. The secret key is used only by the same-origin account-deletion function.

## Database

Apply all migrations in order, then verify real two-user isolation:

1. `supabase/migrations/202608100001_creatine_accounts.sql`
2. `supabase/migrations/202608100002_creatine_tenth_gram_precision.sql`
3. `supabase/migrations/202608100003_creatine_identity_bound_rpcs.sql`
4. `supabase/migrations/202608150001_creatine_balance_v2.sql`

```bash
npm run verify:creatine-rls
```

The verifier creates temporary confirmed users, exercises own-user CRUD, rejects cross-user access, checks guest import and deletion, and hard-deletes every temporary user in cleanup.

## Passwordless email sign-in

The tracker uses Supabase passwordless email links, so no third-party OAuth client is required. Keep the production tracker URL as the Supabase Site URL and in the redirect allowlist:

```text
https://doubledash.me/tools/creatine-loading/
```

Confirm the Supabase Email provider remains enabled before release.
