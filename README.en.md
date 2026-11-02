# Tencent Meeting · Auto-export recordings & transcripts

`tencent-meeting-auto` · 腾讯会议 · 录制/转写自动导出

**English** | [简体中文](./README.md)

> Auto-export **Tencent Meeting** recordings & transcripts to Markdown → upload to **IMA knowledge base** → push a daily digest via **WeCom**.
> Runs on GitHub Actions: **no server, no browser**, incremental with dedupe, self-rotating session.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub Actions](https://github.com/vip198926/tencent-meeting-auto/actions/workflows/daily.yml/badge.svg)](https://github.com/vip198926/tencent-meeting-auto/actions)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

## Why this exists

Tencent Meeting gives you two artifacts for an ended meeting, and they are **not** equivalent:

- **Transcription (转写)** starts automatically when the meeting begins, but its text is often noticeably shorter.
- **Recording (录制)** must be started manually by the host, so it may miss the beginning — yet it usually contains more content.

Doing this by hand means: open the web console → find the meeting → download → rename → paste into a knowledge base → repeat daily. This repo turns that into a scheduled job that **grabs both, compares them, keeps the better one, dedupes across runs, and notifies you**.

## What it does

| | |
|---|---|
| ✅ Incremental | Processes only meetings ended after the last run (`daily/last_progress.json`) |
| ✅ Dedupe | By `record_id`, never re-uploads the same record |
| ✅ Better-pick | Transcript vs recording compared with 4-gram Jaccard; keeps the richer one, merges when complementary |
| ✅ Markdown | Each meeting becomes one `.md` (title, time, participants, transcript, AI summary) |
| ✅ IMA upload | Puts files into a knowledge base folder via the IMA open API |
| ✅ Notify | WeCom bot (or PushPlus) daily digest; failures are always reported, never silent |
| ✅ Self-rotating session | Login state is refreshed every run and written back to a GitHub Secret |

**Limitations (important)**

- Only the **last 31 days** of meetings are reachable — a personal Tencent Meeting account is hard-limited to a 31-day window.
- It calls **undocumented Tencent endpoints** behind the web console. They can change without notice and break this.
- Tencent Meeting account, IMA knowledge base and WeCom are all China-region products. You need those accounts; this is not a generic Zoom/Meet exporter.

## How it works

```
external cron / manual dispatch
        │
        ▼
  GitHub Actions (patrol.yml | daily.yml)
        │
        ├─ 1. write session Secret → $RUNNER_TEMP/auth_state.json
        ├─ 2. refresh-token  → extend login (pure HTTP, ~7 more days)
        ├─ 3. list ended meetings in the incremental window
        ├─ 4. per meeting: fetch ALL records (transcript + recording)
        │        └─ compare → keep richer / merge if complementary / else keep both
        ├─ 5. render Markdown → upload to IMA (skip if record_id already uploaded)
        ├─ 6. push WeCom digest (always, success or failure)
        ├─ 7. commit state files (progress + processed record ids)
        └─ 8. rotate: encrypt refreshed session → write back Secret (if: always)
```

Design choices worth knowing:

- **No browser at runtime.** Fetching and token refresh are plain HTTPS calls; Playwright is only needed once, locally, to capture the login.
- **State lives in the repo**, not in a database — two JSON files, committed by the workflow. Cheap, transparent, `git log` is the audit trail.
- **GitHub's built-in `schedule` is disabled** (`# schedule:` commented out). In practice it fires hours late; an external dispatcher hitting `workflow_dispatch` is far more reliable.
- **Rotate, don't just refresh.** A GitHub Secret is a static snapshot and Actions never writes it back, so the session would die every ~7 days. The last step closes that loop.

## Requirements

- Node.js **≥ 18**
- A Tencent Meeting account with recordings/transcripts
- IMA open-platform credentials (`client_id`, `api_key`) + a knowledge base & folder
- Optional: WeCom group bot webhook, or a PushPlus token
- For the one-time login capture: local Chrome/Edge (Playwright)

## Quick start

**1. Clone**

```bash
git clone https://github.com/<you>/tencent-meeting-auto.git
cd tencent-meeting-auto
npm install            # only tweetsodium
```

**2. Capture the login state (once)**

```bash
npm install playwright-core
node login_auth.js     # opens a visible browser → scan the QR code → writes auth_state.json
```

It polls for the `we_meet_token` cookie, verifies against the API, and only overwrites `auth_state.json` if verification passes.

**3. Collect credentials**

- IMA: `client_id` / `api_key`, plus the target **knowledge base id** and **folder id**.
- WeCom: group bot webhook URL (optional).

**4. Add repository secrets** — `Settings → Secrets and variables → Actions`

| Secret | Required | Purpose |
|---|---|---|
| `CTM_AUTH_STATE_RAW` | ✅ | Full text of `auth_state.json` |
| `IMA_CLIENT_ID` | ✅ | IMA client id |
| `IMA_API_KEY` | ✅ | IMA api key |
| `WECOM_WEBHOOK` | ⬜ | WeCom bot URL (omit to disable notifications) |
| `SECRETS_WRITE_PAT` | ✅ with rotation | PAT used to write the session back each run |

`set_secrets.js` can push all of them at once from local JSON files, so you never paste by hand.

**5. Create the rotation token**

A fine-grained PAT scoped to this repo with:

- `Secrets: Read and write`
- `Actions: Read and write` (only needed if the same token also triggers workflows)
- **Long or no expiration**

Store it as `SECRETS_WRITE_PAT`.

**6. Point it at your own knowledge base**

The repo name needs no change — scripts read Actions' built-in `GITHUB_REPOSITORY`. For IMA, either:

- set repository variables `IMA_KB_ID` / `IMA_FOLDER_ID`, or
- edit the defaults in `ima_upload.js`

## Usage

**Manual** — Actions → pick a workflow → *Run workflow*:

- `daily.yml`: `mode=inc` (default) or `mode=daily` + `date=YYYY-MM-DD` to backfill one day.
- `patrol.yml`: one incremental round plus session-expiry / backlog warnings.

**Local**

```bash
CTM_AUTH_STATE=./auth_state.json IMA_CLIENT_ID=xxx IMA_API_KEY=yyy node run.js inc
node daily_records.js inc --no-notify     # skip notifications
```

**Scheduled** — point any external cron at `workflow_dispatch` (see `trigger_dispatch.sh`). Defaults used by the author: patrol 03:36, daily 09:36 (UTC+8).

## Configuration

| Variable | Purpose |
|---|---|
| `CTM_AUTH_STATE` | Path to the session file (workflow uses `$RUNNER_TEMP`) |
| `CTM_AUTH_STATE_RAW` | Session JSON as text; `run.js` materializes it to disk |
| `IMA_CLIENT_ID` / `IMA_API_KEY` | IMA credentials |
| `IMA_KB_ID` / `IMA_FOLDER_ID` | Upload target (optional, overrides code defaults) |
| `WECOM_WEBHOOK` / `PUSHPLUS_TOKEN` | Notification channels (optional) |
| `GITHUB_PAT` / `GITHUB_PAT_FILE` | Token for `rotate_secret.js` (file avoids leaking it into argv) |
| `SECRET_NAME` / `AUTH_SRC` | Which secret to write, and from which file |
| `SOURCE` | Caller tag (`patrol` / `daily`) — shapes the digest |

## Repository layout

```
.github/workflows/   daily.yml (pipeline) · patrol.yml (watchdog)
daily/               committed state: last_progress.json, processed_records.json
run.js               entry point: session → refresh → pipeline
daily_records.js     incremental/backfill pipeline, dedupe, picking, digest
ctm_fetch.js         fetch one recording/transcript → text + summary
token_refresh.js     pure-HTTP session refresh
ima_upload.js        Markdown → IMA knowledge base
wecom_webhook.js     WeCom bot push
login_auth.js        local QR login → auth_state.json
rotate_secret.js     write refreshed session back to a Secret
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `10100001 please log in` / `Error auth key not found` | Session expired. Re-run `login_auth.js`, update `CTM_AUTH_STATE_RAW` |
| `refresh-token` returns `-51003` | Token fully invalid — HTTP refresh cannot recover, scan the QR code again |
| `workflow_dispatch` returns **403** | Trigger token lacks `Actions: Read and write` |
| Writing a secret returns **401/403** | `SECRETS_WRITE_PAT` lacks `Secrets: Read and write`, or has expired |

## Security & privacy

- Credentials never enter the repo: `auth_state.json`, `ima_creds.json`, `daily/records_*` and `run_log.jsonl` are gitignored, and real transcripts are kept out of history.
- Secrets are injected into `$RUNNER_TEMP` at runtime and removed in an `if: always()` cleanup step.
- Public repos are fine: Actions secrets are only visible to collaborators, and PRs from forks get none by default.
- **You** are responsible for what you export. Only process meetings you are entitled to access, and respect Tencent's terms of service.

## License

[MIT](./LICENSE) © vip198926
