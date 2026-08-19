# Creatine Loading Tracker

Source distribution for the personal creatine dose tracker at [doubledash.me/tools/creatine-loading](https://www.doubledash.me/tools/creatine-loading/).

The tracker records factual dose events, derives a transparent loading estimate in the browser, and can optionally sync a user-owned history through Supabase. It is a tracking and estimation tool, not a biological measurement, dosage prescription, diagnosis, or medical device.

## What is included

- `public/tools/creatine-model.js` — deterministic state validation, migration, and loading estimate
- `public/tools/creatine-schedule.js` — optional five-gram spacing suggestions that fail closed for unsupported histories
- `public/tools/creatine-loading.js` — browser UI, local persistence, import/export, and account reconciliation
- `public/tools/creatine-cloud-adapter.js` — passwordless auth and identity-pinned cloud operations
- `api/creatine-account.js` — same-origin authenticated account-deletion endpoint for Vercel
- `supabase/migrations/` — schema, validation, RLS, import, and deletion functions
- `scripts/verify-creatine-rls.mjs` — destructive test-data-only two-user isolation verifier
- `tests/` — 63 deterministic and cloud-boundary tests
- `src/` — the Astro page, bootstrap, and styles used by Doubledash

The public repository preserves the production source paths so the tests exercise the same modules used by the live tool. The Doubledash layout shell and unrelated private website code are intentionally excluded.

## Model boundary

The model treats the user's tracking-start date as an assumed supplemental baseline. It credits logged grams against a weight-derived loading target, caps the estimate at 100%, and applies a gradual completed-day decline. The six-target-day and 42-day constants are explicit implementation assumptions; the displayed percentage is not a measurement of muscle creatine.

Typical adult loading protocols described by [NIH ODS](https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-HealthProfessional/) use 20 g/day in four 5 g portions for 5–7 days, with 3–5 g/day maintenance; some studies use about 0.3 g/kg/day. The classic [Hultman et al. trial](https://pubmed.ncbi.nlm.nih.gov/8828669/) reported roughly 20% higher muscle total creatine after six days at 20 g/day and a gradual return after supplementation stopped. Those findings inform context, not a claim that this browser estimate measures an individual body.

Do not use this code as medical advice. It is limited to adults using creatine monohydrate and is not validated for pregnancy, breastfeeding, kidney disease, medication interactions, or individualized clinical care.

## Data boundary

Without an account, weight, tracking-start date, timezone, quick-log amount, and dose history stay in that browser's `localStorage`. With cloud saving enabled, Supabase Auth stores the login identity, while the application stores the tracker profile and factual dose events behind row-level security. Modelled progress is calculated in the browser and is never stored in the database.

See [PRIVACY.md](PRIVACY.md) for the exact fields and deletion behavior.

## Tests

```bash
npm install
npm test
```

The regular test suite does not require credentials.

## Optional Supabase verification

Copy `.env.example` to `.env.local`, provide a dedicated Supabase project's public and server-only credentials, apply all migrations in order, then run:

```bash
npm run verify:rls
```

This verifier creates two temporary confirmed users, exercises own-user and cross-user operations, and hard-deletes both users plus cascade-owned test data in cleanup. Never run it against a project where temporary test-account creation is unacceptable.

The publishable/anon key is browser-visible by design. The service-role or secret key must remain server-only and must never be committed or prefixed with `PUBLIC_`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
