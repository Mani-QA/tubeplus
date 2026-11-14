# TubePlus

A better video site for [Tristan Hume's YouTube tier list](https://karpathy.ai/tristan-tube/),
on **Cloudflare Workers + D1**. Live at https://tubeplus.net.

The original is a static page that fetches one `videos.json` (156 channels,
47,339 videos). TubePlus puts that catalog in D1 and adds what the original
doesn't have: a category and tags for every video, a New feed fed by daily
RSS ingest, real SEO pages for categories/tags/channels, adding channels,
importing videos from public YouTube playlists, and user-created public
playlists. No login anywhere — likes and playlist edit tokens are
per-browser (localStorage).

## Layout

```
worker/                  The Cloudflare Worker (Hono + TypeScript, one file)
  src/index.ts           The whole app: routes, SSR pages, API, client JS
  wrangler.toml          Worker name tubeplus, D1 binding DB (tubeplus-db)
  package.json           wrangler pinned (4.158) via package-lock.json
  scripts/               check-client.mjs, check-slugify.mjs, check-v3.mjs
                         (unit tests), seed-local.mjs (local dev seed)
data/                    The data pipeline + seeds
  schema.sql             Current D1 schema (v3: published_at, playlists)
  build.py               Builds the seed from the Tristan Tube videos.json
                         (categories, tags, slugs) — see note below
  pass2.py               Tag pass 2 (channel topic tags, kills "general")
  slugs.py / ytutil.py   slugify + the shared tag helpers (Python side)
  gen_ts_tags.py         Generates the TS tag tables in src/index.ts
  seed_*.sql             The production seed (13 categories, 156 channels,
                         47,339 videos, 120 tags, 72,395 video-tag links)
  migrate_v3.sql         Migration for the LIVE D1 (apply once, manually)
  backfill_channel_category.sql
                         156 UPDATEs setting channels.category_id
ingest.py                Daily RSS ingest: new videos into D1
worker/migrations/        D1 migrations applied by hand (not on deploy)
```

## Run locally

```bash
cd worker
npm ci
node scripts/seed-local.mjs
npx wrangler d1 execute tubeplus-db --local --file=scripts/seed-local.sql
npm run dev    # http://localhost:8787
```

## Deploy

There is no GitHub Actions workflow in this repo (`.github/workflows` is
absent, and GitHub returns 404 for it). The last push to `main` does not
by itself update the live Worker. Production deploys are a manual
`wrangler deploy` from a `worker/` checkout that has Cloudflare credentials.
`data/gen_static.py` documents one such checkout on a separate host
(`~/tubeplus/worker`, wrangler on that machine) which regenerates the
static `/videos/` snapshot and redeploys. That is separate from this
GitHub repo — the live Worker can change without a push here.

From `worker/`, after `npm ci`:

```bash
# 1. Backfill channels.n on production D1 (required before the new
#    counts are right). Wrangler prompts for confirmation.
npx wrangler d1 migrations apply tubeplus-db --remote

# 2. Deploy the Worker. This does not apply migrations.
npx wrangler deploy
```

`data/migrate_v3.sql` was applied by hand already
(`npx wrangler d1 execute tubeplus-db --remote --file ../data/migrate_v3.sql`).
Do not re-run it. New schema changes go in `worker/migrations/` and are
applied with the command above. Nothing in this repo applies them on deploy.

## Daily ingest (new videos)

`ingest.py` reads the channel list from D1, fetches each channel's YouTube
RSS feed, and inserts videos not already in the catalog (slug, tags,
`published_at`, best-effort duration from the watch page). Idempotent —
re-running inserts nothing. Recommended schedule, daily 06:00 IST:

```bash
cd ~/tubeplus && python3 ingest.py --remote --apply
```

(The first catch-up run inserts ~800 videos in ~5 min; a daily re-run with
0 new takes ~3 min.) No cron is created by this repo; set the schedule up
separately.

## Rebuilding the seed

`data/build.py` regenerates the seed SQL from the original Tristan Tube
snapshot (`videos.json` — download it from
https://karpathy.ai/tristan-tube/videos.json). **Do not re-run build.py
against the live seed files** — it regenerates pass-1 tags and would revert
the pass-2 tag work; the seed SQL in this repo is the canonical source.

## Data

- Source: Tristan Hume's tier list, snapshot 2026-11-09 (156 channels,
  47,339 videos). Channel tier/tag/blurb are his.
- Categories (13): making, science, tech, history, space, vehicles, gaming,
  engineering, aviation, entertainment, music, food, outdoors — one per
  channel, keyword-derived from the channel's tag + blurb.
- Tags (120): keyword-extracted from video titles (pass 1), then channel
  topic tags filled in where a title had only "general" (pass 2) — zero
  "general"-only videos remain.
- Gaps in the source data: 834 videos have null views, 6 have null duration;
  both are preserved as NULL.
