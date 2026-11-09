# TubePlus

A YouTube-style viewer for every channel on Tristan Hume's YouTube tier list
(2026), rebuilt on **Cloudflare Workers + D1** — with a category and tags for
every video. Ported from the original Tristan Tube
(https://karpathy.ai/tristan-tube/), plus the features below. Live at
https://tubeplus.net.

## Stack

- Single self-contained Worker: `src/index.ts` (Hono app + HTML/CSS/client-JS
  inline in template strings — no build step beyond `tsc`)
- D1 binding `DB` (`tubeplus-db`, id `515b5d56-2556-4eae-bde9-061aca689163`)
- Custom domain `tubeplus.net`; the `workers.dev` host 301-redirects to it

## Features

- **Home feed** — video grid, dark YouTube-like theme, tier badges (S/A/B/C/D),
  duration overlay, channel + views under each card, infinite scroll via a
  sentinel calling `/api/videos`. The first page is **server-rendered** for a
  fast first paint; client JS takes over from there.
- **Filters** — tier chips, duration chips (Under 10 min / 30+ min), tag
  filter, sort dropdown (Most viewed / Most liked / Longest / Shortest /
  Shuffle / **Latest**), search box (title + tag search, hash-routed
  `#/search/<q>`), result counts. Categories live in the hamburger drawer.
- **New feed** — `/new` lists videos by `published_at` DESC (newest first),
  fed by the daily RSS ingest (`../ingest.py`).
- **Real pages (SEO)** — `/category/<slug>`, `/tag/<name>`,
  `/channel/<id>/<slug>`, all SSR with `<title>`, meta description,
  canonical, OG, and JSON-LD (CollectionPage). Unknown → 404; wrong channel
  slug → 301 to canonical. Legacy `#/c/<id>` converts to the canonical
  channel path. All 13 categories, 120 tags, 156 channels, `/new`, and
  playlists are in `/sitemap-pages.xml`.
- **Hamburger drawer** — the ☰ button opens a slide-in drawer with the
  category list (13 categories, with counts), the tier-grouped channel list,
  and links to `/new`, `/playlists`, `/add-channel`, and `/import-playlist`.
  Drawer category/channel links are real paths (client intercepts them with
  pushState).
- **Likes** — heart button on every card and the watch page. Counts live in
  the `likes` D1 table (`POST /api/videos/:id/like`), liked video ids are
  remembered in localStorage, and "Most liked" sorts the feed by like count.
- **Channel page** `/channel/<id>/<slug>` — header (avatar, name, tier,
  blurb, video count) + its videos, sortable.
- **Watch page** `/watch/<id>/<slug>` — YouTube IFrame API embed, title,
  channel, views, duration, clickable tags, like button, category link,
  up-next list, Next-random button, autoplay toggle (persisted in
  localStorage). SEO-friendly slug URL with 301-to-canonical.
- **Add a channel** — `/add-channel`: paste a YouTube channel URL, @handle,
  or raw UC ID + pick a tier + category. Resolves the channel, fetches its
  RSS, and adds it + its videos live immediately (no approval queue).
  Duplicates show "Already listed" with a link to the channel page.
- **Import from a YouTube playlist** — `/import-playlist`: paste a public
  playlist URL or PL ID. Fetches the playlist RSS and adds each video to
  the catalog (creating missing channels as tier D). Reports added vs
  already-present. This does **not** create a TubePlus playlist.
- **Playlists** — `/playlists/new` creates a public playlist from catalog
  videos (search/pick, paste URLs/IDs, or "＋ Playlist" on cards and the
  watch page). Public URL `/playlist/<id>/<slug>` (SSR, OG image = first
  video's thumbnail, JSON-LD ItemList, "Play all"). The creator gets a
  32-hex edit token (localStorage); edit affordances and the add/remove/
  reorder/edit/delete API endpoints require it. `/playlists` lists them all.
- **TubePlus picks** `#/picks`, **Surprise me** (`/api/random`, `Shift+N`),
  **TV mode** (fullscreen lean-back player, keyboard-driven), **theme
  toggle** (dark/light, localStorage, no-flash).

## API

All queries are parameterized (user input is never interpolated into SQL).
Search escapes `%`/`_` in `LIKE` and also matches tag names.

| Route | Notes |
|---|---|
| `GET /api/videos?channel=&tier=&category=&tag=&q=&len=&sort=&page=&limit=` | `limit` default 24, max 60. Returns `{videos:[{id,title,slug,dur,views,likes,published_at,channel:{id,name,slug,tier,url,tag,blurb,featured,video_count},category,tags[]}], nextPage, total}`. `sort`: `views` (default), `likes`, `longest`, `shortest`, `shuffle`, `latest` (published_at DESC, NULLs last, then rowid DESC). `len`: `short` (<600s), `long` (≥1800s). `category` accepts slug or numeric id; `tag` accepts name or numeric id; `channel` is a numeric id. |
| `GET /api/videos/:id` | One video, same shape. 404 if missing. |
| `POST /api/videos/:id/like` | JSON body `{"action":"like"}` or `{"action":"unlike"}`. Returns `{id, likes}`. 400 on a bad action/body, 404 if the video does not exist. |
| `GET /api/videos?picks=1` | One featured video per channel (`channels.featured`). |
| `GET /api/categories` | `[{id,slug,name,count}]`, most videos first. |
| `GET /api/tags?limit=` | `[{id,name,count}]`, most used first (default limit 100). |
| `GET /api/random` | One random video, same shape as `/api/videos/:id`. |
| `GET /api/channels` | `[{id,name,slug,url,tier,tag,blurb,featured,n,video_count}]`, grouped S→D, alphabetical within tier. |
| `GET /api/playlists` | `[{id,slug,title,description,created_at,video_count,first_video_id}]`, created_at DESC, paginated. |
| `GET /api/playlists/:id` | Playlist + its videos in position order. 404 if missing. |
| `POST /api/playlists/:id/add\|remove\|reorder\|edit\|delete` | JSON body must include `token` (the creator's edit token). 403 on mismatch. `reorder` takes `video_ids` (the exact set, in the new order). |
| `POST /api/import-playlist` | JSON body `{"playlist_id": "PL...", "category": "entertainment"}`. Returns `{playlist_id, playlist_title, added, present, total, video_ids}`. |

## D1 schema

```sql
categories(id, slug, name)
channels(id, name, url, tier, tag, blurb, featured, n, category_id)
videos(id, title, slug, duration_s, views, channel_id, category_id, published_at)
tags(id, name)
video_tags(video_id, tag_id)
likes(video_id, likes)
playlists(id, slug, title, description, created_at, updated_at, edit_token)
playlist_videos(playlist_id, video_id, position)
```

`videos.id` is the YouTube video id; thumbnails are
`https://i.ytimg.com/vi/<id>/mqdefault.jpg`. `channels.featured` is the
YouTube id of that channel's pick (or NULL). `videos.published_at` is set
only for videos added by the RSS ingest (seed videos are NULL).
`playlists.id` is a short random alphanumeric id (10 chars);
`playlists.edit_token` is a 32-hex-char token held in the creator's browser.

## Deploy

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run deploy      # wrangler deploy
```

The D1 database must already exist and be populated (schema + the videos).
Schema changes live in `../data/migrate_v3.sql` and are applied **manually**
(`wrangler d1 execute tubeplus-db --remote --file ../data/migrate_v3.sql`);
the GitHub Actions deploy does not apply migrations.

## Local development (no Cloudflare credentials needed)

```bash
npm install
node scripts/seed-local.mjs        # builds scripts/seed-local.sql from the
                                   # Tristan Tube snapshot (first 200 videos,
                                   # all 156 channels, 13 categories,
                                   # ~30 keyword tags) — LOCAL ONLY
npx wrangler d1 execute tubeplus-db --local --file=scripts/seed-local.sql
npm run dev                        # wrangler dev --local, http://localhost:8787
```

`seed-local.mjs` reads `~/workspace/your_files/tristan-tube-videos.json`.
The 13 categories and tag assignments in the seed are keyword-based
approximations for local testing — production categories/tags come from the
real D1. Never run `seed-local.sql` against the remote database.

## Tests

```bash
npx tsc --noEmit
node scripts/check-client.mjs      # extracted client JS passes node --check
node scripts/check-slugify.mjs     # TS slugify == Python slugify on all titles
node scripts/check-v3.mjs          # RSS parsing, TS tagger == Python pipeline
                                   # on all 47,339 titles, ID parsers
```

`check-v3.mjs` needs `/tmp/rss_wintergatan.xml`,
`/tmp/rss_playlist.xml` (curl-saved YouTube RSS feeds) and
`/tmp/tagcheck.json` (`[{id, title, channel, tags}]` from
`../data/enriched.json`).
