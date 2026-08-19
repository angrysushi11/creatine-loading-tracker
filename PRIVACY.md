# Data and privacy boundary

## Browser-only mode

The tracker stores these fields in browser `localStorage`:

- weight in kilograms
- tracking-start date
- tracker timezone
- usual quick-log amount
- dose identifiers, timestamps, timezone, grams, client-created timestamp, and entry method
- sync/recovery metadata needed to avoid overwriting another account's history

The browser copy is not encrypted by this application. Anyone with access to the browser profile or device storage may be able to read it. Clearing browser data removes guest data unless the user exported a backup.

## Optional cloud mode

Supabase Auth processes the email address and passwordless sign-in session. Application tables store the tracker profile, factual dose events, and import-receipt metadata. Estimated progress is derived in the browser and is not persisted.

Row-level-security policies restrict authenticated table operations to `auth.uid() = user_id`. Identity-bound RPC wrappers reject an operation if the active account changed after the action began.

## Deletion

"Delete tracker data" removes the signed-in user's profile, dose events, and import receipts while retaining the authentication account. "Delete account" verifies the current bearer token server-side and deletes the Supabase Auth user; foreign-key cascades remove owned tracker rows. Browser copies for that account are then compare-and-cleared so a different newly active account is not removed.

Self-hosters are responsible for their own privacy notice, retention policy, Supabase configuration, access logs, backups, email delivery, incident response, and legal obligations.
