# Security

Please report a suspected vulnerability privately to `dash@doubledash.me`. Do not include real health or account data in the report.

## Deployment boundary

- Never commit Supabase credentials or a Vercel environment export.
- Browser code may receive only a Supabase publishable/anon key.
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` is server-only and is used solely by the authenticated account-deletion endpoint.
- Apply every migration and run `npm run verify:rls` before enabling cloud saving.
- Keep account deletion same-origin and require the current user's bearer token.
- Use a separate Supabase project for development or RLS verification.

The RLS verifier creates and deletes temporary users. Review the script before running it against any external project.
