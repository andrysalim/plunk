# Plunk with any SMTP server

> **Unofficial modified version.** This is a fork of [useplunk/plunk](https://github.com/useplunk/plunk),
> modified on 2026-11-14 to add an SMTP sending provider. It is not made, endorsed or
> supported by the Plunk team. Like the original, it is licensed under the
> [GNU AGPL v3](LICENSE); the files changed are listed below. Report problems with the
> SMTP provider here, not upstream.

This fork adds `EMAIL_PROVIDER=smtp`, so Plunk can send through any SMTP server
(Brevo, Mailgun, Postmark, Zoho, your own Postfix, …) instead of AWS SES. With the
default `EMAIL_PROVIDER=ses` it behaves exactly like upstream.

## What changed (kept small on purpose)

| File | Change |
| --- | --- |
| `apps/api/src/services/SmtpSesClient.ts` | **New.** SMTP stand-in for the SES client, using nodemailer. |
| `apps/api/src/services/SESService.ts` | The `ses` client is the SMTP stand-in when `EMAIL_PROVIDER=smtp`. About 5 lines. |
| `apps/api/src/app/constants.ts` | AWS SES variables are optional in SMTP mode. 3 lines. |
| `apps/api/package.json`, `yarn.lock` | Adds `nodemailer`. |
| `docker-compose.smtp.yml` | **New.** Compose override that builds this fork's image. |
| `.github/workflows/smtp-sync-upstream.yml` | **New.** Upstream sync (see below). |
| env examples + wiki page | Document the new variables. |

Everything else is still upstream code: MIME building, queues, rate limiting,
workflows, segments and campaigns all run unchanged. SES calls go through one
client object, and the swap happens there, which is why upstream releases rarely
conflict with this patch.

## Run it

1. In `.env`, next to the usual self-hosting variables:

   ```env
   EMAIL_PROVIDER=smtp
   OUTBOUND_SMTP_HOST=smtp-relay.brevo.com
   OUTBOUND_SMTP_PORT=587
   OUTBOUND_SMTP_USER=your-login
   OUTBOUND_SMTP_PASS=your-smtp-key
   OUTBOUND_SMTP_MAX_SEND_RATE=5
   ```

   The `AWS_SES_*` variables can be left empty.

2. Start Plunk with the override:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.smtp.yml up -d --build
   ```

   Or use the image the sync workflow publishes, by setting
   `PLUNK_IMAGE=ghcr.io/<your-github-user>/plunk-smtp:v0.18.0-smtp` in `.env`
   and running without `--build`.

3. In Plunk, add your sending domain. In SMTP mode it is marked verified right
   away. Set up SPF/DKIM for that domain **at your SMTP provider**. Plunk's DNS
   panel shows SES records, which you can ignore.

## What SMTP mode does not do

These features come from SES event notifications, and a plain SMTP server does not send them:

- **No bounce or complaint handling.** Plunk won't unsubscribe hard bounces
  automatically, so keep your provider's suppression list on.
- **No delivery, open or click tracking.** Workflows that wait for `email.open` or
  `email.click` won't continue. Your own events (`POST /v1/track`) work normally.
- **No automatic project disabling** based on bounce or complaint rates.
- **No inbound email** through SES receipt rules.

Sending, campaigns, transactional email, workflows, delays, conditions, segments,
contacts and your own events all work.

## Staying safe on new upstream releases

`smtp-sync-upstream.yml` runs daily:

1. It checks for a new upstream release tag (`vX.Y.Z`).
2. It replays this patch onto it on `smtp-candidate`. `smtp` is not touched yet.
3. It runs the full upstream test suite and a type-check.
4. **Only if all of that passes**, it moves `smtp` forward, tags `vX.Y.Z-smtp`, and
   publishes `ghcr.io/<you>/plunk-smtp:vX.Y.Z-smtp` and `:latest`.
5. On a conflict or a failing test, it opens a GitHub issue and publishes nothing.

For production, pin a specific `vX.Y.Z-smtp` image and move to a new one after you
have read upstream's changelog. Use `:latest` only if you want automatic upgrades.

### One-time GitHub setup
1. Fork `useplunk/plunk` and push this branch to it as `smtp`.
2. In the fork, go to **Settings → General → Default branch** and set it to `smtp`
   (scheduled workflows only run from the default branch).
3. In **Actions**, enable workflows for the fork.
4. In **Actions → SMTP fork - sync upstream release → Run workflow**, tick
   **force** once to build the first image.
