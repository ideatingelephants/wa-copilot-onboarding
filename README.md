# WhatsApp Group Ops Copilot (Friends-Only MVP)

This is a self-hosted MVP for your scope:
- monitor selected WhatsApp groups
- detect important messages
- nudge owner when intervention is likely needed
- build task history
- learn relevance from owner feedback

It is designed for small trusted usage (you + friends) with explicit consent from group participants.

## What this build includes

- Baileys ingestion from WhatsApp Web linked device session
- Postgres-backed message/task/history storage
- Owner-only command interface in WhatsApp:
  - `/watch`, `/unwatch`, `/groups`
  - `/tasks`, `/done <task_id>`
  - `/digest`
  - `/pause`, `/resume`, `/status`
  - `/label <message_id> important|ignore` (feedback learning)
- Background loops:
  - analysis loop
  - immediate important-message nudge loop
  - stale-task nudge loop
  - periodic digest loop

## Architecture

- `src/app.js`: runtime, Baileys socket, timers
- `src/commands.js`: owner command handling
- `src/analysis.js`: importance/task detection
- `src/llm.js`: optional LLM providers (`openai` or `gemini` on Vertex AI)
- `src/store.js`: DB persistence/query layer
- `src/schema.sql`: tables/indexes
- `onboarding/server.js`: Google-login setup portal
- `onboarding/gcp-provisioner.js`: project + billing + VM provisioning workflow

## Prerequisites

- Node.js 20+
- Docker (optional, for local Postgres)
- WhatsApp account dedicated to bot usage

## Setup

1. Install dependencies:

```bash
npm install
```

2. Start Postgres (recommended via Docker):

```bash
docker compose up -d postgres
```

3. Create environment file:

```bash
cp .env.example .env
```

4. Edit `.env`:
- set `OWNER_PHONE` (or `OWNER_JID`) to your personal number (the number that should receive advisories)
- keep `DATABASE_URL` aligned with your Postgres instance
- optional: keep `ENABLE_LLM_CLASSIFIER=0` for no external AI calls

5. Initialize schema:

```bash
npm run db:init
```

6. Start the bot:

```bash
npm start
```

7. Pair WhatsApp:
- scan the QR shown in terminal from the dedicated bot WhatsApp account
- add that bot account to target groups

## One-click cloud setup for each friend (recommended)

If users are non-technical, give each friend their own isolated deployment using Render Blueprint:

1. Push this repo to GitHub.
2. In Render, create a new Blueprint and point to the repo (it will auto-detect `render.yaml`).
3. At deploy time, the friend only sets `OWNER_PHONE` (their number in country-code format, digits only).
4. Render creates:
   - one worker service (always running)
   - one Postgres database
   - one persistent disk for Baileys auth/session
5. After deploy, open worker logs and scan the QR from the bot WhatsApp account once.

That gives every friend their own independent online space and separate data.

## Simplified user journey (current)

### User does only these steps

1. Open your onboarding URL.
2. Login with Google.
3. Load/select billing account (or click "Create billing account" if none).
4. Enter:
   - owner personal number
   - bot number (optional)
   - initial context
   - contact email (prefilled from Google login)
5. Click "Provision workspace now".
6. Wait for completion + setup email.
7. Open logs link, scan QR from bot phone.
8. Add bot to groups and send `/watch`.

### Auto-selected (no user input)

- timezone: `Asia/Kolkata` (IST)
- region: `asia-south2` (Delhi)
- zone: `asia-south2-a`
- Gemini classifier: enabled

## LLM provider setup

Default is no external AI (`ENABLE_LLM_CLASSIFIER=0`), and local learning still works.

To use Gemini on Google Cloud Vertex AI:

```env
ENABLE_LLM_CLASSIFIER=1
LLM_PROVIDER=gemini
GCP_PROJECT_ID=your-project-id
GCP_LOCATION=us-central1
GEMINI_MODEL=gemini-2.0-flash-001
```

Authentication for Gemini uses Application Default Credentials (ADC):
- On GCP runtime: attach a service account with Vertex AI permissions.
- Local machine: set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`.

To use OpenAI instead:

```env
ENABLE_LLM_CLASSIFIER=1
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
```

## GCP deploy and handover model

This repo now includes an onboarding server that does:
1. Google login
2. billing-account selection
3. project creation
4. billing link
5. API enablement
6. VM provisioning with bot bootstrap

All resources are created in the user's own GCP account context.

### Start the onboarding server

1. Set onboarding variables in `.env`:
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `ONBOARDING_BASE_URL`
   - `BOOTSTRAP_REPO_URL` (public GitHub URL of this repo)
   - In Google OAuth client config, add redirect URI:
     - `${ONBOARDING_BASE_URL}/auth/google/callback`
   - Optional email delivery:
     - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

2. Start:

```bash
npm run onboarding:start
```

3. Share `${ONBOARDING_BASE_URL}` with your friend.

### Friend flow (non-technical)

1. Open onboarding URL.
2. Login with Google.
3. Click "Load billing accounts" and select one.
4. If empty: open billing setup link, add payment profile/card, return and reload.
5. Enter owner phone + context and click "Provision workspace now".
5. Wait for completion response with:
   - project ID
   - VM name
   - external IP
   - console and SSH instructions

### What gets provisioned

- New GCP project
- Billing linked to selected billing account
- Required APIs enabled
- Runtime service account
- One Compute Engine VM (`e2-small`) running:
  - Node app
  - local Postgres
  - systemd-managed bot process

### Security notes

- If `AUTO_LOGOUT_AFTER_PROVISION=1`, OAuth session is cleared after setup.
- Keep onboarding service private behind basic auth or VPN for operator safety.
- This flow cannot create Google accounts; users must already have one.
- QR is surfaced via VM logs link; setup email includes this link (not embedded QR image).

## Fast deploy to Cloud Run (operator)

Use the included deploy script to get a shareable onboarding URL:

```bash
GOOGLE_OAUTH_CLIENT_ID='...' \
GOOGLE_OAUTH_CLIENT_SECRET='...' \
BOOTSTRAP_REPO_URL='https://github.com/YOUR_ORG/OC-connect.git' \
./scripts/deploy-onboarding-cloudrun.sh
```

Optional envs for this script:
- `PROJECT_ID` (defaults to current gcloud project)
- `SERVICE_NAME` (default `wa-copilot-onboarding`)
- `REGION` (default `asia-south2`)
- `SMTP_*` values for setup email delivery

After deploy, script prints:
- public onboarding URL to share
- exact OAuth redirect URI to add in Google OAuth client settings

## First-use flow

1. In each target group, send `/watch` from your owner number.
2. Let messages flow for a while.
3. Use `/tasks` and `/digest` in DM with bot.
4. When a nudge is wrong/right, send:
   - `/label <message_id> important`
   - `/label <message_id> ignore`

This feedback adjusts keyword scores in `keyword_learning` and affects future importance detection.

## Notes on "self-learning"

Current self-learning is safe and local:
- no autonomous model drift
- explicit owner feedback updates token weights
- optional LLM classifier can be enabled via env, but feedback learning works without it

## Operational safety defaults

- No auto-posting to groups
- Nudges are owner-DM only
- Quiet hours suppress non-critical nudges
- `/pause` allows immediate stop without shutting process

## Recommended next steps

- Add per-group config (`priority`, `quiet_hours`, `task owners`)
- Add export/delete commands for privacy workflows
- Add small web dashboard for reviewing tasks and nudges
