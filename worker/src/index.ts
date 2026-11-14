import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// TubePlus — a YouTube-style viewer on Cloudflare Workers + D1.
// Port of karpathy.ai/tristan-tube (single static videos.json) to a real
// database-backed app, plus categories and tags per video.
//
// Data model (D1 — the Worker reads everything; writes: likes, channels,
// videos (RSS ingest), playlists, playlist_videos):
//   categories(id, slug, name)
//   channels(id, name, url, tier, tag, blurb, featured, n, category_id)
//   videos(id, title, slug, duration_s, views, channel_id, category_id,
//          published_at)
//   tags(id, name)
//   video_tags(video_id, tag_id)
//   likes(video_id, likes)
//   playlists(id, slug, title, description, created_at, updated_at,
//             edit_token)
//   playlist_videos(playlist_id, video_id, position)
//
// Routes: / (home), /new, /category/:slug, /tag/:name, /channel/:id/:slug?,
// /add-channel, /import-playlist, /playlists, /playlists/new,
// /playlist/:id/:slug?, /watch/:id/:slug?, /api/*, /sitemap*.xml,
// /robots.txt, /health. Real pages are SSR on direct load and
// pushState-rendered client-side; watch pages use pushState.
// No login anywhere: likes are D1 counts + per-browser localStorage;
// playlists are D1 rows + a per-browser edit token in localStorage.
// New videos come from YouTube channel RSS (see ~/workspace/tubeplus/ingest.py).
// ---------------------------------------------------------------------------

type Env = { Bindings: { DB: D1Database } }
const app = new Hono<Env>()

// Domain move: the site now lives at tubeplus.net. Any request that still
// arrives on the *.workers.dev host is 301-redirected to the same path on
// the custom domain, so search engines consolidate on tubeplus.net instead
// of indexing both hosts. (Local dev on localhost is unaffected.)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  if (url.hostname === 'tubeplus.www5.workers.dev') {
    return c.redirect(`https://tubeplus.net${url.pathname}${url.search}`, 301)
  }
  await next()
})

// Workers do not CDN-cache HTML on their own. Store GET responses that opted
// in with Cache-Control so a repeat hit (crawler or browser) skips D1.
// Colo-local Cache API; the header TTL is the lifetime.
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET') {
    await next()
    return
  }
  const url = new URL(c.req.url)
  const key = new Request(url.origin + url.pathname + url.search, { method: 'GET' })
  try {
    const hit = await caches.default.match(key)
    if (hit) return hit
  } catch {
    // Cache API is best-effort (unavailable in some local runs).
  }
  await next()
  if (c.res.status !== 200) return
  const cc = c.res.headers.get('cache-control') ?? ''
  if (!/max-age=([1-9]\d*)/.test(cc)) return
  try {
    const cached = c.res.clone()
    c.executionCtx.waitUntil(caches.default.put(key, cached).catch(() => {}))
  } catch {
    // ignore
  }
})

const TIERS = ['S', 'A', 'B', 'C', 'D'] as const
type Tier = (typeof TIERS)[number]
const TIER_NAMES: Record<Tier, string> = {
  S: 'Masterpieces',
  A: 'Horizon-expanding',
  B: 'Basically every video is great',
  C: 'Lots of excellent videos',
  D: 'Good quality stuff',
}

const PAGE_LIMIT_DEFAULT = 24
const PAGE_LIMIT_MAX = 60
// Edge + browser TTL. Watch pages are the crawler hotspot (sitemap is ~49k
// URLs); listings change only when the daily ingest runs.
const CACHE_HTML_WATCH = 24 * 60 * 60
const CACHE_HTML_LIST = 6 * 60 * 60
const DRAWER_TTL_SECONDS = 6 * 60 * 60
const DRAWER_CACHE_URL = 'https://tubeplus.net/__cache/drawer-v1'

// ---------------------------------------------------------------------------
// CSS — ported from the original Tristan Tube, plus TubePlus additions:
// .tags/.tag (tag pills on cards + watch page), .filterrow, .like-btn,
// .sortwrap, .activetag, .rescount, .watchtags/.watchcat, #drawer/#backdrop.
// ---------------------------------------------------------------------------
const CSS = `:root {
  --bg: #0f0f0f; --bg2: #181818; --bg3: #272727; --bg4: #3a3a3a;
  --fg: #f1f1f1; --fg2: #aaaaaa; --accent: #e5484d;
  --tS: #ff7a7a; --tA: #ffb46b; --tB: #ffe066; --tC: #9be38a; --tD: #7cc4ff;
  --radius: 12px;
}
:root[data-theme="light"] {
  --bg: #ffffff; --bg2: #f6f6f6; --bg3: #ececec; --bg4: #d9d9d9;
  --fg: #0f0f0f; --fg2: #606060;
  --tS: #d63a3a; --tA: #d9761a; --tB: #b08d00; --tC: #2f9a3a; --tD: #1f7ad1;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #ffffff; --bg2: #f6f6f6; --bg3: #ececec; --bg4: #d9d9d9;
    --fg: #0f0f0f; --fg2: #606060;
    --tS: #d63a3a; --tA: #d9761a; --tB: #b08d00; --tC: #2f9a3a; --tD: #1f7ad1;
  }
}
:root { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; } }

/* Visually hidden but present for screen readers and search engines (homepage H1). */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* Round icon buttons in the top bar */
.icon-btn {
  flex: none; width: 40px; height: 40px; border-radius: 50%; border: 0; background: transparent;
  display: grid; place-items: center; font-size: 18px; font-weight: 700;
}
.icon-btn:hover, .icon-btn.active { background: var(--bg3); }
.icon-btn svg { width: 22px; height: 22px; fill: var(--fg); }
.theme-light-icon { display: none; }
:root[data-theme="light"] .theme-light-icon { display: block; }
:root[data-theme="light"] .theme-dark-icon { display: none; }
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .theme-light-icon { display: block; }
  :root:not([data-theme="dark"]) .theme-dark-icon { display: none; }
}

/* TV mode: a fullscreen lean-back player */
#tv { position: fixed; inset: 0; z-index: 100; background: #000; display: none; color: #fff; }
#tv.open { display: block; }
#tv .tvplayer, #tv .tvplayer iframe, #tv .tvplayer > div { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
#tv .tvcatch { position: absolute; inset: 0; cursor: none; }
#tv.show-ui .tvcatch { cursor: default; }
#tv .osd {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 100px 48px 32px; pointer-events: none;
  background: linear-gradient(transparent, rgba(0,0,0,.88)); opacity: 0; transition: opacity .4s;
}
#tv .top { position: absolute; right: 0; top: 0; padding: 24px 32px; pointer-events: none; opacity: 0; transition: opacity .4s; }
#tv.show-ui .osd, #tv.show-ui .top { opacity: 1; }
#tv .exit { pointer-events: auto; background: rgba(255,255,255,.15); color: #fff; border: 0; border-radius: 18px; height: 36px; padding: 0 14px; font-weight: 500; }
#tv .exit:hover { background: rgba(255,255,255,.28); }
#tv .ttl { font-size: clamp(20px, 2.6vw, 34px); font-weight: 700; line-height: 1.2; max-width: 1100px; text-shadow: 0 1px 8px rgba(0,0,0,.6); }
#tv .chn { margin-top: 8px; font-size: clamp(14px, 1.3vw, 18px); opacity: .85; display: flex; align-items: center; gap: 8px; }
#tv .chn .tier { color: #111; }
#tv .barrow { display: flex; align-items: center; gap: 14px; margin-top: 18px; font-size: 14px; font-variant-numeric: tabular-nums; }
#tv .bar { flex: 1; height: 5px; background: rgba(255,255,255,.25); border-radius: 3px; position: relative; }
#tv .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); border-radius: 3px; width: 0; }
#tv .bar b { position: absolute; top: -4px; width: 2px; height: 13px; background: rgba(255,255,255,.35); }
#tv .keys { margin-top: 14px; font-size: 13px; opacity: .65; }
#tv .keys kbd { font-family: inherit; border: 1px solid rgba(255,255,255,.4); border-radius: 4px; padding: 0 5px; margin-right: 3px; }
#tv .toast {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); pointer-events: none;
  background: rgba(0,0,0,.65); padding: 14px 24px; border-radius: 14px; font-size: 28px; font-weight: 700;
  opacity: 0; transition: opacity .25s;
}
#tv .toast.on { opacity: 1; }
@media (max-width: 700px) { #tv .osd { padding: 80px 16px 20px; } #tv .top { padding: 16px; } #tv .keys { display: none; } }

/* About page */
.about { max-width: 760px; margin: 0 auto; padding: 24px 0 40px; font-size: 15px; line-height: 1.6; }
.about h1 { font-size: 28px; margin: 0 0 8px; }
.about h2 { font-size: 18px; margin: 28px 0 8px; }
.about p { margin: 8px 0; }
.about a.link { color: #3ea6ff; text-decoration: underline; }
.about code, .about pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: var(--bg3); border-radius: 6px; }
.about code { padding: 1px 5px; }
.about pre { padding: 12px 14px; overflow-x: auto; line-height: 1.45; }
.about .stats { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.about .stat { background: var(--bg3); border-radius: 10px; padding: 8px 12px; display: flex; align-items: center; gap: 8px; }
.about .stat b { font-variant-numeric: tabular-nums; }
.about kbd { font-family: inherit; font-size: 12px; background: var(--bg3); border: 1px solid var(--bg4); border-bottom-width: 2px; border-radius: 5px; padding: 0 6px; }
.about ul { padding-left: 20px; margin: 8px 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); overflow-x: clip; }
body { font: 14px/1.4 "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }

/* Top bar */
header {
  position: sticky; top: 0; z-index: 20; height: 56px; padding: 0 16px;
  display: flex; align-items: center; gap: 16px; background: var(--bg);
}
.logo { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 19px; letter-spacing: -0.5px; white-space: nowrap; }
.logo svg { width: 30px; height: 22px; }
.search { flex: 1; max-width: 600px; margin: 0 auto; display: flex; }
.search input {
  flex: 1; min-width: 0; height: 40px; padding: 0 16px; border: 1px solid var(--bg4); border-right: 0;
  border-radius: 20px 0 0 20px; background: var(--bg); color: var(--fg); font-size: 15px; outline: none;
}
.search input:focus { border-color: #1c62b9; }
.search button { width: 64px; border: 1px solid var(--bg4); border-radius: 0 20px 20px 0; background: var(--bg3); }
.search button svg { width: 20px; height: 20px; fill: var(--fg); vertical-align: middle; }
.shuffle-btn {
  display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border: 0; border-radius: 18px;
  background: var(--bg3); font-weight: 500; white-space: nowrap;
}
.shuffle-btn:hover { background: var(--bg4); }
.shuffle-btn svg { width: 18px; height: 18px; fill: var(--fg); }

/* Layout */
.layout { display: flex; }
main { flex: 1; min-width: 0; padding: 0 24px 40px; }
@media (max-width: 1000px) { main { padding: 0 16px 40px; } }

/* Hamburger drawer */
#backdrop { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,.5); opacity: 0; pointer-events: none; transition: opacity .25s; }
#backdrop.open { opacity: 1; pointer-events: auto; }
#drawer {
  position: fixed; left: 0; top: 0; bottom: 0; width: 300px; z-index: 50; background: var(--bg);
  transform: translateX(-100%); transition: transform .25s ease; overflow-y: auto;
  padding: 8px 12px 24px; scrollbar-width: thin; box-shadow: 0 0 24px rgba(0,0,0,.4);
}
#drawer.open { transform: translateX(0); }
#drawer .item { display: flex; align-items: center; gap: 12px; padding: 0 12px; height: 38px; border-radius: 10px; width: 100%; border: 0; background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer; }
#drawer .item:hover, #drawer .item.active { background: var(--bg3); }
#drawer .item.on { background: var(--fg); color: var(--bg); }
#drawer h4 { margin: 16px 12px 6px; font-size: 15px; font-weight: 600; display: flex; gap: 8px; align-items: center; }
#drawer hr { border: 0; border-top: 1px solid var(--bg3); margin: 10px 0; }
#drawer .ch { height: 34px; font-size: 13.5px; }
#drawer .ch span.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#drawer .cnt { margin-left: auto; color: var(--fg2); font-size: 11px; font-variant-numeric: tabular-nums; }
#drawer .item.on .cnt { color: inherit; opacity: .7; }
#drawer .item svg { width: 22px; height: 22px; fill: var(--fg); flex: none; }
@media (max-width: 560px) {
  .logo span { display: none; } .shuffle-btn span { display: none; } header { gap: 8px; padding: 0 10px; }
  .search button { width: 44px; } .shuffle-btn { padding: 0 9px; } .icon-btn { width: 34px; height: 34px; }
}

/* Avatars & tier badges */
.av {
  flex: none; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
  font-size: 11px; font-weight: 700; color: #111;
}
.tier { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 5px; font-size: 12px; font-weight: 800; color: #111; }
.tS { background: var(--tS); } .tA { background: var(--tA); } .tB { background: var(--tB); } .tC { background: var(--tC); } .tD { background: var(--tD); }

/* Chips */
.chips { position: sticky; top: 56px; z-index: 10; background: var(--bg); display: flex; gap: 12px; padding: 12px 0; overflow-x: auto; scrollbar-width: none; }
.chip { flex: none; height: 32px; padding: 0 12px; border-radius: 8px; border: 0; background: var(--bg3); font-weight: 500; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.chip:hover { background: var(--bg4); }
.chip.on { background: var(--fg); color: var(--bg); }
.filterrow { display: flex; align-items: center; gap: 16px; padding: 0 0 4px; flex-wrap: wrap; }
.rescount { color: var(--fg2); font-size: 13px; font-variant-numeric: tabular-nums; }
.sortwrap { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--fg2); font-size: 13px; }
.sortwrap select {
  height: 32px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--bg4);
  background: var(--bg3); color: var(--fg); font: inherit; font-size: 13px; outline: none;
}
.activetag {
  display: inline-flex; align-items: center; gap: 8px; margin: 0 0 8px; padding: 4px 6px 4px 12px;
  background: var(--bg3); border-radius: 18px; font-size: 13px;
}
.activetag button {
  border: 0; background: var(--bg4); color: var(--fg); border-radius: 50%;
  width: 20px; height: 20px; line-height: 1; font-size: 14px;
}

/* Video grid */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 40px 16px; padding-top: 12px; }
@media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
.card { display: block; min-width: 0; }
.thumb { position: relative; aspect-ratio: 16/9; border-radius: var(--radius); overflow: hidden; background: var(--bg3); }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s; }
.card:hover .thumb img { transform: scale(1.03); }
.dur { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.8); color: #fff; font-size: 12px; font-weight: 500; padding: 1px 4px; border-radius: 4px; }
.pick { position: absolute; left: 6px; top: 6px; background: rgba(0,0,0,.8); color: #ffd84d; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; }
.meta { display: flex; gap: 12px; margin-top: 12px; }
.meta .t { font-weight: 500; font-size: 16px; line-height: 22px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.meta .sub { color: var(--fg2); margin-top: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.meta .sub .tier { height: 16px; min-width: 16px; font-size: 10px; padding: 0 3px; border-radius: 4px; }
.meta .sub a:hover { color: var(--fg); }
.tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.tag {
  border: 0; background: var(--bg3); color: var(--fg2); font-size: 12px; font-weight: 500;
  padding: 3px 9px; border-radius: 12px; cursor: pointer;
}
.tag:hover { background: var(--bg4); color: var(--fg); }
.likerow { margin-top: 8px; }
.like-btn {
  border: 0; background: var(--bg3); color: var(--fg2); font-size: 13px; font-weight: 500;
  padding: 4px 10px; border-radius: 16px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
}
.like-btn:hover { background: var(--bg4); color: var(--fg); }
.like-btn .heart { font-size: 14px; line-height: 1; }
.like-btn.liked { color: #ff4d6d; }
.like-btn.big { font-size: 15px; padding: 8px 16px; border-radius: 18px; }
.like-btn.big .heart { font-size: 17px; }
.sentinel { height: 1px; }
.empty { color: var(--fg2); padding: 60px 0; text-align: center; font-size: 16px; }

/* Watch page */
.watch { display: flex; gap: 24px; padding-top: 24px; max-width: 1750px; margin: 0 auto; }
.watch .primary { flex: 1; min-width: 0; }
.watch .secondary { width: 400px; flex: none; }
@media (max-width: 1100px) { .watch { flex-direction: column; } .watch .secondary { width: 100%; } }
.player { aspect-ratio: 16/9; background: #000; border-radius: var(--radius); overflow: hidden; }
.player iframe, .player > div { width: 100%; height: 100%; display: block; border: 0; }
.watch h1 { font-size: 20px; line-height: 28px; margin: 12px 0 0; font-weight: 700; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wmeta { margin-top: 8px; color: var(--fg2); font-size: 14px; line-height: 20px; }
.wmeta .wm-ch { color: var(--fg); font-weight: 600; }
.wmeta .wm-ch:hover { text-decoration: underline; }
.wmeta .wtag { color: var(--fg2); }
.wmeta .wtag:hover { text-decoration: underline; }
.wmeta .wmore { background: none; border: 0; padding: 0; color: var(--fg); font-weight: 600; cursor: pointer; white-space: nowrap; }
.wdesc { background: var(--bg3); border-radius: var(--radius); padding: 12px; margin-top: 12px; }
.wdesc[hidden] { display: none; }
.wdesc .why { white-space: pre-wrap; }
.wdesc .why b { display: block; margin-bottom: 2px; }
.wdesc .ytlink { color: #3ea6ff; }
.wrow { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.wrow .av { width: 40px; height: 40px; font-size: 16px; flex: none; }
.wrow .pill { flex: none; }
.wrow .wacts { margin-left: auto; display: flex; gap: 6px; align-items: center; flex: none; }
.icobtn { width: 36px; height: 36px; border-radius: 50%; border: 0; background: var(--bg3); color: var(--fg); font-size: 18px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; text-decoration: none; flex: none; }
.icobtn:hover { background: var(--bg4); }
.pill { height: 36px; padding: 0 16px; border-radius: 18px; border: 0; background: var(--bg3); font-weight: 500; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; flex-shrink: 0; }
.pill:hover { background: var(--bg4); }
.pill.primary { background: var(--fg); color: var(--bg); }
.pill input { accent-color: var(--accent); margin: 0; }
.upnext-h .autoplay { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg2); font-weight: 500; cursor: pointer; }
.upnext-h .autoplay input { accent-color: var(--accent); margin: 0; }
.upnext-h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.upnext-h h3 { margin: 0; font-size: 16px; }
.mini { display: flex; gap: 8px; margin-bottom: 8px; border-radius: 8px; }
.mini .thumb { width: 168px; flex: none; border-radius: 8px; }
.mini .t { font-weight: 500; font-size: 14px; line-height: 20px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mini .sub { color: var(--fg2); font-size: 12px; margin-top: 4px; display: flex; gap: 5px; align-items: center; }
.mini .sub .tier { height: 15px; min-width: 15px; font-size: 9.5px; padding: 0 3px; border-radius: 3px; }

/* Channel page */
.chhead { display: flex; gap: 24px; align-items: center; padding: 24px 0 8px; }
.chhead .av { width: 120px; height: 120px; font-size: 44px; }
.chhead h1 { margin: 0; font-size: 32px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.chhead .sub { color: var(--fg2); margin-top: 6px; }
.chhead .blurb { margin-top: 8px; max-width: 800px; color: var(--fg2); }
.chhead .actions { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
@media (max-width: 700px) { .chhead .av { width: 64px; height: 64px; font-size: 24px; } .chhead h1 { font-size: 22px; } .chhead { gap: 14px; } }
.pagetitle { font-size: 20px; margin: 20px 0 0; }
.pagesub { color: var(--fg2); margin: 8px 0 16px; max-width: 800px; }
.pagesub a { color: #3ea6ff; text-decoration: underline; }
.formerr { background: #e5484d22; border: 1px solid #e5484d; color: #ff8a8e; border-radius: 8px; padding: 10px 12px; margin: 12px 0; max-width: 640px; }
.plainform { display: flex; flex-direction: column; gap: 14px; max-width: 640px; }
.plainform label { display: flex; flex-direction: column; gap: 6px; font-weight: 500; font-size: 14px; }
.plainform input[type="text"], .plainform input[type="search"], .plainform textarea, .plainform select { background: var(--bg2); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 14px; width: 100%; box-sizing: border-box; }
.plainform textarea { resize: vertical; }
.pill.small { padding: 4px 8px; font-size: 12px; }
.plitem { display: block; padding: 14px 0; border-bottom: 1px solid var(--border); }
.plitem .pltitle { font-size: 17px; font-weight: 600; }
.plitem .plsub { color: var(--fg2); font-size: 13px; margin-top: 3px; }
.plitem .pldesc { color: var(--fg2); font-size: 13px; margin-top: 6px; }
.plvideo { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
.plvideo .plpos { color: var(--fg2); font-size: 14px; width: 22px; flex: none; text-align: center; }
.plvideo .mini { flex: 1; margin-bottom: 0; }
.pledit { display: flex; gap: 6px; flex: none; }
.plactions { display: flex; gap: 10px; align-items: center; margin: 12px 0 16px; flex-wrap: wrap; }
.pllist { max-width: 900px; }
.plsearchres { display: flex; flex-direction: column; gap: 4px; }
.plsearchres .plpick { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: var(--bg2); }
.plsearchres .plpick:hover { border-color: #3ea6ff; }
.plsearchres .plpick img { width: 80px; border-radius: 4px; }
.plsearchres .plpick .t { font-size: 13px; font-weight: 500; }
.plsearchres .plpick .s { font-size: 12px; color: var(--fg2); }
.plpicked { display: flex; flex-direction: column; gap: 4px; }
.plpicked .plrow { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); }
.plpicked .plrow .t { flex: 1; font-size: 13px; }
.addpl-btn { background: var(--bg2); border: 1px solid var(--border); color: var(--fg); border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.addpl-btn:hover { border-color: #3ea6ff; }
.chlink, .catlink { color: inherit; text-decoration: none; }
.chlink:hover, .catlink:hover { text-decoration: underline; }
.plmenu { position: fixed; z-index: 60; background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35); padding: 8px; min-width: 240px; max-width: 320px; }
.plmenu h4 { margin: 4px 8px 8px; font-size: 13px; color: var(--fg2); }
.plmenu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--fg); padding: 8px; border-radius: 6px; cursor: pointer; font-size: 14px; }
.plmenu button:hover { background: var(--bg); }
.empty { color: var(--fg2); padding: 32px 0; }
`

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------
const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
const thumb = (id: string): string => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
const initials = (n: string): string =>
  n
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?'
const av = (c: { name: string; tier: string }): string =>
  `<span class="av t${c.tier}">${esc(initials(c.name))}</span>`
const tierBadge = (t: string): string =>
  `<span class="tier t${t}" title="${t} tier: ${esc(TIER_NAMES[t as Tier] ?? t)}">${t}</span>`

const SITE_URL = 'https://tubeplus.net'

// SEO slug from a video title. Must match the Python slugify in
// ~/workspace/tubeplus/data/build.py exactly: NFKD, drop non-ASCII,
// lowercase, runs of non [a-z0-9] -> '-', truncate to 60 chars at a hyphen
// boundary (a single long word keeps its first 60 chars).
export function slugify(title: string): string {
  let t = (title || '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase()
  t = t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (t.length > 60) {
    const head = t.slice(0, 60)
    const idx = head.lastIndexOf('-')
    const cut = idx >= 0 ? head.slice(0, idx) : head
    t = (cut ? cut : head.replace(/-+$/, '')).replace(/^-+|-+$/g, '')
  }
  return t
}

// Generated by data/gen_ts_tags.py from ytutil.py (KW_NORM) and
// pass2.py (CHANNEL_TOPIC_TAGS) — do not edit by hand. Re-run the
// generator after any change to build.py's keywords or pass2.py.
// Keyword -> tag pairs, normalized, as "kw:tag|kw:tag|...".
const TAG_KEYWORDS_RAW = 'spacex:spacex|starship:starship|falcon:spacex|mars:mars|moon:moon|lunar:moon|satellite:satellite|satellites:satellite|nasa:nasa|rocket:rocket|rockets:rocket|telescope:telescope|microscope:microscope|3d print:3d-printing|3d printed:3d-printing|3d printing:3d-printing|3d printer:3d-printing|3d printers:3d-printing|laser:laser|lasers:laser|cnc:cnc|machining:machining|machinist:machining|lathe:machining|milling:machining|mill:machining|welding:welding|weld:welding|welder:welding|woodworking:woodworking|wood:woodworking|wooden:woodworking|carpentry:woodworking|blacksmith:blacksmith|forge:blacksmith|forging:blacksmith|metal:metalwork|casting:metalwork|cast:metalwork|steel:metalwork|aluminum:metalwork|aluminium:metalwork|copper:metalwork|knife:knife|knives:knife|sword:sword|swords:sword|katana:sword|saber:sword|sabre:sword|clock:clock|clockmaking:clock|lego:lego|raspberry pi:raspberry-pi|raspberry:raspberry-pi|arduino:arduino|esp32:electronics|python:python|javascript:javascript|c++:cpp|rust:rust|minecraft:minecraft|factorio:factorio|blender:blender|pcb:electronics|pcbs:electronics|microcontroller:electronics|fpga:electronics|electronics:electronics|electronic:electronics|circuit:electronics|circuits:electronics|soldering:electronics|solder:electronics|sensor:electronics|sensors:electronics|black hole:astronomy|astronomy:astronomy|astronomer:astronomy|galaxy:astronomy|universe:astronomy|nebula:astronomy|quantum:quantum|nuclear:nuclear|radiation:nuclear|radioactive:nuclear|uranium:nuclear|reactor:nuclear|physics:physics|physicist:physics|chemistry:chemistry|chemical:chemistry|math:math|mathematics:math|maths:math|biology:biology|biologist:biology|bacteria:biology|virus:biology|dna:biology|evolution:biology|animal:biology|animals:biology|geology:geology|volcano:geology|earthquake:geology|fossil:geology|rock:geology|weather:weather|storm:weather|rain:weather|snow:weather|tornado:weather|hurricane:weather|vacuum:vacuum|pressure:pressure|gravity:gravity|electricity:electricity|electric:electricity|voltage:electricity|magnet:magnet|magnetic:magnet|magnets:magnet|sound:sound|audio:sound|acoustic:sound|light:light|optics:light|optical:light|prism:light|water:water|fluid:water|hydro:water|fire:fire|flame:fire|flames:fire|ice:ice|frozen:ice|freeze:ice|energy:energy|solar:solar|battery:battery|batteries:battery|airplane:aviation|aircraft:aviation|plane:aviation|planes:aviation|jet:aviation|fighter:aviation|bomber:aviation|helicopter:aviation|glider:aviation|paramotor:aviation|paraglider:aviation|balloon:aviation|flight:aviation|flying:aviation|car:car|cars:car|truck:car|trucks:car|jeep:car|vehicle:car|vehicles:car|automobile:car|tesla:car|engine:engine|motor:engine|v8:engine|turbo:engine|diesel:engine|piston:engine|turbine:engine|boat:boat|ship:boat|ships:boat|submarine:boat|yacht:boat|cruise:boat|sailing:boat|kayak:boat|canoe:boat|train:train|trains:train|railway:train|locomotive:train|bike:bike|bicycle:bike|motorcycle:bike|bikes:bike|scooter:bike|tank:tank|tanks:tank|bridge:bridge|bridges:bridge|dam:dam|dams:dam|tunnel:tunnel|tunnels:tunnel|tower:tower|towers:tower|skyscraper:tower|gun:weapons|guns:weapons|rifle:weapons|pistol:weapons|cannon:weapons|missile:weapons|bomb:weapons|bombs:weapons|firearm:weapons|lock:lock|locks:lock|tool:tool|tools:tool|workshop:workshop|garage:workshop|factory:factory|manufacturing:factory|industrial:factory|mining:factory|history:history|historical:history|roman:history|rome:history|ancient:history|medieval:history|viking:history|war:war|wars:war|battle:war|battles:war|army:war|military:war|soldier:war|ww2:war|wwii:war|geography:geography|map:geography|maps:geography|country:geography|border:geography|geoguessr:geography|politics:politics|election:politics|president:politics|government:politics|business:business|startup:business|startups:business|money:business|cooking:cooking|cook:cooking|recipe:cooking|food:cooking|kitchen:cooking|bread:cooking|chocolate:cooking|cheese:cooking|bbq:cooking|grill:cooking|baking:cooking|bake:cooking|survival:survival|wilderness:survival|camping:survival|shelter:survival|bushcraft:survival|hike:survival|hiking:survival|farming:farming|farm:farming|garden:farming|bees:farming|beekeeping:farming|chicken:farming|bee:farming|fishing:fishing|fish:fishing|hunting:hunting|guitar:guitar|guitars:guitar|piano:piano|music:music|musical:music|song:music|songs:music|singing:music|band:music|synth:music|drum:music|drums:music|art:art|painting:art|drawing:art|sculpture:art|comedy:comedy|funny:comedy|joke:comedy|jokes:comedy|prank:comedy|magic:magic|trick:magic|tricks:magic|illusion:magic|sport:sport|football:sport|soccer:sport|basketball:sport|race:sport|racing:sport|olympic:sport|olympics:sport|camera:camera|lens:camera|photo:camera|photography:camera|speedrun:speedrun|speedruns:speedrun|glitch:glitch|glitches:glitch|mario:gaming|zelda:gaming|pokemon:gaming|gaming:gaming|game:gaming|games:gaming|gamer:gaming|robot:robotics|robots:robotics|robotic:robotics|robotics:robotics|servo:robotics|servos:robotics|drone:drone|drones:drone|fpv:drone|quadcopter:drone|model:modeling|models:modeling|modeling:modeling|modelling:modeling|animation:animation|animated:animation|cgi:animation|programming:programming|programmer:programming|code:programming|coding:programming|software:programming|algorithm:programming|compiler:programming|computer:computer|computers:computer|pc:computer|laptop:computer|cpu:computer|gpu:computer|keyboard:computer|keyboards:computer|iphone:computer|samsung:computer|apple:computer|linux:computer|server:computer|servers:computer|ai:ai|artificial intelligence:ai|machine learning:ai|neural:ai|llm:ai|gpt:ai|chatgpt:ai|deep learning:ai|space:space|orbit:space|orbital:space|astronaut:space|astronauts:space|planet:space|planets:space|cosmos:space|diy:diy|build:build|built:build|building:build|builds:build|rebuild:build|tutorial:tutorial|how to:tutorial|guide:tutorial|explained:tutorial|explains:tutorial|explanation:tutorial|experiment:experiment|experiments:experiment|experimental:experiment|test:experiment|tested:experiment|testing:experiment|review:review|reviews:review|teardown:review|unboxing:review|comparison:review|vs:review|versus:review|challenge:challenge|challenges:challenge|impossible:challenge|world record:challenge|fastest:challenge|biggest:challenge|largest:challenge|smallest:challenge|longest:challenge|shortest:challenge|tallest:challenge|strongest:challenge|documentary:documentary|interview:interview|interviews:interview|timelapse:timelapse|time lapse:timelapse|slow motion:slow-motion|slow mo:slow-motion|slowmo:slow-motion|explosion:explosion|explosions:explosion|explode:explosion|exploding:explosion|crash:crash|crashes:crash|disaster:crash|disasters:crash|fail:crash|fails:crash|battleship:history|padlock:lock|padlocks:lock|picked:lock|picking:lock|gutted:lock|cylinder:lock|demoscene:animation|64k:animation|demo:animation|marble:music|mindcrack:minecraft|scicraft:minecraft|hardcore:gaming|boltr:review|combat:combat|fight:combat|fighting:combat|iron:metalwork|gold:metalwork|silver:metalwork|titanium:metalwork|brass:metalwork|bronze:metalwork|furnace:metalwork|foundry:metalwork|anvil:blacksmith|hammer:tool|drill:tool|drills:tool|screwdriver:tool|wrench:tool|pliers:tool|chisel:tool|clamp:tool|vise:tool|grinder:tool|sander:tool|bandsaw:tool|tablesaw:tool|chainsaw:tool|dremel:tool|multimeter:electronics|oscilloscope:electronics|antenna:electronics|antennas:electronics|radio:electronics|radar:electronics|gps:electronics|bluetooth:electronics|wifi:electronics|usb:electronics|charger:electronics|capacitor:electronics|resistor:electronics|transistor:electronics|diode:electronics|cable:electronics|cables:electronics|wire:electronics|bulb:light|lamp:light|flashlight:light|candle:light|glow:light|neon:light|uv:light|infrared:light|x ray:light|gamma:nuclear|proton:nuclear|neutron:nuclear|atom:nuclear|atomic:nuclear|electron:electricity|electrons:electricity|molecule:chemistry|molecules:chemistry|acid:chemistry|salt:chemistry|polymer:chemistry|enzyme:biology|gene:biology|genes:biology|genetic:biology|genetics:biology|protein:biology|brain:biology|heart:biology|blood:biology|bone:biology|bones:biology|muscle:biology|skin:biology|eye:biology|human:biology|humans:biology|dog:biology|dogs:biology|cat:biology|cats:biology|bird:biology|birds:biology|snake:biology|spider:biology|insect:biology|insects:biology|ant:biology|ants:biology|coral:biology|tree:farming|trees:farming|plant:farming|plants:farming|flower:farming|flowers:farming|seed:farming|seeds:farming|soil:farming|harvest:farming|crop:farming|crops:farming|wheat:farming|corn:farming|potato:cooking|tomato:cooking|onion:cooking|garlic:cooking|pepper:cooking|sugar:cooking|honey:cooking|milk:cooking|egg:cooking|eggs:cooking|meat:cooking|beef:cooking|pork:cooking|pizza:cooking|burger:cooking|sandwich:cooking|pasta:cooking|cake:cooking|cookie:cooking|cookies:cooking|ice cream:cooking|coffee:cooking|tea:cooking|beer:cooking|wine:cooking|whiskey:cooking|whisky:cooking|cocktail:cooking|smoker:cooking|oven:cooking|stove:cooking|fridge:cooking|refrigerator:cooking|freezer:cooking|ocean:water|sea:water|river:water|lake:water|island:geography|mountain:geography|mountains:geography|desert:geography|forest:geography|jungle:geography|cave:geology|caves:geology|crystal:geology|crystals:geology|diamond:geology|sail:boat|anchor:boat|pottery:art|science:science|tour:tour|tours:tour|power:energy|wind:energy|steam:engine|valve:engine|tire:car|tires:car|tyre:car|tyres:car|brake:car|brakes:car|suspension:car|exhaust:car|transmission:car|steering:car|drift:car|drifting:car|offroad:car|off road:car|4x4:car|road:car|shark:fishing|print:3d-printing|printed:3d-printing|printing:3d-printing|printer:3d-printing|impressions:review|first look:review|hands on:review|making:build|make:build|made:build|makes:build|project:build|custom:build|homemade:diy|handmade:diy|update:update|updates:update|vlog:vlog|vlogs:vlog|live:live|livestream:live|sodium:chemistry|plasma:physics|teeth:biology|tooth:biology|sun:space|dagger:sword|daggers:sword|damascus:metalwork|armor:war|armour:war|navy:war|gunpowder:weapons|uss:war|king:history|queen:history|emperor:history|empire:history|rainbow:light|meteor:space|meteors:space|atari:gaming|nintendo:gaming|sega:gaming|playstation:gaming|xbox:gaming|papers:ai|technology:tech|technologies:tech|engineering:engineering|engineer:engineering|engineers:engineering|design:design|designs:design|designer:design|rescue:car|nhrl:combat|ford:car|toyota:car|honda:car|bmw:car|mercedes:car|ferrari:car|porsche:car|lamborghini:car|audi:car|volkswagen:car|vw:car|chevy:car|chevrolet:car|nissan:car|subaru:car|mazda:car|hyundai:car|kia:car|china:geography|japan:geography|germany:geography|france:geography|britain:geography|england:geography|america:geography|usa:geography|russia:geography|india:geography|australia:geography|canada:geography|europe:geography|africa:geography|asia:geography';
const TAG_KEYWORDS: [string, string][] = TAG_KEYWORDS_RAW.split('|').map((p) => {
  const i = p.indexOf(':')
  return [p.slice(0, i), p.slice(i + 1)] as [string, string]
})
// Channel index -> curated topic tag(s) (pass-2 fallback).
const CHANNEL_TOPIC_TAGS: Record<number, string[]> = { 0: ['science'], 1: ['clock'], 2: ['engineering'], 3: ['animation'], 4: ['knife'], 5: ['science'], 6: ['business'], 8: ['engineering'], 9: ['science'], 10: ['chemistry'], 11: ['light'], 12: ['science'], 13: ['science'], 14: ['animation'], 15: ['engineering'], 16: ['programming', 'comedy'], 18: ['machining'], 19: ['engineering'], 20: ['engineering'], 21: ['history'], 22: ['rocket'], 23: ['biology'], 24: ['biology'], 25: ['electronics'], 26: ['science'], 27: ['crash'], 28: ['3d-printing'], 29: ['electronics'], 30: ['animation'], 31: ['car'], 32: ['car'], 33: ['war'], 34: ['geography'], 35: ['electronics'], 36: ['car'], 37: ['factory'], 38: ['minecraft'], 39: ['geography'], 40: ['engineering'], 41: ['science'], 42: ['tech'], 43: ['geography'], 44: ['war'], 45: ['machining'], 46: ['spacex'], 47: ['engine'], 48: ['math'], 49: ['machining'], 51: ['engineering'], 52: ['machining'], 53: ['tool'], 54: ['rocket'], 55: ['aviation'], 56: ['machining'], 57: ['animation'], 58: ['experiment'], 59: ['math'], 60: ['lego'], 61: ['speedrun'], 62: ['electronics'], 63: ['speedrun'], 64: ['car'], 65: ['combat'], 66: ['comedy'], 67: ['minecraft'], 68: ['space', 'gaming'], 69: ['combat'], 70: ['3d-printing'], 71: ['science'], 72: ['combat'], 73: ['aviation'], 74: ['factorio'], 75: ['combat'], 76: ['engineering'], 77: ['tech'], 78: ['light'], 79: ['music'], 80: ['comedy'], 81: ['electronics'], 82: ['science'], 83: ['space'], 84: ['car'], 85: ['space'], 86: ['blacksmith'], 87: ['science'], 88: ['lock'], 89: ['geography'], 90: ['tech'], 91: ['3d-printing'], 92: ['aviation'], 93: ['chemistry'], 94: ['chemistry'], 95: ['challenge'], 96: ['diy'], 97: ['tech'], 98: ['boat'], 99: ['electronics'], 100: ['diy'], 101: ['engineering'], 102: ['factory'], 103: ['3d-printing'], 104: ['engineering'], 105: ['geography'], 106: ['factorio'], 107: ['laser'], 108: ['robotics'], 109: ['3d-printing'], 110: ['aviation'], 111: ['war'], 112: ['chemistry'], 113: ['chemistry'], 114: ['chemistry'], 115: ['aviation'], 116: ['machining'], 117: ['physics'], 118: ['drone'], 119: ['car'], 120: ['diy'], 121: ['engineering'], 122: ['guitar'], 123: ['science'], 124: ['biology'], 125: ['history'], 126: ['robotics'], 127: ['gaming'], 128: ['rocket'], 129: ['comedy', 'robotics'], 130: ['robotics'], 131: ['aviation'], 132: ['cooking'], 133: ['programming'], 134: ['ai'], 136: ['chemistry'], 137: ['woodworking'], 138: ['metalwork'], 139: ['programming'], 140: ['science'], 141: ['lego'], 142: ['tool'], 143: ['science'], 144: ['programming'], 145: ['cooking'], 146: ['art'], 147: ['3d-printing'], 148: ['math', 'programming'], 149: ['camera'], 150: ['programming'], 151: ['minecraft'], 152: ['animation'], 153: ['blender'], 154: ['diy'], 155: ['build'] };

// Tagging for videos ingested from RSS (add-channel, playlist import).
// Mirrors data/ytutil.py exactly: norm keeps '+', keyword match is
// " <kw> " inside " <title> ", max 5 tags, 'general' fallback, then the
// channel's curated topic tag(s) when the title would otherwise be
// 'general'-only. The keyword data above is generated by data/gen_ts_tags.py.
export function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').replace(/\s+/g, ' ').trim()
}
export function tagsForTitle(title: string): string[] {
  const nt = ' ' + normTitle(title) + ' '
  const tags: string[] = []
  for (const [kw, tag] of TAG_KEYWORDS) {
    if (nt.includes(' ' + kw + ' ') && !tags.includes(tag)) {
      tags.push(tag)
      if (tags.length === 5) break
    }
  }
  return tags.length ? tags : ['general']
}
export function videoTagsFor(title: string, channelIdx: number): string[] {
  const tags = tagsForTitle(title)
  if (tags.length === 1 && tags[0] === 'general') {
    const topic = CHANNEL_TOPIC_TAGS[channelIdx]
    if (topic) return [...topic]
  }
  return tags
}

// Channel slug / URL. The channels table has no slug column, so the slug is
// derived from the name (same slugify as video titles).
export const channelSlug = (name: string): string => slugify(name)
export const channelURL = (c: { id: number; name: string }): string =>
  '/channel/' + c.id + '/' + channelSlug(c.name)

// --- RSS (YouTube channel / playlist feeds) --------------------------------
// Minimal parsing: the feed structure is regular enough, and the Worker has
// no DOMParser. Titles are XML-escaped; decode the common entities.
export function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
}
interface RssEntry {
  id: string
  title: string
  published: string | null
  views: number | null
  channelId: string
  author: string
}
interface RssFeed { title: string; channelId: string | null; entries: RssEntry[] }
export function parseRss(xml: string): RssFeed | null {
  const feedTitle = (xml.match(/<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/) || [])[1]
  const feedChannel = (xml.match(/<yt:channelId>([^<]+)<\/yt:channelId>/) || [])[1] || null
  const entries: RssEntry[] = []
  const blocks = xml.split('<entry>')
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i].split('</entry>')[0]
    const vid = (b.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1]
    if (!vid) continue
    const title = (b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]
    const pub = (b.match(/<published>([^<]+)<\/published>/) || [])[1] || null
    const ch = (b.match(/<yt:channelId>([^<]+)<\/yt:channelId>/) || [])[1] || ''
    const author = (b.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) || [])[1] || ''
    const viewsM = b.match(/<media:statistics views="(\d+)"/)
    entries.push({
      id: vid,
      title: title ? decodeXml(title.trim()) : '',
      published: pub,
      views: viewsM ? parseInt(viewsM[1], 10) : null,
      channelId: ch,
      author: author ? decodeXml(author.trim()) : '',
    })
  }
  return { title: feedTitle ? decodeXml(feedTitle.trim()) : '', channelId: feedChannel, entries }
}
async function fetchRss(url: string): Promise<RssFeed | null> {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return null
    const xml = await r.text()
    if (!xml.includes('<feed')) return null
    return parseRss(xml)
  } catch {
    return null
  }
}
// Best-effort duration from a watch page's lengthSeconds; null on failure.
async function fetchDuration(videoId: string): Promise<number | null> {
  try {
    const r = await fetch('https://www.youtube.com/watch?v=' + videoId, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return null
    const m = (await r.text()).match(/"lengthSeconds"\s*:\s*"(\d+)"/)
    return m ? parseInt(m[1], 10) : null
  } catch {
    return null
  }
}

// --- random ids / tokens ----------------------------------------------------
function randId(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => chars[b % chars.length]).join('')
}
function randToken(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
const nowIso = (): string => new Date().toISOString()

// Canonical watch URL for a video: /watch/<id>/<slug>, Stack-Overflow style
// (id first, so parsing is unambiguous — YouTube ids can contain '-').
const watchURL = (v: { id: string; slug?: string | null }): string =>
  '/watch/' + v.id + (v.slug ? '/' + v.slug : '')

function fmtDur(s: number | null | undefined): string {
  if (!s) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0')
}
function fmtViews(n: number | null | undefined): string {
  if (n == null) return ''
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B views'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M views'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K views'
  return n + ' views'
}

// Publish date shown as dd-mmm-yyyy ("28-Oct-2026").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDateAbs(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

// ---------------------------------------------------------------------------
// D1 row shapes + API shapes
// ---------------------------------------------------------------------------
interface VideoRow {
  id: string
  title: string
  slug: string | null
  duration_s: number | null
  views: number | null
  published_at: string | null
  channel_id: number
  ch_name: string
  ch_tier: string
  ch_url: string | null
  ch_tag: string | null
  ch_blurb: string | null
  ch_featured: string | null
  ch_n: number | null
  cat_id: number | null
  cat_slug: string | null
  cat_name: string | null
  tag_names: string | null
  likes: number
}
interface ApiVideo {
  id: string
  title: string
  slug: string
  dur: number | null
  views: number | null
  published_at: string | null
  channel: { id: number; name: string; slug: string; tier: string; url: string | null; tag: string | null; blurb: string | null; featured: string | null; n: number | null }
  category: { id: number; slug: string; name: string } | null
  tags: string[]
  likes: number
}
function toApiVideo(r: VideoRow): ApiVideo {
  return {
    id: r.id,
    title: r.title,
    // The slug lives in D1; recompute it only if a row somehow lacks one.
    slug: r.slug ?? slugify(r.title),
    dur: r.duration_s,
    views: r.views,
    published_at: r.published_at,
    channel: { id: r.channel_id, name: r.ch_name, slug: channelSlug(r.ch_name), tier: r.ch_tier, url: r.ch_url, tag: r.ch_tag, blurb: r.ch_blurb, featured: r.ch_featured, n: r.ch_n },
    category: r.cat_id != null ? { id: r.cat_id, slug: r.cat_slug ?? '', name: r.cat_name ?? '' } : null,
    tags: r.tag_names ? r.tag_names.split(',') : [],
    likes: r.likes ?? 0,
  }
}

interface ChannelRow {
  id: number
  name: string
  url: string | null
  tier: string
  tag: string | null
  blurb: string | null
  featured: string | null
  n: number | null
  video_count: number
}
interface CategoryRow {
  id: number
  slug: string
  name: string
  count: number
}
interface TagRow {
  id: number
  name: string
  count: number
}

// ---------------------------------------------------------------------------
// Video query builder — every user-supplied value is bound, never interpolated.
// ORDER BY comes from a validated allowlist only.
// ---------------------------------------------------------------------------
interface VideoFilter {
  channel?: number
  tier?: string
  category?: string // slug or numeric id
  tag?: string // name or numeric id
  q?: string
  len?: 'short' | 'long'
  sort?: 'views' | 'longest' | 'shortest' | 'shuffle' | 'latest' | 'likes'
  picks?: boolean
}

function videoWhere(f: VideoFilter): { clause: string; params: unknown[] } {
  const wh: string[] = []
  const params: unknown[] = []
  if (f.channel != null) {
    wh.push('v.channel_id = ?')
    params.push(f.channel)
  }
  if (f.tier && (TIERS as readonly string[]).includes(f.tier)) {
    wh.push('c.tier = ?')
    params.push(f.tier)
  }
  if (f.category) {
    if (/^\d+$/.test(f.category)) {
      wh.push('v.category_id = ?')
      params.push(parseInt(f.category, 10))
    } else {
      wh.push('cat.slug = ?')
      params.push(f.category)
    }
  }
  if (f.tag) {
    if (/^\d+$/.test(f.tag)) {
      wh.push('EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id AND vt.tag_id = ?)')
      params.push(parseInt(f.tag, 10))
    } else {
      wh.push('EXISTS (SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id AND t.name = ?)')
      params.push(f.tag)
    }
  }
  if (f.q) {
    // Escape LIKE wildcards in the user query; match titles and tag names.
    const like = '%' + f.q.replace(/[%_\\]/g, '\\$&') + '%'
    wh.push(
      "(v.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id AND t.name LIKE ? ESCAPE '\\'))",
    )
    params.push(like, like)
  }
  if (f.len === 'short') wh.push('v.duration_s IS NOT NULL AND v.duration_s < 600')
  else if (f.len === 'long') wh.push('v.duration_s IS NOT NULL AND v.duration_s >= 1800')
  if (f.picks) wh.push('v.id IN (SELECT featured FROM channels WHERE featured IS NOT NULL)')
  return { clause: wh.length ? 'WHERE ' + wh.join(' AND ') : '', params }
}

function videoOrder(sort?: string): string {
  switch (sort) {
    case 'longest':
      return 'v.duration_s DESC'
    case 'shortest':
      return '(v.duration_s IS NULL) ASC, v.duration_s ASC'
    case 'shuffle':
      return 'RANDOM()'
    case 'latest':
      // Newest first by RSS publish date; seed videos (published_at NULL)
      // sort last, then by recency of ingest (rowid).
      return '(v.published_at IS NULL) ASC, v.published_at DESC, v.rowid DESC'
    case 'likes':
      return 'COALESCE(l.likes, 0) DESC, v.views DESC'
    case 'views':
    default:
      return 'v.views DESC'
  }
}

const VIDEO_SELECT = `SELECT v.id, v.title, v.slug, v.duration_s, v.views, v.published_at, v.channel_id,
  c.name AS ch_name, c.tier AS ch_tier, c.url AS ch_url, c.tag AS ch_tag,
  c.blurb AS ch_blurb, c.featured AS ch_featured, c.n AS ch_n,
  cat.id AS cat_id, cat.slug AS cat_slug, cat.name AS cat_name,
  GROUP_CONCAT(t.name) AS tag_names,
  COALESCE(l.likes, 0) AS likes
FROM videos v
JOIN channels c ON c.id = v.channel_id
LEFT JOIN categories cat ON cat.id = v.category_id
LEFT JOIN video_tags vt ON vt.video_id = v.id
LEFT JOIN tags t ON t.id = vt.tag_id
LEFT JOIN likes l ON l.video_id = v.id`

// Catalog-wide filters only. Anything else still needs a real COUNT.
function isCatalogQuery(f: VideoFilter): boolean {
  return f.channel == null && !f.tier && !f.category && !f.tag && !f.q && !f.len && !f.picks
}
function isChannelOnlyQuery(f: VideoFilter): boolean {
  return f.channel != null && !f.tier && !f.category && !f.tag && !f.q && !f.len && !f.picks
}

// MAX(rowid) is a primary-key endpoint read (EXPLAIN: SEARCH), not a scan.
// Cached in the isolate so a crawl does not repeat it. Rowids are dense
// (videos are inserted, not deleted); a miss falls through to the next rowid.
let rowidHiMemo: { exp: number; hi: number } | null = null
async function videoRowidHi(db: D1Database): Promise<number> {
  const now = Date.now()
  if (rowidHiMemo && rowidHiMemo.exp > now) return rowidHiMemo.hi
  const row = await db.prepare('SELECT MAX(rowid) AS hi FROM videos').first<{ hi: number | null }>()
  const hi = row?.hi ?? 0
  rowidHiMemo = { exp: now + DRAWER_TTL_SECONDS * 1000, hi }
  return hi
}

// `limit` distinct video ids spread across the table. ~1 row read per id.
async function sampleVideoIds(db: D1Database, limit: number): Promise<string[]> {
  if (limit <= 0) return []
  const hi = await videoRowidHi(db)
  if (hi <= 0) return []
  const want = Math.min(limit, hi)
  const probes: number[] = []
  const used = new Set<number>()
  while (probes.length < want) {
    const rowid = 1 + Math.floor(Math.random() * hi)
    if (used.has(rowid)) continue
    used.add(rowid)
    probes.push(rowid)
  }
  const ph = probes.map(() => '?').join(',')
  const picked = await db
    .prepare(`SELECT id FROM videos WHERE rowid IN (${ph})`)
    .bind(...probes)
    .all<{ id: string }>()
  const ids: string[] = []
  const seen = new Set<string>()
  for (const r of picked.results ?? []) {
    if (!seen.has(r.id)) {
      seen.add(r.id)
      ids.push(r.id)
    }
  }
  if (ids.length < want) {
    const start = 1 + Math.floor(Math.random() * hi)
    const more = await db
      .prepare('SELECT id FROM videos WHERE rowid >= ? ORDER BY rowid LIMIT ?')
      .bind(start, want - ids.length)
      .all<{ id: string }>()
    for (const r of more.results ?? []) {
      if (!seen.has(r.id)) {
        seen.add(r.id)
        ids.push(r.id)
      }
    }
  }
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = ids[i]
    ids[i] = ids[j]
    ids[j] = tmp
  }
  return ids.slice(0, want)
}

async function videosByIds(db: D1Database, ids: string[]): Promise<ApiVideo[]> {
  if (!ids.length) return []
  const ph = ids.map(() => '?').join(',')
  const rows = await db
    .prepare(`${VIDEO_SELECT} WHERE v.id IN (${ph}) GROUP BY v.id`)
    .bind(...ids)
    .all<VideoRow>()
  const byId = new Map((rows.results ?? []).map((r) => [r.id, toApiVideo(r)]))
  const out: ApiVideo[] = []
  for (const id of ids) {
    const v = byId.get(id)
    if (v) out.push(v)
  }
  return out
}

async function countVideos(db: D1Database, f: VideoFilter): Promise<number> {
  // Unfiltered and channel-only totals are the precomputed channel counts.
  // The old COUNT joined videos × channels × categories (~3× a full scan).
  if (isCatalogQuery(f) || isChannelOnlyQuery(f)) {
    const drawer = await drawerData(db)
    if (isCatalogQuery(f)) return drawer.total
    const ch = drawer.channels.find((c) => c.id === f.channel)
    return ch?.video_count ?? ch?.n ?? 0
  }
  const { clause, params } = videoWhere(f)
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM videos v
       JOIN channels c ON c.id = v.channel_id
       LEFT JOIN categories cat ON cat.id = v.category_id ${clause}`,
    )
    .bind(...params)
    .first<{ total: number }>()
  return row?.total ?? 0
}

async function listShuffled(
  db: D1Database,
  f: VideoFilter,
  page: number,
  limit: number,
  withTotal: boolean,
): Promise<{ videos: ApiVideo[]; nextPage: number | null; total: number }> {
  const { clause, params } = videoWhere(f)
  let ids: string[]
  if (!clause) {
    // Hot path: watch-page "up next" and /api/random. Do not ORDER BY RANDOM()
    // over the tag join — that scanned ~394k rows to return 13.
    ids = await sampleVideoIds(db, limit + 1)
  } else {
    const rows = await db
      .prepare(
        `SELECT v.id FROM videos v
         JOIN channels c ON c.id = v.channel_id
         LEFT JOIN categories cat ON cat.id = v.category_id
         ${clause} ORDER BY RANDOM() LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<{ id: string }>()
    ids = (rows.results ?? []).map((r) => r.id)
  }
  const hasMore = ids.length > limit
  const videos = await videosByIds(db, ids.slice(0, limit))
  const total = withTotal ? await countVideos(db, f) : 0
  return { videos, nextPage: hasMore ? page + 1 : null, total }
}

async function listVideos(
  db: D1Database,
  f: VideoFilter,
  page: number,
  limit: number,
  opts?: { withTotal?: boolean },
): Promise<{ videos: ApiVideo[]; nextPage: number | null; total: number }> {
  const withTotal = opts?.withTotal !== false
  if (f.sort === 'shuffle') return listShuffled(db, f, page, limit, withTotal)
  const { clause, params } = videoWhere(f)
  const order = videoOrder(f.sort)
  const offset = (page - 1) * limit
  // Fetch one extra row to know whether another page exists.
  const rows = await db
    .prepare(`${VIDEO_SELECT} ${clause} GROUP BY v.id ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...params, limit + 1, offset)
    .all<VideoRow>()
  const all = rows.results ?? []
  const hasMore = all.length > limit
  const total = withTotal ? await countVideos(db, f) : 0
  return {
    videos: all.slice(0, limit).map(toApiVideo),
    nextPage: hasMore ? page + 1 : null,
    total,
  }
}

function parsePageLimit(url: URL): { page: number; limit: number } {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const rawLimit = parseInt(url.searchParams.get('limit') ?? String(PAGE_LIMIT_DEFAULT), 10) || PAGE_LIMIT_DEFAULT
  const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, rawLimit))
  return { page, limit }
}

function parseFilter(url: URL): VideoFilter {
  const p = url.searchParams
  const f: VideoFilter = {}
  const channel = p.get('channel')
  if (channel && /^\d+$/.test(channel)) f.channel = parseInt(channel, 10)
  const tier = p.get('tier')
  if (tier) f.tier = tier.toUpperCase()
  const category = p.get('category')
  if (category) f.category = category
  const tag = p.get('tag')
  if (tag) f.tag = tag
  const q = p.get('q')
  if (q) f.q = q.slice(0, 200)
  const len = p.get('len')
  if (len === 'short' || len === 'long') f.len = len
  const sort = p.get('sort')
  if (sort === 'views' || sort === 'longest' || sort === 'shortest' || sort === 'shuffle' || sort === 'latest' || sort === 'likes') f.sort = sort
  if (p.get('picks') === '1') f.picks = true
  return f
}

const json = (data: unknown, status = 200, cacheSeconds = 0): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  })

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.get('/api/videos', async (c) => {
  const url = new URL(c.req.url)
  const { page, limit } = parsePageLimit(url)
  const f = parseFilter(url)
  const res = await listVideos(c.env.DB, f, page, limit)
  return json(res, 200, f.sort === 'shuffle' ? 0 : 60)
})

app.get('/api/videos/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    `${VIDEO_SELECT} WHERE v.id = ? GROUP BY v.id`,
  )
    .bind(id)
    .first<VideoRow>()
  if (!row) return json({ error: 'Video not found' }, 404)
  const v = toApiVideo(row)
  // channels.n is maintained on write (and backfilled by the migration).
  return json({ ...v, channel: { ...v.channel, video_count: v.channel.n ?? 0 } }, 200, 60)
})

app.post('/api/videos/:id/like', async (c) => {
  const id = c.req.param('id')
  let body: { action?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const action = body.action
  if (action !== 'like' && action !== 'unlike') return json({ error: 'action must be "like" or "unlike"' }, 400)
  const exists = await c.env.DB.prepare('SELECT 1 AS ok FROM videos WHERE id = ?').bind(id).first<{ ok: number }>()
  if (!exists) return json({ error: 'Video not found' }, 404)
  if (action === 'like') {
    await c.env.DB.prepare(
      'INSERT INTO likes (video_id, likes) VALUES (?, 1) ON CONFLICT(video_id) DO UPDATE SET likes = likes + 1',
    )
      .bind(id)
      .run()
  } else {
    await c.env.DB.prepare('UPDATE likes SET likes = MAX(likes - 1, 0) WHERE video_id = ?').bind(id).run()
  }
  const row = await c.env.DB.prepare('SELECT likes FROM likes WHERE video_id = ?').bind(id).first<{ likes: number }>()
  return json({ id, likes: row?.likes ?? 0 })
})

app.get('/api/categories', async (c) => {
  const { categories } = await drawerData(c.env.DB)
  return json({ categories }, 200, DRAWER_TTL_SECONDS)
})

app.get('/api/tags', async (c) => {
  const url = new URL(c.req.url)
  const raw = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50
  const limit = Math.min(200, Math.max(1, raw))
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, COUNT(vt.video_id) AS count
     FROM tags t JOIN video_tags vt ON vt.tag_id = t.id
     GROUP BY t.id ORDER BY count DESC, t.name ASC LIMIT ?`,
  )
    .bind(limit)
    .all<TagRow>()
  return json({ tags: rows.results ?? [] }, 200, 300)
})

app.get('/api/random', async (c) => {
  const ids = await sampleVideoIds(c.env.DB, 1)
  const videos = await videosByIds(c.env.DB, ids)
  if (!videos.length) return json({ error: 'No videos' }, 404)
  return json(videos[0], 200, 0)
})

app.get('/api/channels', async (c) => {
  const { channels } = await drawerData(c.env.DB)
  const list = channels.map((ch) => ({ ...ch, slug: channelSlug(ch.name) }))
  return json({ channels: list }, 200, DRAWER_TTL_SECONDS)
})

// ---------------------------------------------------------------------------
// RSS ingest (shared by /add-channel and /import-playlist)
// ---------------------------------------------------------------------------
interface TagMap { [name: string]: number }

async function loadTagMap(db: D1Database): Promise<{ map: TagMap; maxId: number }> {
  const rows = await db.prepare('SELECT id, name FROM tags').all<{ id: number; name: string }>()
  const map: TagMap = {}
  let maxId = 0
  for (const r of rows.results ?? []) {
    map[r.name] = r.id
    if (r.id > maxId) maxId = r.id
  }
  return { map, maxId }
}

async function tagIdsFor(db: D1Database, names: string[], cache: { map: TagMap; maxId: number }): Promise<number[]> {
  const ids: number[] = []
  for (const name of names) {
    let id = cache.map[name]
    if (id == null) {
      cache.maxId += 1
      id = cache.maxId
      await db.prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)').bind(id, name).run()
      cache.map[name] = id
    }
    ids.push(id)
  }
  return ids
}

// Find a channel by its YouTube UC id (parsed from channels.url).
async function findChannelByUc(db: D1Database, ucId: string): Promise<{ id: number; name: string; category_id: number | null } | null> {
  const row = await db.prepare(
    'SELECT id, name, category_id FROM channels WHERE url LIKE ?',
  ).bind('%/channel/' + ucId).first<{ id: number; name: string; category_id: number | null }>()
  return row ?? null
}

// Create a channel (tier D, given category) and return its id.
async function createChannel(db: D1Database, ucId: string, name: string, catId: number): Promise<number> {
  const max = await db.prepare('SELECT MAX(id) AS m FROM channels').first<{ m: number | null }>()
  const id = (max?.m ?? -1) + 1
  await db.prepare(
    'INSERT INTO channels (id, name, url, tier, tag, blurb, featured, n, category_id) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, ?)',
  ).bind(id, name, 'https://www.youtube.com/channel/' + ucId, 'D', catId).run()
  return id
}

// Insert one RSS entry as a video (if not already present). Returns true if
// it was newly inserted. Duration is best-effort (pass it in when known).
async function insertVideo(
  db: D1Database,
  e: RssEntry,
  channelId: number,
  catId: number,
  dur: number | null,
  tagCache: { map: TagMap; maxId: number },
): Promise<boolean> {
  const exists = await db.prepare('SELECT 1 AS ok FROM videos WHERE id = ?').bind(e.id).first<{ ok: number }>()
  if (exists) return false
  await db.prepare(
    'INSERT OR IGNORE INTO videos (id, title, slug, duration_s, views, channel_id, category_id, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(e.id, e.title, slugify(e.title), dur, e.views, channelId, catId, e.published).run()
  const tags = videoTagsFor(e.title, channelId)
  const tids = await tagIdsFor(db, tags, tagCache)
  for (const tid of tids) {
    await db.prepare('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)').bind(e.id, tid).run()
  }
  return true
}

// Extract a playlist id from a URL (?list=PL...) or accept a raw PL id.
export function parsePlaylistId(input: string): string | null {
  const s = (input || '').trim()
  if (/^PL[A-Za-z0-9_-]+$/.test(s)) return s
  const m = s.match(/[?&]list=(PL[A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

// Extract a channel UC id from a /channel/UC... URL, a raw UC id, or null.
export function parseChannelUc(input: string): string | null {
  const s = (input || '').trim()
  if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return s
  const m = s.match(/\/channel\/(UC[A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

// Resolve a @handle to a UC id by fetching the handle page and parsing its
// canonical /channel/UC... URL. Best-effort; null on failure.
async function resolveHandle(handle: string): Promise<string | null> {
  const h = handle.trim().replace(/^@/, '')
  if (!/^[\w.-]+$/.test(h)) return null
  try {
    const r = await fetch('https://www.youtube.com/@' + encodeURIComponent(h), {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return null
    const html = await r.text()
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)"/)
      || html.match(/"channelId":"(UC[A-Za-z0-9_-]+)"/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Playlist API (no login; the creator holds an edit token)
// ---------------------------------------------------------------------------
interface PlaylistRow {
  id: string
  slug: string | null
  title: string
  description: string | null
  created_at: string
  updated_at: string
  edit_token: string
}
export const playlistURL = (p: { id: string; slug?: string | null }): string =>
  '/playlist/' + p.id + (p.slug ? '/' + p.slug : '')

async function getPlaylist(db: D1Database, id: string): Promise<{ pl: PlaylistRow; videos: ApiVideo[] } | null> {
  const pl = await db.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<PlaylistRow>()
  if (!pl) return null
  const rows = await db.prepare(
    `${VIDEO_SELECT} JOIN playlist_videos pv ON pv.video_id = v.id
     WHERE pv.playlist_id = ? GROUP BY v.id ORDER BY pv.position ASC`,
  ).bind(id).all<VideoRow>()
  return { pl, videos: (rows.results ?? []).map(toApiVideo) }
}

async function checkEditToken(db: D1Database, id: string, token: unknown): Promise<PlaylistRow | null> {
  if (typeof token !== 'string' || !token) return null
  const pl = await db.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<PlaylistRow>()
  if (!pl || pl.edit_token !== token) return null
  return pl
}

app.get('/api/playlists', async (c) => {
  const url = new URL(c.req.url)
  const { page, limit } = parsePageLimit(url)
  const rows = await c.env.DB.prepare(
      `SELECT p.*, COUNT(pv.video_id) AS count FROM playlists p
       LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(limit, (page - 1) * limit)
    .all<PlaylistRow & { count: number }>()
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM playlists').first<{ n: number }>()
  const playlists = (rows.results ?? []).map((p) => ({
    id: p.id, slug: p.slug ?? slugify(p.title), title: p.title,
    description: p.description, created_at: p.created_at, updated_at: p.updated_at,
    count: p.count,
  }))
  return json({ playlists, nextPage: (total?.n ?? 0) > page * limit ? page + 1 : null, total: total?.n ?? 0 }, 200, 60)
})

app.get('/api/playlists/:id', async (c) => {
  const got = await getPlaylist(c.env.DB, c.req.param('id'))
  if (!got) return json({ error: 'Playlist not found' }, 404)
  const { pl, videos } = got
  return json({
    id: pl.id, slug: pl.slug ?? slugify(pl.title), title: pl.title,
    description: pl.description, created_at: pl.created_at, updated_at: pl.updated_at,
    videos,
  }, 200, 60)
})

app.post('/api/playlists/:id/add', async (c) => {
  const id = c.req.param('id')
  let body: { token?: unknown; video_id?: unknown }
  try { body = await c.req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const pl = await checkEditToken(c.env.DB, id, body.token)
  if (!pl) return json({ error: 'Invalid edit token' }, 403)
  const vid = typeof body.video_id === 'string' ? body.video_id : ''
  if (!vid) return json({ error: 'video_id is required' }, 400)
  const exists = await c.env.DB.prepare('SELECT 1 AS ok FROM videos WHERE id = ?').bind(vid).first<{ ok: number }>()
  if (!exists) return json({ error: 'Video not found in the catalog' }, 404)
  const max = await c.env.DB.prepare('SELECT MAX(position) AS m FROM playlist_videos WHERE playlist_id = ?').bind(id).first<{ m: number | null }>()
  await c.env.DB.prepare('INSERT OR IGNORE INTO playlist_videos (playlist_id, video_id, position) VALUES (?, ?, ?)')
    .bind(id, vid, (max?.m ?? -1) + 1).run()
  await c.env.DB.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').bind(nowIso(), id).run()
  return json({ ok: true })
})

app.post('/api/playlists/:id/remove', async (c) => {
  const id = c.req.param('id')
  let body: { token?: unknown; video_id?: unknown }
  try { body = await c.req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const pl = await checkEditToken(c.env.DB, id, body.token)
  if (!pl) return json({ error: 'Invalid edit token' }, 403)
  const vid = typeof body.video_id === 'string' ? body.video_id : ''
  if (!vid) return json({ error: 'video_id is required' }, 400)
  await c.env.DB.prepare('DELETE FROM playlist_videos WHERE playlist_id = ? AND video_id = ?').bind(id, vid).run()
  // Renumber positions so they stay dense.
  const rows = await c.env.DB.prepare('SELECT video_id FROM playlist_videos WHERE playlist_id = ? ORDER BY position ASC').bind(id).all<{ video_id: string }>()
  for (let i = 0; i < (rows.results ?? []).length; i++) {
    await c.env.DB.prepare('UPDATE playlist_videos SET position = ? WHERE playlist_id = ? AND video_id = ?')
      .bind(i, id, (rows.results as { video_id: string }[])[i].video_id).run()
  }
  await c.env.DB.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').bind(nowIso(), id).run()
  return json({ ok: true })
})

app.post('/api/playlists/:id/reorder', async (c) => {
  const id = c.req.param('id')
  let body: { token?: unknown; video_ids?: unknown }
  try { body = await c.req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const pl = await checkEditToken(c.env.DB, id, body.token)
  if (!pl) return json({ error: 'Invalid edit token' }, 403)
  if (!Array.isArray(body.video_ids) || !body.video_ids.every((v) => typeof v === 'string')) {
    return json({ error: 'video_ids must be an array of video ids' }, 400)
  }
  const current = await c.env.DB.prepare('SELECT video_id FROM playlist_videos WHERE playlist_id = ?').bind(id).all<{ video_id: string }>()
  const currentSet = new Set((current.results ?? []).map((r) => r.video_id))
  const wanted = body.video_ids as string[]
  if (wanted.length !== currentSet.size || !wanted.every((v) => currentSet.has(v))) {
    return json({ error: 'video_ids must list exactly the playlist videos' }, 400)
  }
  for (let i = 0; i < wanted.length; i++) {
    await c.env.DB.prepare('UPDATE playlist_videos SET position = ? WHERE playlist_id = ? AND video_id = ?')
      .bind(i, id, wanted[i]).run()
  }
  await c.env.DB.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').bind(nowIso(), id).run()
  return json({ ok: true })
})

app.post('/api/playlists/:id/edit', async (c) => {
  const id = c.req.param('id')
  let body: { token?: unknown; title?: unknown; description?: unknown }
  try { body = await c.req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const pl = await checkEditToken(c.env.DB, id, body.token)
  if (!pl) return json({ error: 'Invalid edit token' }, 403)
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
  const desc = typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : ''
  if (!title) return json({ error: 'title is required' }, 400)
  await c.env.DB.prepare('UPDATE playlists SET title = ?, description = ?, slug = ?, updated_at = ? WHERE id = ?')
    .bind(title, desc || null, slugify(title), nowIso(), id).run()
  return json({ ok: true, slug: slugify(title) })
})

app.post('/api/playlists/:id/delete', async (c) => {
  const id = c.req.param('id')
  let body: { token?: unknown }
  try { body = await c.req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const pl = await checkEditToken(c.env.DB, id, body.token)
  if (!pl) return json({ error: 'Invalid edit token' }, 403)
  await c.env.DB.prepare('DELETE FROM playlist_videos WHERE playlist_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM playlists WHERE id = ?').bind(id).run()
  return json({ ok: true })
})

// D1 — import a public YouTube playlist into the CATALOG (does not create a
// TubePlus playlist). Returns how many videos were added vs already present.
app.post('/api/import-playlist', async (c) => {
  let body: { playlist_url?: unknown; playlist_id?: unknown; category?: unknown }
  try { body = await c.req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const plId = parsePlaylistId(String(body.playlist_url ?? body.playlist_id ?? ''))
  if (!plId) return json({ error: 'Provide a public YouTube playlist URL or PL id' }, 400)
  const catSlug = typeof body.category === 'string' ? body.category : 'entertainment'
  const cat = await c.env.DB.prepare('SELECT id, slug, name FROM categories WHERE slug = ?').bind(catSlug).first<{ id: number; slug: string; name: string }>()
  if (!cat) return json({ error: 'Unknown category' }, 400)
  const feed = await fetchRss('https://www.youtube.com/feeds/videos.xml?playlist_id=' + plId)
  if (!feed || feed.entries.length === 0) {
    return json({ error: 'Could not read that playlist (it may be private, empty, or YouTube blocked the fetch)' }, 502)
  }
  const tagCache = await loadTagMap(c.env.DB)
  let added = 0
  let present = 0
  const videoIds: string[] = []
  // Durations in parallel (best-effort) for the new entries only.
  const toInsert: { e: RssEntry; chId: number; catId: number }[] = []
  for (const e of feed.entries) {
    let ch = e.channelId ? await findChannelByUc(c.env.DB, e.channelId) : null
    if (!ch) {
      const cid = await createChannel(c.env.DB, e.channelId || ('UC' + randId(22)), e.author || 'Unknown channel', cat.id)
      ch = { id: cid, name: e.author || 'Unknown channel', category_id: cat.id }
    }
    const exists = await c.env.DB.prepare('SELECT 1 AS ok FROM videos WHERE id = ?').bind(e.id).first<{ ok: number }>()
    if (exists) { present++; videoIds.push(e.id); continue }
    toInsert.push({ e, chId: ch.id, catId: ch.category_id ?? cat.id })
  }
  const durs = await Promise.all(toInsert.map((t) => fetchDuration(t.e.id)))
  for (let i = 0; i < toInsert.length; i++) {
    const t = toInsert[i]
    if (await insertVideo(c.env.DB, t.e, t.chId, t.catId, durs[i], tagCache)) {
      added++
      // Keep the new channel's n in sync.
      await c.env.DB.prepare('UPDATE channels SET n = (SELECT COUNT(*) FROM videos WHERE channel_id = ?) WHERE id = ?').bind(t.chId, t.chId).run()
    } else {
      present++
    }
    videoIds.push(t.e.id)
  }
  return json({
    playlist_id: plId, playlist_title: feed.title || null,
    added, present, total: feed.entries.length, video_ids: videoIds,
  })
})

// ---------------------------------------------------------------------------
// SSR rendering (server-side HTML for the first paint)
// ---------------------------------------------------------------------------
function likeBtnHTML(v: ApiVideo, big = false): string {
  return `<button class="like-btn${big ? ' big' : ''}" data-like="${v.id}" title="Like this video"><span class="heart">♡</span> <span class="lc">${v.likes}</span></button>`
}

function miniHTML(v: ApiVideo): string {
  const c = v.channel
  return `<a class="mini" href="${watchURL(v)}">`
    + `<div class="thumb"><img loading="lazy" src="${thumb(v.id)}" alt="">${v.dur ? `<span class="dur">${fmtDur(v.dur)}</span>` : ''}</div>`
    + `<div style="min-width:0"><div class="t" title="${esc(v.title)}">${esc(v.title)}</div>`
    + `<div class="sub">${esc(c.name)} ${tierBadge(c.tier)}</div>`
    + `<div class="sub">${[v.views != null ? fmtViews(v.views) : '', v.published_at ? fmtDateAbs(v.published_at) : ''].filter(Boolean).join(' · ')}</div></div></a>`
}

function cardHTML(v: ApiVideo, showChannel = true): string {
  const c = v.channel
  const tags =
    v.tags.length > 0
      ? `<div class="tags">${v.tags
          .slice(0, 3)
          .map((t) => `<a class="tag" href="/tag/${encodeURIComponent(t)}">${esc(t)}</a>`)
          .join('')}</div>`
      : ''
  return `<a class="card" href="${watchURL(v)}">
    <div class="thumb"><img loading="lazy" src="${thumb(v.id)}" alt="">
      ${c.featured === v.id ? `<span class="pick">★ TubePlus pick</span>` : ''}
      ${v.dur ? `<span class="dur">${fmtDur(v.dur)}</span>` : ''}</div>
    <div class="meta"><div style="min-width:0">
      <div class="t" title="${esc(v.title)}">${esc(v.title)}</div>
      <div class="sub">${showChannel ? `<a class="chlink" href="${channelURL(c)}">${esc(c.name)}</a> ${tierBadge(c.tier)}` : ''}
        ${v.views != null ? `<span>${showChannel ? '· ' : ''}${fmtViews(v.views)}</span>` : ''}${
          v.category ? `<span>· <a class="catlink" href="/category/${esc(v.category.slug)}">${esc(v.category.name)}</a></span>` : ''
        }${v.published_at ? `<span>· ${fmtDateAbs(v.published_at)}</span>` : ''}</div>
      ${tags}
      <div class="likerow">${likeBtnHTML(v)}<button class="addpl-btn" data-addpl="${v.id}" title="Add to a playlist">＋ Playlist</button></div>
    </div></div></a>`
}

// One-sentence description for the watch page <meta> / OG / JSON-LD, built
// only from data we have (title, channel, category, views) — nothing invented.
function watchDescription(v: ApiVideo): string {
  let d = `Watch "${v.title}" by ${v.channel.name} on TubePlus`
  if (v.category) d += ` — ${v.category.name}`
  if (v.views != null) d += `, ${fmtViews(v.views)}`
  return d + '.'
}

function watchHead(v: ApiVideo, desc: string): string {
  const canonical = SITE_URL + watchURL(v)
  const img = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
  // VideoObject requires uploadDate for video rich results (Search Console
  // flags a missing uploadDate as critical). Only emit the JSON-LD when we
  // know the publish date — newer videos ingested via RSS have published_at;
  // the older seed videos have published_at NULL, so they get no VideoObject
  // rather than an invalid one.
  let ldScript = ''
  if (v.published_at) {
    const ld: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: v.title,
      description: desc,
      thumbnailUrl: img,
      contentUrl: `https://www.youtube.com/watch?v=${v.id}`,
      embedUrl: `https://www.youtube.com/embed/${v.id}`,
      uploadDate: v.published_at,
    }
    if (v.views != null) {
      ld.interactionStatistic = {
        '@type': 'InteractionCounter',
        interactionType: { '@type': 'WatchAction' },
        userInteractionCount: v.views,
      }
    }
    ldScript = `\n<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`
  }
  return `<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="video.other">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(v.title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<link rel="canonical" href="${esc(canonical)}">${ldScript}`
}

// Server-side watch page — mirrors the markup the client builds in viewWatch
// (same structure, classes and ids) so the client can adopt it as-is.
// #ssrWatch carries the video id + up-next list as JSON for the client.
function watchHTML(v: ApiVideo, upNext: ApiVideo[], channelCount: number): string {
  const c = v.channel
  const metaParts = [
    `<a class="wm-ch" href="${channelURL(c)}">${esc(c.name)}</a> ${tierBadge(c.tier)}`,
    v.views != null ? fmtViews(v.views) : '',
    v.dur ? fmtDur(v.dur) : '',
    v.published_at ? fmtDateAbs(v.published_at) : '',
  ].filter(Boolean)
  const tagLinks = v.tags.slice(0, 2).map((t) => `<a class="wtag" href="/tag/${encodeURIComponent(t)}">#${esc(t)}</a>`).join(' ')
  const ssrData = JSON.stringify({ id: v.id, upNext }).replace(/</g, '\\u003c')
  return `<div class="watch"><div class="primary">`
    + `<div class="player"><div id="ytplayer"></div></div>`
    + `<h1>${esc(v.title)}</h1>`
    + `<div class="wmeta">${metaParts.join(' · ')}${tagLinks ? ' · ' + tagLinks : ''}${c.featured === v.id ? ' · <span style="color:#e0b400">★ TubePlus pick for this channel</span>' : ''} <button class="wmore" id="wmoreBtn">…more</button></div>`
    + `<div class="wdesc" id="wdesc" hidden><div class="why"><b>${tierBadge(c.tier)} ${esc(c.tier)} tier${c.tag ? ' · ' + esc(c.tag) : ''} · ${channelCount.toLocaleString()} videos</b>${c.blurb ? esc(c.blurb) : '<span style="color:var(--fg2)">No write-up for this channel.</span>'}</div><div style="margin-top:8px"><a class="ytlink" href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">Open on YouTube ↗</a></div></div>`
    + `<div class="wrow">${av(c)}<button class="pill primary" id="nextBtn" title="Shift+N">Next random ⏭</button>`
    + `<div class="wacts">${likeBtnHTML(v, true)}<button class="icobtn" data-addpl="${v.id}" title="Add to a playlist">＋</button><a class="icobtn" href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener" title="Open on YouTube">↗</a></div></div>`
    + `</div><div class="secondary"><div class="upnext-h"><h3>Up next</h3><label class="autoplay" title="Play a random video when this one ends">Autoplay <input type="checkbox" id="autoNext" checked></label></div><div id="upnext">${upNext.map(miniHTML).join('')}</div></div></div>`
    + `<script id="ssrWatch" type="application/json">${ssrData}</script>`
}

// Public catalog snapshot. Module memo + Cache API so an HTML crawl does not
// re-scan videos on every page. Counts come from channels.n (one row per
// channel), which matches per-video category counts because a video's
// category is its channel's category.
interface Drawer {
  categories: CategoryRow[]
  channels: ChannelRow[]
  total: number
}
let drawerMemo: { exp: number; data: Drawer } | null = null
let drawerFlight: Promise<Drawer> | null = null

async function drawerData(db: D1Database): Promise<Drawer> {
  const now = Date.now()
  if (drawerMemo && drawerMemo.exp > now) return drawerMemo.data
  if (!drawerFlight) {
    drawerFlight = loadDrawer(db).finally(() => {
      drawerFlight = null
    })
  }
  return drawerFlight
}

async function loadDrawer(db: D1Database): Promise<Drawer> {
  try {
    const hit = await caches.default.match(DRAWER_CACHE_URL)
    if (hit) {
      const data = (await hit.json()) as Drawer
      drawerMemo = { exp: Date.now() + DRAWER_TTL_SECONDS * 1000, data }
      return data
    }
  } catch {
    // ignore
  }
  const data = await queryDrawer(db)
  drawerMemo = { exp: Date.now() + DRAWER_TTL_SECONDS * 1000, data }
  try {
    await caches.default.put(
      DRAWER_CACHE_URL,
      new Response(JSON.stringify(data), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${DRAWER_TTL_SECONDS}`,
        },
      }),
    )
  } catch {
    // ignore
  }
  return data
}

async function queryDrawer(db: D1Database): Promise<Drawer> {
  const [catsRes, chansRes, totalRes] = await Promise.all([
    db
      .prepare(
        `SELECT cat.id, cat.slug, cat.name, COALESCE(SUM(ch.n), 0) AS count
         FROM categories cat
         LEFT JOIN channels ch ON ch.category_id = cat.id
         GROUP BY cat.id
         ORDER BY count DESC, cat.name ASC`,
      )
      .all<CategoryRow>(),
    db
      .prepare(
        `SELECT id, name, url, tier, tag, blurb, featured, n, n AS video_count
         FROM channels
         ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 5 END, name ASC`,
      )
      .all<ChannelRow>(),
    db.prepare('SELECT COALESCE(SUM(n), 0) AS total FROM channels').first<{ total: number }>(),
  ])
  return {
    categories: catsRes.results ?? [],
    channels: chansRes.results ?? [],
    total: totalRes?.total ?? 0,
  }
}

function drawerHTML(categories: CategoryRow[], channels: ChannelRow[]): string {
  let h = `<a class="item active" href="#/" data-route="home"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M4 21V10.08l8-6.96 8 6.96V21h-6v-6h-4v6H4z"/></svg> For You</a>
    <a class="item" href="/new" data-route="new"><span style="width:22px;text-align:center">🆕</span> New videos</a>
    <a class="item" href="/playlists" data-route="playlists"><span style="width:22px;text-align:center">▤</span> Playlists</a>
    <a class="item" href="#/picks" data-route="picks"><span style="width:22px;text-align:center;color:#ffd84d">★</span> TubePlus picks</a><hr>`
  h += `<button class="item" id="tvBtn" title="TV mode (T)"><svg viewBox="0 0 24 24"><path d="M21 4H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h7v2H7v1h10v-1h-3v-2h7a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zm0 13H3V5h18v12zM10 8v6l5-3-5-3z"></path></svg><span class="name">TV mode</span></button>`
  h += `<button class="item" id="themeBtn" title="Switch light/dark mode"><svg class="theme-dark-icon" viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5 1 3h-2l1-3zm0 20-1-3h2l-1 3zM2 12l3-1v2l-3-1zm20 0-3 1v-2l3 1zM4.9 4.9l2.8 1.4-1.4 1.4-1.4-2.8zm14.2 14.2-2.8-1.4 1.4-1.4 1.4 2.8zM4.9 19.1l1.4-2.8 1.4 1.4-2.8 1.4zM19.1 4.9l-1.4 2.8-1.4-1.4 2.8-1.4z"></path></svg><svg class="theme-light-icon" viewBox="0 0 24 24"><path d="M14.5 2.5a9.5 9.5 0 1 0 7 13.9A8 8 0 0 1 14.5 2.5z"></path></svg><span class="name">Theme</span></button>`
  h += `<a class="item" id="aboutBtn" href="#/about" title="About"><span style="width:22px;text-align:center;font-weight:700">?</span><span class="name">About</span></a><hr>`
  h += `<h4>Categories</h4><a class="item ch on" href="#/">All categories</a>`
  for (const cat of categories) {
    h += `<a class="item ch" href="/category/${esc(cat.slug)}"><span class="name">${esc(cat.name)}</span><span class="cnt">${cat.count.toLocaleString()}</span></a>`
  }
  h += `<hr>`
  for (const t of TIERS) {
    h += `<h4>${tierBadge(t)} ${esc(TIER_NAMES[t])}</h4>`
    for (const ch of channels.filter((x) => x.tier === t)) {
      h += `<a class="item ch" href="${channelURL(ch)}" data-route="c/${ch.id}">${av(ch)}<span class="name">${esc(ch.name)}</span><span class="cnt">${(ch.video_count ?? ch.n ?? 0).toLocaleString()}</span></a>`
    }
  }
  h += `<hr><div style="color:var(--fg2);font-size:12px;padding:0 12px">Channels from <a style="text-decoration:underline" href="https://thume.ca/2026/11/01/youtube-tier-list-2026/" target="_blank" rel="noopener">Tristan Hume's YouTube tier list 2026</a>, with categories &amp; tags added by TubePlus.</div>`
  h += `<div style="color:var(--fg2);font-size:12px;padding:8px 12px 0"><a style="text-decoration:underline" href="/add-channel">Add a channel</a> · <a style="text-decoration:underline" href="/import-playlist">Import a playlist</a></div>`
  return h
}

// Chips row — the client re-renders this same markup (chipsHTML in CLIENT_JS)
// whenever filters change, so keep the two in sync.
function chipsHTML(total: number, sort = 'views'): string {
  const tierChips = [`<button class="chip on" data-tier="">All</button>`].concat(
    TIERS.map((t) => `<button class="chip" data-tier="${t}">${tierBadge(t)} tier</button>`),
  )
  const lenChips = [
    `<button class="chip" data-len="short">Under 10 min</button>`,
    `<button class="chip" data-len="long">30+ min</button>`,
  ]
  const opt = (v: string, label: string) => `<option value="${v}"${sort === v ? ' selected' : ''}>${label}</option>`
  return `<div class="chips" id="chips">${tierChips.join('')}${lenChips.join('')}</div>
    <div class="filterrow"><span class="rescount" id="rescount">${total.toLocaleString()} videos</span>
      <label class="sortwrap">Sort <select id="sortsel">
        ${opt('views', 'Most viewed')}
        ${opt('latest', 'Latest')}
        ${opt('likes', 'Most liked')}
        ${opt('longest', 'Longest')}
        ${opt('shortest', 'Shortest')}
        ${opt('shuffle', 'Shuffle')}
      </select></label></div>`
}

function shellHTML(opts: {
  title: string
  total: number
  drawer: string
  main: string
  // Extra <head> content (watch page: meta / OG / canonical / JSON-LD).
  head?: string
}): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='1' y='4' width='22' height='16' rx='5' fill='%23e5484d'/><path d='M10 8.5v7l6-3.5z' fill='white'/></svg>">
<script>
  // Apply the saved theme before first paint so there's no flash.
  try { const t = localStorage.getItem("theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}
</script>
<style>${CSS}</style>
${opts.head ?? ''}
</head>
<body>
<header>
  <button class="icon-btn" id="menuBtn" title="Menu" aria-label="Menu">☰</button>
  <a class="logo" href="#/" title="For You">
    <svg viewBox="0 0 30 22"><rect width="30" height="22" rx="6" fill="#e5484d"></rect><path d="M12 6.5v9l8-4.5z" fill="#fff"></path></svg>
    <span>TubePlus</span>
  </a>
  <form class="search" id="searchForm">
    <input id="q" type="search" placeholder="Search ${opts.total.toLocaleString()} videos" autocomplete="off">
    <button aria-label="Search"><svg viewBox="0 0 24 24"><path d="M20.87 20.17l-5.59-5.59A7.46 7.46 0 0 0 17 10a7 7 0 1 0-7 7c1.75 0 3.35-.64 4.58-1.72l5.59 5.59.7-.7zM10 16a6 6 0 1 1 0-12 6 6 0 0 1 0 12z"></path></svg></button>
  </form>
  <button class="shuffle-btn" id="luckyBtn" title="Play a random video (Shift+N)">
    <svg viewBox="0 0 24 24"><path d="M18.15 13.65 22 17.5l-3.85 3.85-.71-.71L20.09 18H19c-2.84 0-4.94-2.04-6.97-4.01l.71-.71C14.59 15.12 16.55 17 19 17h1.09l-2.65-2.65.71-.7zM18.15 2.65l-.71.71L20.09 6H19c-5.53 0-8.72 6.65-11.39 9.83C6.43 17.25 5.03 18 3 18v1c2.4 0 4.04-.9 5.38-2.5C11.2 13.15 14.08 7 19 7h1.09l-2.65 2.65.71.71L22 6.5l-3.85-3.85zM3 5v1c1.74 0 3.04.67 4.29 1.82l.7-.71C6.6 5.86 5.09 5 3 5z"></path></svg>
    <span>Surprise me</span>
  </button>
</header>
<div class="layout">
  <main id="main">${opts.main}</main>
</div>
<div id="backdrop"></div>
<div id="drawer">${opts.drawer}</div>
<div id="tv" aria-label="TV mode">
  <div class="tvplayer"><div id="tvplayer"></div></div>
  <div class="tvcatch"></div>
  <div class="top">
    <span></span>
    <button class="exit" id="tvExit">Exit TV (Esc)</button>
  </div>
  <div class="osd">
    <div class="ttl" id="tvTitle"></div>
    <div class="chn" id="tvChan"></div>
    <div class="barrow"><span id="tvCur">0:00</span><div class="bar" id="tvBar"><i></i></div><span id="tvDur">0:00</span></div>
    <div class="keys"><kbd>1</kbd>–<kbd>9</kbd> jump to 10–90% · <kbd>0</kbd> restart · <kbd>N</kbd> next · <kbd>P</kbd> previous ·
      <kbd>Space</kbd> pause · <kbd>←</kbd><kbd>→</kbd> ±10s · <kbd>M</kbd> mute · <kbd>Esc</kbd> exit</div>
  </div>
  <div class="toast" id="tvToast"></div>
</div>
<script>${CLIENT_JS}</script>
</body></html>`
}

// ---------------------------------------------------------------------------
// Home page — SSR: sidebar + chips + first page of the grid.
// ---------------------------------------------------------------------------
app.get('/', async (c) => {
  const db = c.env.DB
  const [drawer, firstPage] = await Promise.all([
    drawerData(db),
    listVideos(db, { sort: 'views' }, 1, PAGE_LIMIT_DEFAULT),
  ])
  const { categories, channels } = drawer
  const grid = firstPage.videos.map((v) => cardHTML(v)).join('')
  const sentinel = firstPage.nextPage
    ? `<div class="sentinel" id="sentinel" data-next="${firstPage.nextPage}" data-total="${firstPage.total}"></div>`
    : ''
  // Homepage SEO: the home page previously had only a bare <title>TubePlus</title>
  // and no meta/OG/canonical/JSON-LD. Give it the same treatment as the other
  // pages (pageHead) plus a screen-reader-only H1, so search engines see a
  // proper title, description and an ItemList of the top videos.
  const homeTitle = 'TubePlus — The best YouTube videos, curated by tier'
  const homeDesc = `TubePlus is a curated guide to the best YouTube videos — ${firstPage.total.toLocaleString()} videos from ${channels.length} channels, ranked S to D across science, tech, making, history, space and more. Search, browse by category, and watch the best.`
  const main = `<h1 class="sr-only">TubePlus — the best YouTube videos, curated by tier</h1><div id="chipswrap">${chipsHTML(firstPage.total)}</div><div class="feed"><div class="grid" id="grid">${grid}</div>${sentinel}</div>`
  const html = shellHTML({
    title: homeTitle,
    total: firstPage.total,
    drawer: drawerHTML(categories, channels),
    main,
    head: pageHead({
      title: homeTitle,
      desc: homeDesc,
      canonical: SITE_URL + '/',
      image: firstPage.videos[0] ? `https://i.ytimg.com/vi/${firstPage.videos[0].id}/hqdefault.jpg` : undefined,
      ldType: 'ItemList',
      ldItems: firstPage.videos.map((v) => ({ url: SITE_URL + watchURL(v), name: v.title })),
    }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_HTML_LIST}` } })
})

app.get('/health', (c) => c.text('ok'))

// ---------------------------------------------------------------------------
// SEO: canonical watch pages, sitemaps, robots
// ---------------------------------------------------------------------------
app.get('/watch/:id/:slug?', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const row = await db
    .prepare(`${VIDEO_SELECT} WHERE v.id = ? GROUP BY v.id`)
    .bind(id)
    .first<VideoRow>()
  const { categories, channels, total } = await drawerData(db)
  if (!row) {
    const html = shellHTML({
      title: 'Video not found - TubePlus',
      total,
      drawer: drawerHTML(categories, channels),
      main: '<div class="empty">Video not found.</div>',
    })
    return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
  const v = toApiVideo(row)
  // Missing or wrong slug -> 301 to the canonical /watch/<id>/<slug>.
  // (When the DB slug is empty the canonical URL has no slug segment.)
  if (c.req.param('slug') !== (v.slug || undefined)) {
    return c.redirect(watchURL(v), 301)
  }
  const channelCount = v.channel.n ?? 0
  const [sameChannel, shuffled] = await Promise.all([
    listVideos(db, { channel: v.channel.id, sort: 'views' }, 1, 8, { withTotal: false }),
    listVideos(db, { sort: 'shuffle' }, 1, 12, { withTotal: false }),
  ])
  const seen = new Set<string>([v.id])
  const upNext: ApiVideo[] = []
  for (const x of [...sameChannel.videos, ...shuffled.videos]) {
    if (!seen.has(x.id)) {
      seen.add(x.id)
      upNext.push(x)
    }
    if (upNext.length >= 16) break
  }
  const desc = watchDescription(v)
  const html = shellHTML({
    title: `${v.title} — TubePlus`,
    total,
    drawer: drawerHTML(categories, channels),
    main: watchHTML(v, upNext, channelCount),
    head: watchHead(v, desc),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_HTML_WATCH}` } })
})

// ---------------------------------------------------------------------------
// v3 pages: /new, /category/:slug, /tag/:name, /channel/:id/:slug?,
// /add-channel, /import-playlist, /playlists, /playlists/new,
// /playlist/:id/:slug?
// ---------------------------------------------------------------------------
function sortParam(url: URL): 'views' | 'latest' | 'likes' | 'longest' | 'shortest' | 'shuffle' {
  const s = url.searchParams.get('sort')
  if (s === 'latest' || s === 'likes' || s === 'longest' || s === 'shortest' || s === 'shuffle') return s
  return 'views'
}

async function notFoundPage(db: D1Database, title: string, msg: string): Promise<Response> {
  const { categories, channels, total } = await drawerData(db)
  const html = shellHTML({
    title: `${title} - TubePlus`,
    total,
    drawer: drawerHTML(categories, channels),
    main: `<div class="empty">${esc(msg)}</div>`,
  })
  return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

// Generic <head> for a landing/collection page: title, description,
// canonical, OG, JSON-LD (CollectionPage or ItemList).
function pageHead(opts: {
  title: string; desc: string; canonical: string; image?: string
  ldType: 'CollectionPage' | 'ItemList'
  ldItems?: { url: string; name: string }[]
}): string {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': opts.ldType,
    name: opts.title,
    description: opts.desc,
    url: opts.canonical,
  }
  if (opts.ldType === 'ItemList' && opts.ldItems) {
    ld.itemListElement = opts.ldItems.map((it, i) => ({
      '@type': 'ListItem', position: i + 1, url: it.url, name: it.name,
    }))
  }
  const ldJson = JSON.stringify(ld).replace(/</g, '\\u003c')
  return `<meta name="description" content="${esc(opts.desc)}">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(opts.canonical)}">
${opts.image ? `<meta property="og:image" content="${esc(opts.image)}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${esc(opts.image)}">` : '<meta name="twitter:card" content="summary">'}
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.desc)}">
<link rel="canonical" href="${esc(opts.canonical)}">
<script type="application/ld+json">${ldJson}</script>`
}

// SSR for a filtered video list (home-style): heading, chips, first page
// grid, sentinel. The client adopts it via #ssrPage (view + filter + sort).
function collectionHTML(opts: {
  heading: string
  sub?: string
  headerExtra?: string
  filter: VideoFilter
  page: { videos: ApiVideo[]; nextPage: number | null; total: number }
  sort: string
  ssr: Record<string, unknown>
}): string {
  const grid = opts.page.videos.map((v) => cardHTML(v)).join('')
  const sentinel = opts.page.nextPage
    ? `<div class="sentinel" id="sentinel" data-next="${opts.page.nextPage}" data-total="${opts.page.total}"></div>`
    : ''
  const ssrJson = JSON.stringify(opts.ssr).replace(/</g, '\\u003c')
  return `<h1 class="pagetitle">${esc(opts.heading)}</h1>`
    + (opts.sub ? `<p class="pagesub">${esc(opts.sub)}</p>` : '')
    + (opts.headerExtra ?? '')
    + `<div id="chipswrap">${chipsHTML(opts.page.total, opts.sort)}</div>`
    + `<div class="feed"><div class="grid" id="grid">${grid}</div>${sentinel}</div>`
    + `<script id="ssrPage" type="application/json">${ssrJson}</script>`
}

function channelHeaderHTML(ch: ChannelRow, videoCount: number): string {
  return `<div class="chhead">${av(ch)}<div style="min-width:0"><h1>${esc(ch.name)} ${tierBadge(ch.tier)}</h1>`
    + `<div class="sub">${videoCount.toLocaleString()} videos${ch.tag ? ' · ' + esc(ch.tag) : ''}</div>`
    + (ch.blurb ? `<div class="blurb">${esc(ch.blurb)}</div>` : '')
    + `<div class="actions"><a class="pill" href="https://www.youtube.com/channel/${esc((ch.url || '').split('/channel/')[1] || '')}" target="_blank" rel="noopener">Open on YouTube ↗</a></div>`
    + `</div></div>`
}

function categoryOptions(cats: CategoryRow[], selected?: string): string {
  return cats.map((cat) => `<option value="${esc(cat.slug)}"${cat.slug === selected ? ' selected' : ''}>${esc(cat.name)}</option>`).join('')
}
function tierOptions(selected = 'D'): string {
  return TIERS.map((t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${t} — ${esc(TIER_NAMES[t])}</option>`).join('')
}

app.get('/new', async (c) => {
  const db = c.env.DB
  const sort = 'latest'
  const page = await listVideos(db, { sort }, 1, PAGE_LIMIT_DEFAULT)
  const { categories, channels, total } = await drawerData(db)
  const desc = 'The newest videos from the TubePlus channels, pulled daily from YouTube RSS.'
  const html = shellHTML({
    title: 'New videos — TubePlus',
    total,
    drawer: drawerHTML(categories, channels),
    main: collectionHTML({
      heading: 'New videos',
      sub: 'The newest uploads from the channels, in publish order. Seed videos have no publish date and do not appear here.',
      filter: { sort },
      page,
      sort,
      ssr: { view: 'new', sort },
    }),
    head: pageHead({ title: 'New videos — TubePlus', desc, canonical: SITE_URL + '/new', ldType: 'CollectionPage' }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_HTML_LIST}` } })
})

app.get('/category/:slug', async (c) => {
  const db = c.env.DB
  const slug = c.req.param('slug')
  const cat = await db.prepare('SELECT id, slug, name FROM categories WHERE slug = ?').bind(slug).first<CategoryRow>()
  if (!cat) return notFoundPage(db, 'Category not found', 'No such category.')
  const sort = sortParam(new URL(c.req.url))
  const page = await listVideos(db, { category: slug, sort }, 1, PAGE_LIMIT_DEFAULT)
  const { categories, channels, total } = await drawerData(db)
  const desc = `${cat.name} videos on TubePlus — ${page.total.toLocaleString()} videos from the curated channels.`
  const html = shellHTML({
    title: `${cat.name} videos — TubePlus`,
    total,
    drawer: drawerHTML(categories, channels),
    main: collectionHTML({
      heading: cat.name,
      sub: `${page.total.toLocaleString()} videos`,
      filter: { category: slug, sort },
      page,
      sort,
      ssr: { view: 'category', category: slug, sort },
    }),
    head: pageHead({ title: `${cat.name} videos — TubePlus`, desc, canonical: SITE_URL + '/category/' + slug, ldType: 'CollectionPage' }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_HTML_LIST}` } })
})

app.get('/tag/:name', async (c) => {
  const db = c.env.DB
  const name = decodeURIComponent(c.req.param('name'))
  const tag = await db.prepare('SELECT id, name FROM tags WHERE name = ?').bind(name).first<TagRow>()
  if (!tag) return notFoundPage(db, 'Tag not found', 'No such tag.')
  const sort = sortParam(new URL(c.req.url))
  const page = await listVideos(db, { tag: name, sort }, 1, PAGE_LIMIT_DEFAULT)
  const { categories, channels, total } = await drawerData(db)
  const desc = `Videos tagged “${name}” on TubePlus — ${page.total.toLocaleString()} videos.`
  const html = shellHTML({
    title: `#${name} — TubePlus`,
    total,
    drawer: drawerHTML(categories, channels),
    main: collectionHTML({
      heading: '#' + name,
      sub: `${page.total.toLocaleString()} videos`,
      filter: { tag: name, sort },
      page,
      sort,
      ssr: { view: 'tag', tag: name, sort },
    }),
    head: pageHead({ title: `#${name} — TubePlus`, desc, canonical: SITE_URL + '/tag/' + encodeURIComponent(name), ldType: 'CollectionPage' }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_HTML_LIST}` } })
})

app.get('/channel/:id/:slug?', async (c) => {
  const db = c.env.DB
  const id = parseInt(c.req.param('id'), 10)
  if (!Number.isInteger(id)) return notFoundPage(db, 'Channel not found', 'No such channel.')
  const ch = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>()
  if (!ch) return notFoundPage(db, 'Channel not found', 'No such channel.')
  // Wrong or missing slug -> 301 to the canonical channel URL.
  if (c.req.param('slug') !== channelSlug(ch.name)) {
    return c.redirect(channelURL(ch), 301)
  }
  const sort = sortParam(new URL(c.req.url))
  const page = await listVideos(db, { channel: id, sort }, 1, PAGE_LIMIT_DEFAULT)
  const { categories, channels, total } = await drawerData(db)
  const desc = ch.blurb
    ? `${ch.name} on TubePlus — ${page.total.toLocaleString()} videos. ${ch.blurb.slice(0, 160)}`
    : `${ch.name} on TubePlus — ${page.total.toLocaleString()} videos.`
  const html = shellHTML({
    title: `${ch.name} — TubePlus`,
    total,
    drawer: drawerHTML(categories, channels),
    main: collectionHTML({
      heading: ch.name,
      headerExtra: channelHeaderHTML(ch, page.total),
      filter: { channel: id, sort },
      page,
      sort,
      ssr: { view: 'channel', channel: id, sort },
    }),
    head: pageHead({ title: `${ch.name} — TubePlus`, desc, canonical: SITE_URL + channelURL(ch), ldType: 'CollectionPage' }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_HTML_LIST}` } })
})

// --- Part C: add a channel (goes live immediately, no approval queue) -------
function addChannelFormHTML(cats: CategoryRow[], error?: string, prev?: { input?: string; tier?: string; category?: string }): string {
  return `<h1 class="pagetitle">Add a channel</h1>
<p class="pagesub">Paste a YouTube channel URL, an @handle, or a raw UC id. The channel goes live immediately — there is no approval queue. Its latest videos are pulled from the channel RSS feed.</p>
${error ? `<div class="formerr">${esc(error)}</div>` : ''}
<form method="post" action="/add-channel" class="plainform">
  <label>Channel URL, @handle, or UC id
    <input type="text" name="channel" required placeholder="https://www.youtube.com/@Wintergatan" value="${esc(prev?.input ?? '')}">
  </label>
  <label>Tier
    <select name="tier">${tierOptions(prev?.tier ?? 'D')}</select>
  </label>
  <label>Category
    <select name="category">${categoryOptions(cats, prev?.category ?? 'entertainment')}</select>
  </label>
  <button class="pill primary" type="submit">Add channel</button>
</form>`
}

app.get('/add-channel', async (c) => {
  const db = c.env.DB
  const { categories, channels, total } = await drawerData(db)
  const html = shellHTML({
    title: 'Add a channel — TubePlus',
    total,
    drawer: drawerHTML(categories, channels),
    main: addChannelFormHTML(categories),
    head: pageHead({ title: 'Add a channel — TubePlus', desc: 'Add a YouTube channel to TubePlus. It goes live immediately.', canonical: SITE_URL + '/add-channel', ldType: 'CollectionPage' }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
})

app.post('/add-channel', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody()
  const input = String(body.channel ?? '').trim()
  const tier = String(body.tier ?? 'D').toUpperCase()
  const catSlug = String(body.category ?? 'entertainment')
  const { categories, channels, total } = await drawerData(db)
  const render = (error: string, status = 400) => {
    const html = shellHTML({
      title: 'Add a channel — TubePlus',
      total,
      drawer: drawerHTML(categories, channels),
      main: addChannelFormHTML(categories, error, { input, tier, category: catSlug }),
    })
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
  if (!(TIERS as readonly string[]).includes(tier)) return render('Pick a tier (S, A, B, C, or D).')
  const cat = await db.prepare('SELECT id, slug, name FROM categories WHERE slug = ?').bind(catSlug).first<{ id: number; slug: string; name: string }>()
  if (!cat) return render('Pick a category from the list.')
  let uc = parseChannelUc(input)
  if (!uc) {
    // A full @handle URL (the form YouTube's Share button copies, usually with ?si=...).
    const hm = input.match(/\/@([\w.-]+)/)
    if (hm) uc = await resolveHandle(hm[1])
  }
  if (!uc && input.startsWith('@')) uc = await resolveHandle(input)
  if (!uc && /^[\w.-]+$/.test(input.replace(/^@/, ''))) uc = await resolveHandle(input)
  if (!uc) return render('Could not work out a channel from that. Paste a /channel/UC... URL, an @handle, or a raw UC id.')
  const existing = await findChannelByUc(db, uc)
  if (existing) {
    const html = shellHTML({
      title: 'Channel already listed — TubePlus',
      total,
      drawer: drawerHTML(categories, channels),
      main: `<h1 class="pagetitle">Already listed</h1><p class="pagesub">That channel is already in the catalog.</p><p><a class="pill primary" href="${channelURL(existing)}">${esc(existing.name)} →</a></p>`,
    })
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
  const feed = await fetchRss('https://www.youtube.com/feeds/videos.xml?channel_id=' + uc)
  if (!feed || feed.entries.length === 0) {
    return render('Could not read that channel’s RSS feed (it may not exist, or YouTube blocked the fetch). Try again later.')
  }
  const name = feed.title || feed.entries[0]?.author || 'Unknown channel'
  const newId = await createChannel(db, uc, name, cat.id)
  await db.prepare('UPDATE channels SET tier = ? WHERE id = ?').bind(tier, newId).run()
  const tagCache = await loadTagMap(db)
  const toInsert = feed.entries
  const durs = await Promise.all(toInsert.map((e) => fetchDuration(e.id)))
  let added = 0
  for (let i = 0; i < toInsert.length; i++) {
    if (await insertVideo(db, toInsert[i], newId, cat.id, durs[i], tagCache)) added++
  }
  await db.prepare('UPDATE channels SET n = (SELECT COUNT(*) FROM videos WHERE channel_id = ?) WHERE id = ?').bind(newId, newId).run()
  return c.redirect('/channel/' + newId + '/' + channelSlug(name) + (added ? '' : ''), 303)
})

// --- D1: import a public YouTube playlist into the catalog ------------------
function importFormHTML(cats: CategoryRow[], error?: string, prev?: { input?: string; category?: string }): string {
  return `<h1 class="pagetitle">Import a YouTube playlist</h1>
<p class="pagesub">Paste a public YouTube playlist URL or PL id. Its videos are added to the catalog (new channels are created as tier D in the category you pick). This does <b>not</b> create a TubePlus playlist — that is a separate step, offered after the import.</p>
${error ? `<div class="formerr">${esc(error)}</div>` : ''}
<form method="post" action="/import-playlist" class="plainform">
  <label>Playlist URL or PL id
    <input type="text" name="playlist" required placeholder="https://www.youtube.com/playlist?list=PL..." value="${esc(prev?.input ?? '')}">
  </label>
  <label>Category for any new channels
    <select name="category">${categoryOptions(cats, prev?.category ?? 'entertainment')}</select>
  </label>
  <button class="pill primary" type="submit">Import playlist</button>
</form>`
}

app.get('/import-playlist', async (c) => {
  const db = c.env.DB
  const { categories, channels, total } = await drawerData(db)
  const html = shellHTML({
    title: 'Import a YouTube playlist — TubePlus',
    total,
    drawer: drawerHTML(categories, channels),
    main: importFormHTML(categories),
    head: pageHead({ title: 'Import a YouTube playlist — TubePlus', desc: 'Import a public YouTube playlist into the TubePlus catalog.', canonical: SITE_URL + '/import-playlist', ldType: 'CollectionPage' }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
})

app.post('/import-playlist', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody()
  const input = String(body.playlist ?? '').trim()
  const catSlug = String(body.category ?? 'entertainment')
  const { categories, channels, total } = await drawerData(db)
  const render = (error: string, status = 400) => {
    const html = shellHTML({
      title: 'Import a YouTube playlist — TubePlus',
      total,
      drawer: drawerHTML(categories, channels),
      main: importFormHTML(categories, error, { input, category: catSlug }),
    })
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
  const plId = parsePlaylistId(input)
  if (!plId) return render('Provide a public YouTube playlist URL or a PL id.')
  const cat = await db.prepare('SELECT id, slug, name FROM categories WHERE slug = ?').bind(catSlug).first<{ id: number; slug: string; name: string }>()
  if (!cat) return render('Pick a category from the list.')
  const feed = await fetchRss('https://www.youtube.com/feeds/videos.xml?playlist_id=' + plId)
  if (!feed || feed.entries.length === 0) {
    return render('Could not read that playlist (it may be private, empty, or YouTube blocked the fetch).')
  }
  const tagCache = await loadTagMap(db)
  let added = 0
  let present = 0
  const videoIds: string[] = []
  const toInsert: { e: RssEntry; chId: number; catId: number }[] = []
  for (const e of feed.entries) {
    let ch = e.channelId ? await findChannelByUc(db, e.channelId) : null
    if (!ch) {
      const cid = await createChannel(db, e.channelId || ('UC' + randId(22)), e.author || 'Unknown channel', cat.id)
      ch = { id: cid, name: e.author || 'Unknown channel', category_id: cat.id }
    }
    const exists = await db.prepare('SELECT 1 AS ok FROM videos WHERE id = ?').bind(e.id).first<{ ok: number }>()
    if (exists) { present++; videoIds.push(e.id); continue }
    toInsert.push({ e, chId: ch.id, catId: ch.category_id ?? cat.id })
  }
  const durs = await Promise.all(toInsert.map((t) => fetchDuration(t.e.id)))
  for (let i = 0; i < toInsert.length; i++) {
    const t = toInsert[i]
    if (await insertVideo(db, t.e, t.chId, t.catId, durs[i], tagCache)) {
      added++
      await db.prepare('UPDATE channels SET n = (SELECT COUNT(*) FROM videos WHERE channel_id = ?) WHERE id = ?').bind(t.chId, t.chId).run()
    } else {
      present++
    }
    videoIds.push(t.e.id)
  }
  const vidsParam = encodeURIComponent(videoIds.join(','))
  const main = `<h1 class="pagetitle">Import complete</h1>
<p class="pagesub">“${esc(feed.title || plId)}” — ${added} new video${added === 1 ? '' : 's'} added to the catalog, ${present} already present (${feed.entries.length} in the feed).</p>
<p><a class="pill primary" href="/playlists/new?videos=${vidsParam}">Create a playlist from these videos →</a></p>
<p class="pagesub">Or <a href="/import-playlist">import another playlist</a>.</p>`
  const html = shellHTML({
    title: 'Import complete — TubePlus',
    total,
    drawer: drawerHTML(categories, channels),
    main,
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
})

// --- D2: playlists ----------------------------------------------------------
app.get('/playlists', async (c) => {
  const db = c.env.DB
  const url = new URL(c.req.url)
  const { page, limit } = parsePageLimit(url)
  const rows = await db.prepare(
    `SELECT p.*, COUNT(pv.video_id) AS count FROM playlists p
     LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
     GROUP BY p.id ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit, (page - 1) * limit).all<PlaylistRow & { count: number }>()
  const totalRes = await db.prepare('SELECT COUNT(*) AS n FROM playlists').first<{ n: number }>()
  const { categories, channels, total } = await drawerData(db)
  const list = rows.results ?? []
  const items = list.map((p) => {
    const u = playlistURL(p)
    return `<a class="plitem" href="${u}"><div class="pltitle">${esc(p.title)}</div><div class="plsub">${p.count} video${p.count === 1 ? '' : 's'} · ${esc(new Date(p.created_at).toLocaleDateString())}</div>${p.description ? `<div class="pldesc">${esc(p.description)}</div>` : ''}</a>`
  }).join('')
  const main = `<h1 class="pagetitle">Playlists</h1>
<p class="pagesub">Public playlists made from the catalog — anyone with the link can watch them. <a href="/playlists/new">Create one →</a></p>
${items || '<div class="empty">No playlists yet. Be the first to make one.</div>'}
${(totalRes?.n ?? 0) > page * limit ? `<p class="pagesub"><a href="/playlists?page=${page + 1}">More playlists →</a></p>` : ''}`
  const html = shellHTML({
    title: 'Playlists — TubePlus',
    total,
    drawer: drawerHTML(categories, channels),
    main,
    head: pageHead({ title: 'Playlists — TubePlus', desc: 'Public playlists made from the TubePlus catalog.', canonical: SITE_URL + '/playlists', ldType: 'CollectionPage' }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_HTML_LIST}` } })
})

function playlistNewFormHTML(cats: CategoryRow[], error?: string, prev?: { title?: string; description?: string; videos?: string }): string {
  return `<h1 class="pagetitle">Create a playlist</h1>
<p class="pagesub">Pick videos from the catalog — search below, or paste YouTube video URLs / ids. The playlist is public; you get an edit token (stored in this browser) so only you can change it later.</p>
${error ? `<div class="formerr">${esc(error)}</div>` : ''}
<form method="post" action="/playlists/new" class="plainform" id="plNewForm">
  <label>Title
    <input type="text" name="title" required maxlength="200" placeholder="e.g. Best space videos" value="${esc(prev?.title ?? '')}">
  </label>
  <label>Description
    <textarea name="description" maxlength="2000" rows="3" placeholder="Optional">${esc(prev?.description ?? '')}</textarea>
  </label>
  <label>Videos (search the catalog, or paste video URLs / ids, one per line)
    <input type="search" id="plSearch" placeholder="Search videos to add…" autocomplete="off">
    <div id="plSearchRes" class="plsearchres"></div>
    <textarea name="video_urls" rows="4" placeholder="https://www.youtube.com/watch?v=IvUU8joBb1Q&#10;IvUU8joBb1Q">${esc(prev?.videos ?? '')}</textarea>
  </label>
  <input type="hidden" name="video_ids" id="plVideoIds" value="">
  <div id="plPicked" class="plpicked"></div>
  <button class="pill primary" type="submit">Create playlist</button>
</form>`
}

app.get('/playlists/new', async (c) => {
  const db = c.env.DB
  const { categories, channels, total } = await drawerData(db)
  const html = shellHTML({
    title: 'Create a playlist — TubePlus',
    total,
    drawer: drawerHTML(categories, channels),
    main: playlistNewFormHTML(categories),
    head: pageHead({ title: 'Create a playlist — TubePlus', desc: 'Make a public playlist from the TubePlus catalog.', canonical: SITE_URL + '/playlists/new', ldType: 'CollectionPage' }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
})

app.post('/playlists/new', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody()
  const title = String(body.title ?? '').trim().slice(0, 200)
  const description = String(body.description ?? '').trim().slice(0, 2000)
  const { categories, channels, total } = await drawerData(db)
  const render = (error: string, status = 400) => {
    const html = shellHTML({
      title: 'Create a playlist — TubePlus',
      total,
      drawer: drawerHTML(categories, channels),
      main: playlistNewFormHTML(categories, error, {
        title, description,
        videos: String(body.video_urls ?? ''),
      }),
    })
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
  if (!title) return render('Give the playlist a title.')
  // Collect video ids: the hidden picked-ids field + any pasted URLs/ids.
  const ids: string[] = []
  const pushId = (raw: string) => {
    const m = raw.match(/(?:v=|youtu\.be\/|watch\/)([A-Za-z0-9_-]{11})/) || raw.match(/^([A-Za-z0-9_-]{11})$/)
    const id = m ? m[1] : raw.trim()
    if (/^[A-Za-z0-9_-]{11}$/.test(id) && !ids.includes(id)) ids.push(id)
  }
  String(body.video_ids ?? '').split(',').forEach((s) => s.trim() && pushId(s.trim()))
  String(body.video_urls ?? '').split('\n').forEach((s) => s.trim() && pushId(s.trim()))
  if (!ids.length) return render('Add at least one video — search the catalog above, or paste a video URL / id.')
  // Keep only videos that are in the catalog, in the given order.
  const found: string[] = []
  for (const id of ids) {
    const ok = await db.prepare('SELECT 1 AS ok FROM videos WHERE id = ?').bind(id).first<{ ok: number }>()
    if (ok) found.push(id)
  }
  if (!found.length) return render('None of those videos are in the catalog yet. Search the catalog above and pick from it.')
  // Unique playlist id (8–10 chars, retry on the astronomically unlikely hit).
  let pid = ''
  for (let tries = 0; tries < 5 && !pid; tries++) {
    const cand = randId(10)
    const hit = await db.prepare('SELECT 1 AS ok FROM playlists WHERE id = ?').bind(cand).first<{ ok: number }>()
    if (!hit) pid = cand
  }
  if (!pid) return render('Could not allocate a playlist id. Try again.')
  const token = randToken()
  const now = nowIso()
  await db.prepare('INSERT INTO playlists (id, slug, title, description, created_at, updated_at, edit_token) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(pid, slugify(title), title, description || null, now, now, token).run()
  for (let i = 0; i < found.length; i++) {
    await db.prepare('INSERT OR IGNORE INTO playlist_videos (playlist_id, video_id, position) VALUES (?, ?, ?)')
      .bind(pid, found[i], i).run()
  }
  // The token rides in the URL once; the client stores it in localStorage
  // and strips it from the address bar.
  return c.redirect(`/playlist/${pid}/${slugify(title)}?token=${token}`, 303)
})

app.get('/playlist/:id/:slug?', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const got = await getPlaylist(db, id)
  if (!got) return notFoundPage(db, 'Playlist not found', 'No such playlist.')
  const { pl, videos } = got
  const slug = pl.slug ?? slugify(pl.title)
  if (c.req.param('slug') !== slug) {
    return c.redirect(playlistURL({ id: pl.id, slug }), 301)
  }
  const { categories, channels, total } = await drawerData(db)
  const first = videos[0]
  const desc = pl.description
    ? `${pl.title} — ${pl.description.slice(0, 160)}`
    : `${pl.title} — a public TubePlus playlist with ${videos.length} video${videos.length === 1 ? '' : 's'}.`
  const items = videos.map((v, i) => {
    const c2 = v.channel
    return `<div class="plvideo" data-vid="${v.id}"><span class="plpos">${i + 1}</span>`
      + `<a class="mini" href="${watchURL(v)}"><div class="thumb"><img loading="lazy" src="${thumb(v.id)}" alt="">${v.dur ? `<span class="dur">${fmtDur(v.dur)}</span>` : ''}</div>`
      + `<div style="min-width:0"><div class="t" title="${esc(v.title)}">${esc(v.title)}</div>`
      + `<div class="sub">${esc(c2.name)} ${tierBadge(c2.tier)}</div><div class="sub">${fmtViews(v.views)}</div></div></a>`
      + `<span class="pledit" data-editbtns="${v.id}" style="display:none"><button class="pill small" data-pl-up="${v.id}" title="Move up">↑</button><button class="pill small" data-pl-down="${v.id}" title="Move down">↓</button><button class="pill small" data-pl-remove="${v.id}" title="Remove from playlist">✕</button></span></div>`
  }).join('')
  const ssr = JSON.stringify({ view: 'playlist', id: pl.id, slug, videos: videos.map((v) => v.id) }).replace(/</g, '\\u003c')
  const main = `<h1 class="pagetitle">${esc(pl.title)}</h1>`
    + (pl.description ? `<p class="pagesub">${esc(pl.description)}</p>` : '')
    + `<p class="pagesub">${videos.length} video${videos.length === 1 ? '' : 's'} · created ${esc(new Date(pl.created_at).toLocaleDateString())}</p>`
    + `<div class="plactions"><button class="pill primary" id="playAllBtn">▶ Play all</button>`
    + `<span class="pledit" data-editbtns="page" style="display:none"><button class="pill" id="plEditBtn">Edit title / description</button><button class="pill" id="plDeleteBtn">Delete playlist</button></span></div>`
    + `<div id="plEditForm" style="display:none"></div>`
    + `<div class="pllist">${items || '<div class="empty">This playlist is empty.</div>'}</div>`
    + `<script id="ssrPage" type="application/json">${ssr}</script>`
  const html = shellHTML({
    title: `${pl.title} — TubePlus`,
    total,
    drawer: drawerHTML(categories, channels),
    main,
    head: pageHead({
      title: `${pl.title} — TubePlus`, desc, canonical: SITE_URL + playlistURL({ id: pl.id, slug }),
      image: first ? `https://i.ytimg.com/vi/${first.id}/hqdefault.jpg` : undefined,
      ldType: 'ItemList',
      ldItems: videos.map((v) => ({ url: SITE_URL + watchURL(v), name: v.title })),
    }),
  })
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${CACHE_HTML_LIST}` } })
})

const SITEMAP_SHARD = 10000

app.get('/sitemap.xml', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM videos').first<{ total: number }>()
  const shards = Math.max(1, Math.ceil((row?.total ?? 0) / SITEMAP_SHARD))
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
  for (let i = 0; i < shards; i++) {
    xml += `  <sitemap><loc>${SITE_URL}/sitemap-videos-${i}.xml</loc></sitemap>\n`
  }
  xml += `  <sitemap><loc>${SITE_URL}/sitemap-pages.xml</loc></sitemap>\n</sitemapindex>\n`
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
})

app.get('/sitemap-videos-*', async (c) => {
  // Hono does not match a :param embedded mid-segment ("/sitemap-videos-:n.xml"),
  // so match the prefix with a wildcard and parse the shard number ourselves.
  const m = c.req.path.match(/^\/sitemap-videos-(\d+)\.xml$/)
  if (!m) return c.text('Not found', 404)
  const n = parseInt(m[1], 10)
  const rows = await c.env.DB
    .prepare('SELECT id, slug FROM videos ORDER BY views DESC LIMIT ? OFFSET ?')
    .bind(SITEMAP_SHARD, n * SITEMAP_SHARD)
    .all<{ id: string; slug: string | null }>()
  const list = rows.results ?? []
  if (!list.length) return c.text('Not found', 404)
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
  for (const r of list) {
    xml += `  <url><loc>${esc(SITE_URL + watchURL({ id: r.id, slug: r.slug }))}</loc></url>\n`
  }
  xml += `</urlset>\n`
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
})

app.get('/sitemap-pages.xml', async (c) => {
  const db = c.env.DB
  const [cats, tags, chans, pls] = await Promise.all([
    db.prepare('SELECT slug FROM categories ORDER BY slug').all<{ slug: string }>(),
    db.prepare('SELECT name FROM tags ORDER BY name').all<{ name: string }>(),
    db.prepare('SELECT id, name FROM channels').all<{ id: number; name: string }>(),
    db.prepare('SELECT id, slug, title FROM playlists').all<{ id: string; slug: string | null; title: string }>(),
  ])
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
  xml += `  <url><loc>${SITE_URL}/</loc></url>\n`
  xml += `  <url><loc>${SITE_URL}/new</loc></url>\n`
  xml += `  <url><loc>${SITE_URL}/playlists</loc></url>\n`
  for (const cat of cats.results ?? []) xml += `  <url><loc>${SITE_URL}/category/${esc(cat.slug)}</loc></url>\n`
  for (const t of tags.results ?? []) xml += `  <url><loc>${SITE_URL}/tag/${encodeURIComponent(t.name)}</loc></url>\n`
  for (const ch of chans.results ?? []) xml += `  <url><loc>${SITE_URL}${channelURL(ch)}</loc></url>\n`
  for (const p of pls.results ?? []) xml += `  <url><loc>${SITE_URL}${playlistURL({ id: p.id, slug: p.slug ?? slugify(p.title) })}</loc></url>\n`
  xml += `</urlset>\n`
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
})

app.get('/robots.txt', (c) =>
  c.text(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`, 200, { 'cache-control': 'public, max-age=3600' }),
)

// ---------------------------------------------------------------------------
// Client JS — runs in the browser. NOTE: this is a String.raw template
// literal, so backslashes are preserved literally. The code inside must NOT
// contain backticks or ${...} sequences (it uses string concatenation only).
// ---------------------------------------------------------------------------
const CLIENT_JS = String.raw`
var TIERS = ['S', 'A', 'B', 'C', 'D'];
var TIER_NAMES = { S: 'Masterpieces', A: 'Horizon-expanding', B: 'Basically every video is great', C: 'Lots of excellent videos', D: 'Good quality stuff' };
var $ = function(s, el) { return (el || document).querySelector(s); };
var esc = function(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var thumb = function(id) { return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg'; };
var watchURL = function(v) { return '/watch/' + v.id + (v.slug ? '/' + v.slug : ''); };
var channelURL = function(c) { return '/channel/' + c.id + '/' + (c.slug || slugifyName(c.name)); };
var slugifyName = function(s) { return String(s || '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, ''); };
var playlistURL = function(p) { return '/playlist/' + p.id + (p.slug ? '/' + p.slug : ''); };
var initials = function(n) { return n.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(function(w) { return w[0]; }).join('').toUpperCase() || '?'; };
var av = function(c) { return '<span class="av t' + c.tier + '">' + esc(initials(c.name)) + '</span>'; };
var tierBadge = function(t) { return '<span class="tier t' + t + '" title="' + t + ' tier: ' + esc(TIER_NAMES[t]) + '">' + t + '</span>'; };
function fmtDur(s) { if (!s) return ''; var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0'); }
function fmtViews(n) { if (n == null) return ''; if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B views'; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M views'; if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K views'; return n + ' views'; }
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateAbs(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d.getTime())) return ''; return String(d.getUTCDate()).padStart(2, '0') + '-' + MONTHS[d.getUTCMonth()] + '-' + d.getUTCFullYear(); }

var CH = {};
var CHLIST = [];
var CATS = [];
var state = { view: 'home', channel: null, tier: null, category: null, tag: null, q: '', len: null, sort: 'views', picks: false, page: 1, nextPage: null, loading: false, done: false, total: 0 };
var gridObserver = null;
var cleanup = function() {};

// Likes — the browser remembers liked video ids in localStorage ("liked").
var likedSet = {};
try { JSON.parse(localStorage.getItem('liked') || '[]').forEach(function(id) { likedSet[id] = true; }); } catch (e) {}
function likeBtnHTML(id, likes, big) {
  var liked = !!likedSet[id];
  return '<button class="like-btn' + (big ? ' big' : '') + (liked ? ' liked' : '') + '" data-like="' + id + '" title="Like this video"><span class="heart">' + (liked ? '♥' : '♡') + '</span> <span class="lc">' + (likes || 0) + '</span></button>';
}
function refreshLikeStates() {
  document.querySelectorAll('[data-like]').forEach(function(b) {
    var liked = !!likedSet[b.getAttribute('data-like')];
    b.classList.toggle('liked', liked);
    var h = b.querySelector('.heart');
    if (h) h.textContent = liked ? '♥' : '♡';
  });
}
function toggleLike(btn) {
  var id = btn.getAttribute('data-like');
  var lc = btn.querySelector('.lc');
  var heart = btn.querySelector('.heart');
  var wasLiked = !!likedSet[id];
  var action = wasLiked ? 'unlike' : 'like';
  var prevCount = lc ? parseInt(lc.textContent || '0', 10) || 0 : 0;
  var newCount = Math.max(0, prevCount + (wasLiked ? -1 : 1));
  if (wasLiked) delete likedSet[id]; else likedSet[id] = true;
  try { localStorage.setItem('liked', JSON.stringify(Object.keys(likedSet))); } catch (e) {}
  btn.classList.toggle('liked', !wasLiked);
  if (heart) heart.textContent = wasLiked ? '♡' : '♥';
  if (lc) lc.textContent = newCount;
  fetch('/api/videos/' + encodeURIComponent(id) + '/like', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: action }) })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(d) { if (lc && d && typeof d.likes === 'number') lc.textContent = d.likes; })
    .catch(function() {
      if (wasLiked) likedSet[id] = true; else delete likedSet[id];
      try { localStorage.setItem('liked', JSON.stringify(Object.keys(likedSet))); } catch (e) {}
      btn.classList.toggle('liked', wasLiked);
      if (heart) heart.textContent = wasLiked ? '♥' : '♡';
      if (lc) lc.textContent = prevCount;
    });
}

// Playlists — the creator's edit tokens live in localStorage ("pl_token_<id>")
// plus a list of the playlists this browser created ("my_playlists").
function plToken(id) { try { return localStorage.getItem('pl_token_' + id); } catch (e) { return null; } }
function myPlaylists() { try { return JSON.parse(localStorage.getItem('my_playlists') || '[]'); } catch (e) { return []; } }
function rememberPlaylist(id, title, token) {
  try {
    localStorage.setItem('pl_token_' + id, token);
    var list = myPlaylists().filter(function(p) { return p.id !== id; });
    list.unshift({ id: id, title: title });
    localStorage.setItem('my_playlists', JSON.stringify(list.slice(0, 50)));
  } catch (e) {}
}
function plApi(id, action, body) {
  return fetch('/api/playlists/' + encodeURIComponent(id) + '/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ token: plToken(id) }, body || {})),
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); });
}
function closePlMenu() { var m = document.querySelector('.plmenu'); if (m) m.remove(); }
function openAddToPlaylist(videoId, anchor) {
  closePlMenu();
  var mine = myPlaylists();
  var menu = document.createElement('div');
  menu.className = 'plmenu';
  var h = '<h4>Add to a playlist</h4>';
  if (!mine.length) {
    h += '<button data-pl-new="1">Create a new playlist with this video…</button>';
  } else {
    mine.forEach(function(p) { h += '<button data-pl-pick="' + esc(p.id) + '">' + esc(p.title) + '</button>'; });
    h += '<button data-pl-new="1">＋ New playlist…</button>';
  }
  menu.innerHTML = h;
  document.body.appendChild(menu);
  var r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 260, r.left + window.scrollX)) + 'px';
  menu.style.top = (r.bottom + window.scrollY + 6) + 'px';
  menu.addEventListener('click', function(ev) {
    var pick = ev.target.closest('[data-pl-pick]');
    var nw = ev.target.closest('[data-pl-new]');
    if (pick) {
      var pid = pick.getAttribute('data-pl-pick');
      plApi(pid, 'add', { video_id: videoId }).then(function(res) {
        closePlMenu();
        if (res.ok) { pick.textContent = '✓ Added'; }
        else { alert((res.data && res.data.error) || 'Could not add to that playlist.'); }
      });
    } else if (nw) {
      closePlMenu();
      location.href = '/playlists/new?videos=' + encodeURIComponent(videoId);
    }
  });
  setTimeout(function() {
    document.addEventListener('click', function onDoc(e) {
      if (!menu.contains(e.target)) { closePlMenu(); document.removeEventListener('click', onDoc); }
    });
  }, 0);
}

// "Play all" queue: when a playlist is playing, playNext walks this list.
var plQueue = null;
var plPos = -1;
function playAll(ids) {
  if (!ids || !ids.length) return;
  plQueue = ids.slice();
  plPos = 0;
  navWatch({ id: ids[0] });
}

// Hamburger drawer
function openDrawer() { document.getElementById('drawer').classList.add('open'); document.getElementById('backdrop').classList.add('open'); }
function closeDrawer() { var d = document.getElementById('drawer'); if (d) d.classList.remove('open'); var b = document.getElementById('backdrop'); if (b) b.classList.remove('open'); }
function drawerOpen() { var d = document.getElementById('drawer'); return d && d.classList.contains('open'); }

function api(path) { return fetch(path).then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }

function cardHTML(v, showChannel) {
  var c = v.channel;
  var tags = '';
  if (v.tags && v.tags.length) {
    tags = '<div class="tags">' + v.tags.slice(0, 3).map(function(t) { return '<a class="tag" href="/tag/' + encodeURIComponent(t) + '">' + esc(t) + '</a>'; }).join('') + '</div>';
  }
  return '<a class="card" href="' + watchURL(v) + '">'
    + '<div class="thumb"><img loading="lazy" src="' + thumb(v.id) + '" alt="">'
    + (c.featured === v.id ? '<span class="pick">★ TubePlus pick</span>' : '')
    + (v.dur ? '<span class="dur">' + fmtDur(v.dur) + '</span>' : '')
    + '</div>'
    + '<div class="meta"><div style="min-width:0">'
    + '<div class="t" title="' + esc(v.title) + '">' + esc(v.title) + '</div>'
    + '<div class="sub">' + (showChannel ? '<a class="chlink" href="' + channelURL(c) + '">' + esc(c.name) + '</a> ' + tierBadge(c.tier) : '')
    + (v.views != null ? '<span>' + (showChannel ? '· ' : '') + fmtViews(v.views) + '</span>' : '')
    + (v.category ? '<span>· <a class="catlink" href="/category/' + esc(v.category.slug) + '">' + esc(v.category.name) + '</a></span>' : '')
    + (v.published_at ? '<span>· ' + fmtDateAbs(v.published_at) + '</span>' : '')
    + '</div>' + tags + '<div class="likerow">' + likeBtnHTML(v.id, v.likes) + '<button class="addpl-btn" data-addpl="' + v.id + '" title="Add to a playlist">＋ Playlist</button></div></div></div></a>';
}
function miniHTML(v) {
  var c = v.channel;
  return '<a class="mini" href="' + watchURL(v) + '">'
    + '<div class="thumb"><img loading="lazy" src="' + thumb(v.id) + '" alt="">' + (v.dur ? '<span class="dur">' + fmtDur(v.dur) + '</span>' : '') + '</div>'
    + '<div style="min-width:0"><div class="t" title="' + esc(v.title) + '">' + esc(v.title) + '</div>'
    + '<div class="sub">' + esc(c.name) + ' ' + tierBadge(c.tier) + '</div>'
    + '<div class="sub">' + [v.views != null ? fmtViews(v.views) : '', v.published_at ? fmtDateAbs(v.published_at) : ''].filter(Boolean).join(' · ') + '</div></div></a>';
}

function chipsHTML() {
  var h = '<div class="chips" id="chips">';
  h += '<button class="chip' + (!state.tier ? ' on' : '') + '" data-tier="">All</button>';
  TIERS.forEach(function(t) { h += '<button class="chip' + (state.tier === t ? ' on' : '') + '" data-tier="' + t + '">' + tierBadge(t) + ' tier</button>'; });
  h += '<button class="chip' + (state.len === 'short' ? ' on' : '') + '" data-len="short">Under 10 min</button>';
  h += '<button class="chip' + (state.len === 'long' ? ' on' : '') + '" data-len="long">30+ min</button>';
  h += '</div>';
  h += '<div class="filterrow"><span class="rescount" id="rescount"></span>'
    + '<label class="sortwrap">Sort <select id="sortsel">'
    + '<option value="views">Most viewed</option><option value="latest">Latest</option><option value="likes">Most liked</option><option value="longest">Longest</option><option value="shortest">Shortest</option><option value="shuffle">Shuffle</option>'
    + '</select></label></div>';
  return h;
}
function setSortSel() { var s = document.getElementById('sortsel'); if (s) s.value = state.sort; }
function updateCount() {
  var rc = document.getElementById('rescount');
  if (rc) rc.textContent = state.total.toLocaleString() + (state.view === 'search' ? ' results' : ' videos');
  var st = document.getElementById('searchtitle');
  if (st && state.view === 'search') st.textContent = state.total.toLocaleString() + ' results for "' + state.q + '"';
}
function renderChips() {
  var w = document.getElementById('chipswrap');
  if (w) w.innerHTML = chipsHTML();
  setSortSel();
  updateCount();
}

function videosURL(page) {
  var p = new URLSearchParams();
  if (state.channel != null) p.set('channel', state.channel);
  if (state.tier) p.set('tier', state.tier);
  if (state.category) p.set('category', state.category);
  if (state.tag) p.set('tag', state.tag);
  if (state.q) p.set('q', state.q);
  if (state.len) p.set('len', state.len);
  if (state.picks) p.set('picks', '1');
  p.set('sort', state.sort);
  p.set('page', page);
  p.set('limit', 24);
  return '/api/videos?' + p.toString();
}
function loadPage(page) {
  if (state.loading || state.done) return Promise.resolve();
  state.loading = true;
  return api(videosURL(page)).then(function(d) {
    state.total = d.total;
    var grid = document.getElementById('grid');
    if (page === 1 && grid) grid.innerHTML = '';
    if (d.videos.length && grid) {
      grid.insertAdjacentHTML('beforeend', d.videos.map(function(v) { return cardHTML(v, state.view !== 'channel'); }).join(''));
    }
    if (page === 1 && !d.videos.length && grid) {
      grid.innerHTML = '<div class="empty">No videos match these filters.</div>';
    }
    state.nextPage = d.nextPage;
    state.done = !d.nextPage;
    updateCount();
    if (state.done) { var s = document.getElementById('sentinel'); if (s) s.remove(); }
    state.loading = false;
  }).catch(function() { state.loading = false; });
}
function watchSentinel() {
  if (gridObserver) gridObserver.disconnect();
  var s = document.getElementById('sentinel');
  if (!s || state.done) return;
  gridObserver = new IntersectionObserver(function(es) { if (es.some(function(e) { return e.isIntersecting; })) loadPage(state.nextPage || 1); }, { rootMargin: '1200px' });
  gridObserver.observe(s);
}
function applyFilters() {
  renderChips();
  state.page = 1; state.done = false; state.nextPage = null;
  loadPage(1).then(watchSentinel);
  window.scrollTo(0, 0);
}

function viewHome(picks) {
  state.view = picks ? 'picks' : 'home';
  state.picks = !!picks;
  state.channel = null; state.q = ''; state.page = 1; state.done = false; state.nextPage = null;
  state.tier = null; state.len = null; state.sort = 'views';
  state.tag = null; state.category = null;
  var main = document.getElementById('main');
  main.innerHTML = (picks ? '<h2 class="pagetitle">★ TubePlus picks — one video per channel, the one each channel chose to represent itself</h2>' : '')
    + '<div id="chipswrap">' + chipsHTML() + '</div>'
    + '<div class="feed"><div class="grid" id="grid"></div><div class="sentinel" id="sentinel"></div></div>';
  setSortSel();
  loadPage(1).then(watchSentinel);
  document.title = picks ? 'TubePlus picks - TubePlus' : 'TubePlus';
  window.scrollTo(0, 0);
  cleanup = function() { if (gridObserver) gridObserver.disconnect(); };
}

function viewChannel(id) {
  // Legacy #/c/<id> route: convert to the canonical channel path, no reload,
  // then render the same collection view the server uses.
  var c = CH[id];
  var main = document.getElementById('main');
  if (!c) { main.innerHTML = '<div class="empty">Channel not found.</div>'; return; }
  var url = channelURL(c);
  if (location.pathname !== url) history.replaceState(null, '', url);
  viewCollection('channel', id, 'views');
}

function viewSearch(q) {
  state.view = 'search'; state.q = q; state.channel = null; state.picks = false; state.page = 1; state.done = false; state.nextPage = null;
  var qi = document.getElementById('q');
  if (qi) qi.value = q;
  var main = document.getElementById('main');
  main.innerHTML = '<h2 class="pagetitle" id="searchtitle"></h2>'
    + '<div id="chipswrap">' + chipsHTML() + '</div>'
    + '<div class="feed"><div class="grid" id="grid"></div><div class="sentinel" id="sentinel"></div></div>';
  setSortSel();
  loadPage(1).then(function() { updateCount(); watchSentinel(); });
  document.title = q + ' - TubePlus';
  window.scrollTo(0, 0);
  cleanup = function() { if (gridObserver) gridObserver.disconnect(); };
}

// --- v3 collection views (/new, /category/*, /tag/*, /channel/*) -------------
function collectionHeading() {
  if (state.view === 'new') return { h: 'New videos', sub: 'The newest uploads from the channels, in publish order.' };
  if (state.view === 'category') {
    var cat = null;
    CATS.forEach(function(c) { if (c.slug === state.category) cat = c; });
    return { h: cat ? cat.name : state.category, sub: '' };
  }
  if (state.view === 'tag') return { h: '#' + state.tag, sub: '' };
  if (state.view === 'channel') {
    var ch = CH[state.channel];
    return { h: ch ? ch.name : 'Channel', sub: '' };
  }
  return { h: '', sub: '' };
}
function viewCollection(view, key, sort) {
  state.view = view;
  state.channel = view === 'channel' ? key : null;
  state.category = view === 'category' ? key : null;
  state.tag = view === 'tag' ? key : null;
  state.q = ''; state.picks = false; state.page = 1; state.done = false; state.nextPage = null;
  state.tier = null; state.len = null;
  state.sort = sort || (view === 'new' ? 'latest' : 'views');
  var main = document.getElementById('main');
  var head = collectionHeading();
  var chHead = '';
  if (view === 'channel') {
    var c = CH[key];
    if (!c) { main.innerHTML = '<div class="empty">Channel not found.</div>'; return; }
    chHead = '<div class="chhead">' + av(c) + '<div style="min-width:0">'
      + '<h1>' + esc(c.name) + ' ' + tierBadge(c.tier) + '</h1>'
      + '<div class="sub">' + esc(TIER_NAMES[c.tier]) + ' tier' + (c.tag ? ' · ' + esc(c.tag) : '') + ' · ' + (c.video_count || c.n || 0).toLocaleString() + ' videos</div>'
      + (c.blurb ? '<div class="blurb">' + esc(c.blurb) + '</div>' : '')
      + '<div class="actions"><a class="pill" href="' + esc(c.url) + '" target="_blank" rel="noopener">Channel on YouTube ↗</a></div>'
      + '</div></div>';
  }
  main.innerHTML = '<h1 class="pagetitle">' + esc(head.h) + '</h1>'
    + (head.sub ? '<p class="pagesub">' + esc(head.sub) + '</p>' : '')
    + chHead
    + '<div id="chipswrap">' + chipsHTML() + '</div>'
    + '<div class="feed"><div class="grid" id="grid"></div><div class="sentinel" id="sentinel"></div></div>';
  setSortSel();
  loadPage(1).then(watchSentinel);
  document.title = head.h + ' - TubePlus';
  window.scrollTo(0, 0);
  cleanup = function() { if (gridObserver) gridObserver.disconnect(); };
}
function adoptSSRPage() {
  // A collection page was server-rendered; take it over (read #ssrPage).
  var data = null;
  try { data = JSON.parse(document.getElementById('ssrPage').textContent || '{}'); } catch (e) {}
  if (!data || !data.view) return false;
  ssrAdopted = true;
  state.view = data.view;
  state.channel = data.channel || null;
  state.category = data.category || null;
  state.tag = data.tag || null;
  state.q = ''; state.picks = false; state.page = 1;
  state.tier = null; state.len = null;
  state.sort = data.sort || 'views';
  var s = document.getElementById('sentinel');
  if (s) {
    state.total = parseInt(s.getAttribute('data-total') || '0', 10);
    state.nextPage = parseInt(s.getAttribute('data-next') || '0', 10) || null;
    state.done = !state.nextPage;
    updateCount();
    watchSentinel();
    refreshLikeStates();
    }
  setSortSel();
  cleanup = function() { if (gridObserver) gridObserver.disconnect(); };
  return true;
}

// --- v3 playlist views ------------------------------------------------------
var plCurrent = null;
function viewPlaylist(id) {
  state.view = 'playlist';
  var main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  api('/api/playlists/' + encodeURIComponent(id)).then(function(p) {
    if (!p || !p.id) { main.innerHTML = '<div class="empty">Playlist not found.</div>'; return; }
    plCurrent = p;
    if (location.pathname !== playlistURL(p)) history.replaceState(null, '', playlistURL(p));
    renderPlaylistPage(p);
  }).catch(function() { main.innerHTML = '<div class="empty">Playlist not found.</div>'; });
}
function renderPlaylistPage(p) {
  var main = document.getElementById('main');
  var items = p.videos.map(function(v, i) {
    return '<div class="plvideo" data-vid="' + v.id + '"><span class="plpos">' + (i + 1) + '</span>'
      + miniHTML(v)
      + '<span class="pledit" data-editbtns="' + v.id + '" style="display:none"><button class="pill small" data-pl-up="' + v.id + '" title="Move up">↑</button><button class="pill small" data-pl-down="' + v.id + '" title="Move down">↓</button><button class="pill small" data-pl-remove="' + v.id + '" title="Remove from playlist">✕</button></span></div>';
  }).join('');
  main.innerHTML = '<h1 class="pagetitle">' + esc(p.title) + '</h1>'
    + (p.description ? '<p class="pagesub">' + esc(p.description) + '</p>' : '')
    + '<p class="pagesub">' + p.videos.length + ' video' + (p.videos.length === 1 ? '' : 's') + ' · created ' + esc(new Date(p.created_at).toLocaleDateString()) + '</p>'
    + '<div class="plactions"><button class="pill primary" id="playAllBtn">▶ Play all</button>'
    + '<span class="pledit" data-editbtns="page" style="display:none"><button class="pill" id="plEditBtn">Edit title / description</button><button class="pill" id="plDeleteBtn">Delete playlist</button></span></div>'
    + '<div id="plEditForm" style="display:none"></div>'
    + '<div class="pllist">' + (items || '<div class="empty">This playlist is empty.</div>') + '</div>';
  document.title = p.title + ' - TubePlus';
  window.scrollTo(0, 0);
  wirePlaylistPage(p);
  cleanup = function() {};
}
function wirePlaylistPage(p) {
  // Edit affordances only if this browser holds the edit token.
  var hasToken = !!plToken(p.id);
  document.querySelectorAll('[data-editbtns]').forEach(function(el) { el.style.display = hasToken ? '' : 'none'; });
  var playAllBtn = document.getElementById('playAllBtn');
  if (playAllBtn) playAllBtn.onclick = function() { playAll(p.videos.map(function(v) { return v.id; })); };
  var editBtn = document.getElementById('plEditBtn');
  if (editBtn) editBtn.onclick = function() { showPlEditForm(p); };
  var delBtn = document.getElementById('plDeleteBtn');
  if (delBtn) delBtn.onclick = function() {
    if (!confirm('Delete this playlist? This cannot be undone.')) return;
    plApi(p.id, 'delete', {}).then(function(res) {
      if (res.ok) { try { localStorage.removeItem('pl_token_' + p.id); } catch (e) {} location.href = '/playlists'; }
      else alert((res.data && res.data.error) || 'Could not delete.');
    });
  };
}
function showPlEditForm(p) {
  var box = document.getElementById('plEditForm');
  if (!box) return;
  box.style.display = '';
  box.innerHTML = '<form class="plainform" id="plEditInner">'
    + '<label>Title<input type="text" name="title" required maxlength="200" value="' + esc(p.title) + '"></label>'
    + '<label>Description<textarea name="description" maxlength="2000" rows="3">' + esc(p.description || '') + '</textarea></label>'
    + '<button class="pill primary" type="submit">Save</button> <button class="pill" type="button" id="plEditCancel">Cancel</button></form>';
  document.getElementById('plEditCancel').onclick = function() { box.style.display = 'none'; box.innerHTML = ''; };
  document.getElementById('plEditInner').addEventListener('submit', function(e) {
    e.preventDefault();
    var title = e.target.title.value.trim();
    var desc = e.target.description.value.trim();
    plApi(p.id, 'edit', { title: title, description: desc }).then(function(res) {
      if (res.ok) { viewPlaylist(p.id); }
      else alert((res.data && res.data.error) || 'Could not save.');
    });
  });
}
function adoptSSRPlaylist() {
  var data = null;
  try { data = JSON.parse(document.getElementById('ssrPage').textContent || '{}'); } catch (e) {}
  if (!data || data.view !== 'playlist') return false;
  ssrAdopted = true;
  state.view = 'playlist';
  api('/api/playlists/' + encodeURIComponent(data.id)).then(function(p) {
    if (p && p.id) { plCurrent = p; wirePlaylistPage(p); }
  });
  cleanup = function() {};
  return true;
}
function viewPlaylists() {
  state.view = 'playlists';
  var main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  api('/api/playlists?limit=24').then(function(d) {
    var items = (d.playlists || []).map(function(p) {
      return '<a class="plitem" href="' + playlistURL(p) + '"><div class="pltitle">' + esc(p.title) + '</div><div class="plsub">' + p.count + ' video' + (p.count === 1 ? '' : 's') + ' · ' + esc(new Date(p.created_at).toLocaleDateString()) + '</div>' + (p.description ? '<div class="pldesc">' + esc(p.description) + '</div>' : '') + '</a>';
    }).join('');
    main.innerHTML = '<h1 class="pagetitle">Playlists</h1>'
      + '<p class="pagesub">Public playlists made from the catalog — anyone with the link can watch them. <a href="/playlists/new">Create one →</a></p>'
      + (items || '<div class="empty">No playlists yet. Be the first to make one.</div>');
    document.title = 'Playlists - TubePlus';
    window.scrollTo(0, 0);
    cleanup = function() {};
  }).catch(function() { main.innerHTML = '<div class="empty">Could not load playlists.</div>'; });
}

var ytReady = null, player = null, upNext = [];
var watchId = null;
var autoplayNext = true;
try { autoplayNext = localStorage.getItem('autoplayNext') !== '0'; } catch (e) {}
function loadYT() {
  if (!ytReady) ytReady = new Promise(function(res) {
    window.onYouTubeIframeAPIReady = res;
    var s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
  return ytReady;
}
function wireWatchPage() {
  // Wire the buttons on a watch page, client-rendered or server-rendered.
  var mb = document.getElementById('wmoreBtn');
  if (mb) mb.onclick = function() { var d = document.getElementById('wdesc'); var open = d.hasAttribute('hidden'); if (open) d.removeAttribute('hidden'); else d.setAttribute('hidden', ''); mb.textContent = open ? 'Show less' : '…more'; };
  var nb = document.getElementById('nextBtn');
  if (nb) nb.onclick = playNext;
  var an = document.getElementById('autoNext');
  if (an) an.checked = autoplayNext;
  refreshLikeStates();
}
function mountPlayer(id) {
  loadYT().then(function() {
    if (watchId !== id) return;
    player = new YT.Player('ytplayer', {
      videoId: id,
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
      events: { onStateChange: function(e) { if (e.data === YT.PlayerState.ENDED && autoplayNext) playNext(); } },
    });
  });
}
function viewWatch(id) {
  state.view = 'watch';
  watchId = id;
  upNext = [];
  var main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  api('/api/videos/' + encodeURIComponent(id)).then(function(v) {
    if (!v || !v.id) { main.innerHTML = '<div class="empty">Video not found.</div>'; return; }
    var c = v.channel;
    // A legacy #/watch/<id> link converts to the canonical path, no reload.
    if (location.hash.match(/^#\/watch\//)) history.replaceState(null, '', watchURL(v));
    var metaParts = [
      '<a class="wm-ch" href="' + channelURL(c) + '">' + esc(c.name) + '</a> ' + tierBadge(c.tier),
      v.views != null ? fmtViews(v.views) : '',
      v.dur ? fmtDur(v.dur) : '',
      v.published_at ? fmtDateAbs(v.published_at) : ''
    ].filter(Boolean);
    var tagLinks = (v.tags || []).slice(0, 2).map(function(t) { return '<a class="wtag" href="/tag/' + encodeURIComponent(t) + '">#' + esc(t) + '</a>'; }).join(' ');
    main.innerHTML = '<div class="watch"><div class="primary">'
      + '<div class="player"><div id="ytplayer"></div></div>'
      + '<h1>' + esc(v.title) + '</h1>'
      + '<div class="wmeta">' + metaParts.join(' · ') + (tagLinks ? ' · ' + tagLinks : '') + (c.featured === v.id ? ' · <span style="color:#e0b400">★ TubePlus pick for this channel</span>' : '') + ' <button class="wmore" id="wmoreBtn">…more</button></div>'
      + '<div class="wdesc" id="wdesc" hidden><div class="why"><b>' + tierBadge(c.tier) + ' ' + esc(c.tier) + ' tier' + (c.tag ? ' · ' + esc(c.tag) : '') + ' · ' + (c.video_count || c.n || 0).toLocaleString() + ' videos</b>' + (c.blurb ? esc(c.blurb) : '<span style="color:var(--fg2)">No write-up for this channel.</span>') + '</div><div style="margin-top:8px"><a class="ytlink" href="https://www.youtube.com/watch?v=' + v.id + '" target="_blank" rel="noopener">Open on YouTube ↗</a></div></div>'
      + '<div class="wrow">' + av(c) + '<button class="pill primary" id="nextBtn" title="Shift+N">Next random ⏭</button>'
      + '<div class="wacts">' + likeBtnHTML(v.id, v.likes, true) + '<button class="icobtn" data-addpl="' + v.id + '" title="Add to a playlist">＋</button><a class="icobtn" href="https://www.youtube.com/watch?v=' + v.id + '" target="_blank" rel="noopener" title="Open on YouTube">↗</a></div></div>'
      + '</div><div class="secondary"><div class="upnext-h"><h3>Up next</h3><label class="autoplay" title="Play a random video when this one ends">Autoplay <input type="checkbox" id="autoNext"' + (autoplayNext ? ' checked' : '') + '></label></div><div id="upnext"></div></div></div>';
    wireWatchPage();
    document.title = v.title + ' - TubePlus';
    window.scrollTo(0, 0);
    mountPlayer(id);
    Promise.all([
      api('/api/videos?channel=' + c.id + '&sort=views&limit=8'),
      api('/api/videos?sort=shuffle&limit=12')
    ]).then(function(res) {
      var seenIds = {};
      seenIds[id] = true;
      var list = [];
      res[0].videos.forEach(function(x) { if (!seenIds[x.id]) { seenIds[x.id] = true; list.push(x); } });
      res[1].videos.forEach(function(x) { if (!seenIds[x.id]) { seenIds[x.id] = true; list.push(x); } });
      upNext = list.slice(0, 16);
      var box = document.getElementById('upnext');
      if (box) box.innerHTML = upNext.map(miniHTML).join('');
    });
    cleanup = function() { try { if (player) player.destroy(); } catch (e) {} player = null; watchId = null; };
  }).catch(function() { main.innerHTML = '<div class="empty">Video not found.</div>'; });
}
function adoptSSRWatch(id) {
  // The server rendered this watch page already; take it over instead of
  // re-fetching. The video id + up-next came down in #ssrWatch JSON.
  state.view = 'watch';
  watchId = id;
  ssrWatchAdopted = true;
  var data = null;
  try { data = JSON.parse(document.getElementById('ssrWatch').textContent || '{}'); } catch (e) {}
  upNext = (data && data.upNext) || [];
  wireWatchPage();
  mountPlayer(id);
  cleanup = function() { try { if (player) player.destroy(); } catch (e) {} player = null; watchId = null; };
}
function navWatch(v, href) {
  history.pushState(null, '', href || watchURL(v));
  viewWatch(v.id);
}
function playNext() {
  // A "Play all" playlist queue wins over up-next / random.
  if (plQueue && plPos >= 0 && plPos < plQueue.length - 1) {
    plPos += 1;
    navWatch({ id: plQueue[plPos] });
    return;
  }
  var v = (upNext && upNext.length) ? upNext[0] : null;
  if (v) { navWatch(v); return; }
  api('/api/random').then(function(r) { if (r && r.id) navWatch(r); });
}

function viewAbout() {
  var tierCounts = TIERS.map(function(t) {
    var chs = CHLIST.filter(function(c) { return c.tier === t; });
    var n = 0; chs.forEach(function(c) { n += (c.video_count || c.n || 0); });
    return '<span class="stat">' + tierBadge(t) + ' <b>' + chs.length + '</b> channels · <b>' + n.toLocaleString() + '</b> videos</span>';
  }).join('');
  var catCounts = CATS.map(function(cat) { return '<span class="stat"><b>' + cat.count.toLocaleString() + '</b> ' + esc(cat.name) + '</span>'; }).join('');
  document.getElementById('main').innerHTML = '<div class="about">'
    + '<h1>About TubePlus</h1>'
    + '<p>A YouTube-style viewer for every channel on <a class="link" href="https://thume.ca/2026/11/01/youtube-tier-list-2026/" target="_blank" rel="noopener">Tristan Hume’s YouTube tier list (2026)</a>, rebuilt on Cloudflare Workers + D1 — with a category and tags for every video. The catalogue holds <b>' + state.total.toLocaleString() + '</b> videos across <b>' + CHLIST.length + '</b> channels.</p>'
    + '<div class="stats">' + tierCounts + '</div>'
    + '<h2>Categories</h2><div class="stats">' + catCounts + '</div>'
    + '<h2>How it works</h2><ul>'
    + '<li>The home feed is served from D1: filter by tier, category, tag, or duration, and sort by views, latest, likes, length, or shuffle.</li>'
    + '<li>Click any tag on a card to open that tag’s page; channel names open the channel page, and categories have their own pages too — all of them are real, shareable URLs.</li>'
    + '<li><b>New videos</b> lists the newest uploads, pulled daily from the channels’ YouTube RSS feeds.</li>'
    + '<li>Search matches video titles and tag names.</li>'
    + '<li>Use the ☰ menu (top left) for categories and the full channel list. Click the heart on any card or watch page to like a video — likes are counted in D1 and remembered on this device, and "Most liked" sorts the feed by them.</li>'
    + '<li><b>Playlists</b>: make your own public playlist from catalog videos, or import a public YouTube playlist into the catalog. The ＋ Playlist button on any card or watch page adds a video to one of your playlists.</li>'
    + '<li><a class="link" href="/add-channel">Add a channel</a> to the catalog, or <a class="link" href="/import-playlist">import a YouTube playlist</a> — new channels go live immediately.</li>'
    + '<li><b>Surprise me</b> (Shift+N) plays a random video. <b>T</b> opens TV mode: fullscreen, one random video after another.</li>'
    + '</ul>'
    + '<h2>Keyboard</h2><ul>'
    + '<li><kbd>Shift</kbd> + <kbd>N</kbd>: play a random video (or the next one in “Up next” while watching)</li>'
    + '<li><kbd>/</kbd>: jump to search</li>'
    + '<li><kbd>T</kbd>: TV mode</li>'
    + '<li><kbd>Esc</kbd>: close the menu drawer (or exit TV mode)</li>'
    + '</ul>'
    + '<h2>TV mode</h2><p>Press <kbd>T</kbd> or the TV button in the top bar for a lean-back mode: fullscreen, one random video after another, no clicking needed. If you are already watching something, it continues that video.</p><ul>'
    + '<li><kbd>1</kbd>–<kbd>9</kbd>: jump to 10%–90% of the video, <kbd>0</kbd>: back to the start</li>'
    + '<li><kbd>N</kbd>: next video, <kbd>P</kbd>: previous video</li>'
    + '<li><kbd>Space</kbd>: pause, <kbd>←</kbd> / <kbd>→</kbd>: back / forward 10 seconds, <kbd>M</kbd>: mute</li>'
    + '<li><kbd>Esc</kbd> or <kbd>T</kbd>: exit. Clicking the video pauses it.</li>'
    + '</ul>'
    + '<h2>Data</h2><p>Videos play through YouTube\u2019s embedded player. Thumbnails come from YouTube\u2019s image servers. Categories and tags are TubePlus additions stored in D1.</p>'
    + '</div>';
  document.title = 'About - TubePlus';
  window.scrollTo(0, 0);
}


// ---------------------------------------------------------------------------
// TV mode — fullscreen lean-back player (port of the original concept).
// ---------------------------------------------------------------------------
var tv = { open: false, player: null, ready: false, hist: [], pos: -1, uiTimer: 0, toastTimer: 0, tick: 0, wentFull: false };
function tvPick() { return api('/api/random'); }
function tvCurrent() { return tv.hist[tv.pos]; }
function tvOpen() {
  if (tv.open) return;
  tv.open = true;
  closeDrawer();
  document.getElementById('tv').classList.add('open');
  try { var fs = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (fs && fs.then) { fs.then(function() { tv.wentFull = true; }, function() {}); } else if (fs !== undefined) { tv.wentFull = true; } } catch (e) {}
  document.querySelector('#tvBar i').style.width = '0%';
  document.getElementById('tvCur').textContent = '0:00';
  document.getElementById('tvDur').textContent = '0:00';
  document.getElementById('tvTitle').textContent = '';
  document.getElementById('tvChan').textContent = '';
  if (tv.hist.length) { tvLoad(); return; }
  var m = location.pathname.match(/^\/watch\/([\w-]{11})/) || location.hash.match(/^#\/watch\/([\w-]{11})/);
  if (m) {
    tv.hist = [{ id: m[1], title: 'Loading…', channel: { name: '' } }];
    tv.pos = 0;
    tvLoad();
    return;
  }
  tvPick().then(function(v) {
    if (v && v.id) { tv.hist = [v]; tv.pos = 0; tvLoad(); }
    else { tvToast('No video found'); tvClose(); }
  });
}
function tvClose() {
  if (!tv.open) return;
  tv.open = false;
  tv.wentFull = false;
  clearInterval(tv.tick);
  if (tv.player) tv.player.destroy();
  tv.player = null; tv.ready = false;
  document.getElementById('tv').classList.remove('open');
  if (document.fullscreenElement) document.exitFullscreen().catch(function() {});
  if (location.hash === '#/watch/' + (tvCurrent() && tvCurrent().id)) history.back();
}
function tvLoad() {
  var cur = tvCurrent();
  if (!cur) return;
  if (cur.title == null) {
    api('/api/videos/' + encodeURIComponent(cur.id)).then(function(v) { if (v && v.id) { tv.hist[tv.pos] = v; tvRenderInfo(); } });
  }
  tvRenderInfo();
  if (tv.ready) {
    tv.player.loadVideoById(cur.id);
    tv.player.unMute();
    tv.player.playVideo();
  } else {
    loadYT().then(function() {
      if (!tv.open || !tvCurrent() || tvCurrent().id !== cur.id) return;
      tv.player = new YT.Player('tvplayer', {
        videoId: cur.id,
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: function(e) { tv.ready = true; e.target.unMute(); e.target.playVideo(); },
          onError: function() { tvToast("Can't play this one, skipping…"); setTimeout(tvNext, 800); },
          onStateChange: function(e) {
            if (e.data === YT.PlayerState.ENDED) tvNext();
            else if (e.data === YT.PlayerState.PLAYING) tvShowUI(2500);
          },
        },
      });
    });
  }
  if (tv.tick) clearInterval(tv.tick);
  tv.tick = setInterval(tvUpdateBar, 250);
  tvShowUI(2500);
}
function tvNext() {
  if (tv.pos < tv.hist.length - 1) {
    tv.pos += 1;
    tvLoad();
    return;
  }
  tvPick().then(function(v) {
    if (v && v.id) {
      tv.hist.push(v);
      tv.pos = tv.hist.length - 1;
      tvLoad();
    }
  });
}
function tvPrev() {
  if (tv.pos > 0) { tv.pos -= 1; tvLoad(); }
  else tvToast("That's the first one");
}
function tvRenderInfo() {
  var cur = tvCurrent();
  if (!cur) return;
  document.getElementById('tvTitle').textContent = cur.title || 'Loading…';
  document.getElementById('tvChan').textContent = (cur.channel && cur.channel.name) || '';
  document.title = (cur.title || 'TV mode') + ' - TubePlus';
}
function tvUpdateBar() {
  if (!tv.open || !tv.ready || !tv.player) return;
  try {
    var d = tv.player.getDuration();
    var t = tv.player.getCurrentTime();
    if (d) {
      document.querySelector('#tvBar i').style.width = (t / d * 100) + '%';
      document.getElementById('tvCur').textContent = fmtDur(t);
      document.getElementById('tvDur').textContent = fmtDur(d);
    }
  } catch (e) {}
}
function tvShowUI(ms) {
  document.getElementById('tv').classList.add('show-ui');
  clearTimeout(tv.uiTimer);
  tv.uiTimer = setTimeout(function() { document.getElementById('tv').classList.remove('show-ui'); }, ms == null ? 2500 : ms);
}
function tvToast(msg) {
  var el = document.getElementById('tvToast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(tv.toastTimer);
  tv.toastTimer = setTimeout(function() { el.classList.remove('on'); }, 2000);
}
function tvTogglePause() {
  if (!tv.ready || !tv.player) return;
  var s = tv.player.getPlayerState();
  if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) { tv.player.pauseVideo(); tvToast('Paused'); }
  else { tv.player.playVideo(); tvToast('Playing'); }
  tvShowUI(2500);
}
function tvSeek(seconds, label) {
  if (!tv.ready || !tv.player) return;
  tv.player.seekTo(tv.player.getCurrentTime() + seconds, true);
  tvUpdateBar();
  tvToast(label);
  tvShowUI(2500);
}
function tvKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  var k = e.key;
  if (k === 'Escape' || k === 't' || k === 'T') { e.preventDefault(); tvClose(); return; }
  if (!tv.ready || !tv.player) return;
  if (k >= '0' && k <= '9') {
    e.preventDefault();
    var d = tv.player.getDuration();
    if (d) {
      var frac = k === '0' ? 0 : parseInt(k, 10) / 10;
      tv.player.seekTo(d * frac, true);
      tvUpdateBar();
      tvToast(Math.round(frac * 100) + '%');
      tvShowUI(2500);
    }
  } else if (k === 'n' || k === 'N') { tvNext(); }
  else if (k === 'p' || k === 'P') { tvPrev(); }
  else if (k === ' ') { e.preventDefault(); tvTogglePause(); }
  else if (k === 'ArrowRight') { e.preventDefault(); tvSeek(10, '+10s'); }
  else if (k === 'ArrowLeft') { e.preventDefault(); tvSeek(-10, '−10s'); }
  else if (k === 'm' || k === 'M') {
    e.preventDefault();
    if (tv.player.isMuted()) { tv.player.unMute(); tvToast('Unmuted'); } else { tv.player.mute(); tvToast('Muted'); }
    tvShowUI(2500);
  }
}

// ---------------------------------------------------------------------------
// Router + boot
// ---------------------------------------------------------------------------
function markSide(route) {
  document.querySelectorAll('#drawer .item[data-route]').forEach(function(a) {
    var r = a.getAttribute('data-route');
    var on = (route === 'home' && r === 'home') || (route === 'picks' && r === 'picks') || (route === 'new' && r === 'new') || (route === 'playlists' && r === 'playlists') || (route.indexOf('c/') === 0 && r === route);
    a.classList.toggle('active', on);
  });
}
var ssrAdopted = false;
var ssrWatchAdopted = false;
function adoptSSRHome() {
  // The server rendered the first page already; take it over instead of
  // re-fetching. Wire the sentinel for page 2+ and read the total.
  ssrAdopted = true;
  state.view = 'home';
  state.picks = false; state.channel = null; state.q = ''; state.sort = 'views';
  state.tier = null; state.category = null; state.tag = null; state.len = null;
  var s = document.getElementById('sentinel');
  if (s) {
    state.total = parseInt(s.getAttribute('data-total') || '0', 10);
    state.nextPage = parseInt(s.getAttribute('data-next') || '0', 10) || null;
    state.done = !state.nextPage;
    updateCount();
    watchSentinel();
    refreshLikeStates();
    }
  cleanup = function() { if (gridObserver) gridObserver.disconnect(); };
}
function route() {
  if (cleanup) cleanup();
  var rawHash = location.hash;
  var h = rawHash.replace(/^#\/?/, '');
  var m;
  if (rawHash !== '') {
    // A hash route wins over the pathname: the pathname stays /watch/... while
    // the user browses hash pages (picks, channel, search, ...) from a watch page.
    if (h === 'picks') {
      markSide('picks'); viewHome(true);
    } else if ((m = h.match(/^c\/(\d+)$/))) {
      markSide('c/' + m[1]); viewChannel(parseInt(m[1], 10));
    } else if ((m = h.match(/^watch\/([\w-]{11})/))) {
      // Legacy hash watch link: viewWatch converts it to the canonical path.
      markSide(''); viewWatch(m[1]);
    } else if (h.indexOf('search/') === 0) {
      markSide(''); viewSearch(decodeURIComponent(h.slice(7)));
    } else if (h === 'about') {
      markSide(''); viewAbout();
    } else if (h === '') {
      // '#/' means home: leave any real page path behind (pushState to '/').
      if (location.pathname !== '/') history.pushState(null, '', '/');
      if (!ssrAdopted && document.getElementById('grid') && document.getElementById('sentinel')) { adoptSSRHome(); markSide('home'); document.title = 'TubePlus'; }
      else { markSide('home'); viewHome(false); }
    } else {
      markSide('home'); viewHome(false);
    }
  } else {
    routePath();
  }
  closeDrawer();
}
function routePath() {
  // No hash: render the real page path (SSR-adopt when the server rendered it).
  var m;
  var path = location.pathname;
  if ((m = path.match(/^\/watch\/([\w-]{11})/))) {
    markSide('');
    var ssr = document.getElementById('ssrWatch');
    if (ssr && !ssrWatchAdopted) adoptSSRWatch(m[1]); else viewWatch(m[1]);
    return;
  }
  if (path === '/new') {
    markSide('new');
    if (!ssrAdopted && document.getElementById('ssrPage')) adoptSSRPage(); else viewCollection('new');
    return;
  }
  if ((m = path.match(/^\/category\/([^/]+)$/))) {
    markSide('');
    var slug = decodeURIComponent(m[1]);
    if (!ssrAdopted && document.getElementById('ssrPage')) adoptSSRPage(); else viewCollection('category', slug);
    return;
  }
  if ((m = path.match(/^\/tag\/([^/]+)$/))) {
    markSide('');
    var tag = decodeURIComponent(m[1]);
    if (!ssrAdopted && document.getElementById('ssrPage')) adoptSSRPage(); else viewCollection('tag', tag);
    return;
  }
  if ((m = path.match(/^\/channel\/(\d+)(?:\/[^/]*)?$/))) {
    var cid = parseInt(m[1], 10);
    markSide('c/' + cid);
    if (!ssrAdopted && document.getElementById('ssrPage')) adoptSSRPage(); else viewCollection('channel', cid);
    return;
  }
  if ((m = path.match(/^\/playlist\/([\w-]+)(?:\/[^/]*)?$/))) {
    markSide('playlists');
    if (!ssrAdopted && document.getElementById('ssrPage')) adoptSSRPlaylist(); else viewPlaylist(m[1]);
    return;
  }
  if (path === '/playlists') {
    markSide('playlists');
    if (!document.querySelector('.plitem')) viewPlaylists();
    return;
  }
  if (path === '/add-channel' || path === '/import-playlist' || path === '/playlists/new') {
    // Server-rendered form pages: leave the SSR in place.
    markSide('');
    return;
  }
  if (!ssrAdopted && document.getElementById('grid') && document.getElementById('sentinel')) {
    adoptSSRHome(); markSide('home'); document.title = 'TubePlus';
  } else {
    markSide('home'); viewHome(false);
  }
}

function boot() {
  // A one-time edit token (?token=) on a playlist page: store it in this
  // browser (so the playlist can be edited here) and strip it from the URL.
  (function() {
    var m = location.pathname.match(/^\/playlist\/([\w-]+)/);
    var params = new URLSearchParams(location.search);
    var tok = params.get('token');
    if (m && tok) {
      var pid = m[1];
      api('/api/playlists/' + encodeURIComponent(pid)).then(function(p) {
        if (p && p.id) rememberPlaylist(p.id, p.title, tok);
      }).catch(function() {});
      history.replaceState(null, '', location.pathname);
    }
  })();
  Promise.all([api('/api/channels'), api('/api/categories'), api('/api/videos?limit=1')]).then(function(res) {
    CHLIST = res[0].channels || [];
    CHLIST.forEach(function(c) { CH[c.id] = c; });
    CATS = res[1].categories || [];
    state.total = res[2].total || 0;
    route();
    var qi = document.getElementById('q');
    if (qi) qi.placeholder = 'Search ' + state.total.toLocaleString() + ' videos';
    wirePlaylistNewForm();
  }).catch(function() {
    route();
    wirePlaylistNewForm();
  });
}

// The create-playlist form (/playlists/new): search-to-pick videos from the
// catalog, plus prefill from ?videos= (import follow-up / add-to-playlist).
function wirePlaylistNewForm() {
  var form = document.getElementById('plNewForm');
  if (!form) return;
  var picked = [];
  var pickedBox = document.getElementById('plPicked');
  var idsField = document.getElementById('plVideoIds');
  var search = document.getElementById('plSearch');
  var resBox = document.getElementById('plSearchRes');
  function renderPicked() {
    pickedBox.innerHTML = picked.map(function(v, i) {
      return '<div class="plrow"><span class="t">' + esc(v.title) + ' <span style="color:var(--fg2)">— ' + esc(v.channel.name) + '</span></span><button type="button" class="pill small" data-unpick="' + i + '">✕</button></div>';
    }).join('');
    idsField.value = picked.map(function(v) { return v.id; }).join(',');
  }
  function addPicked(v) {
    if (picked.some(function(x) { return x.id === v.id; })) return;
    picked.push(v);
    renderPicked();
    if (search) search.value = '';
    if (resBox) resBox.innerHTML = '';
  }
  pickedBox.addEventListener('click', function(e) {
    var b = e.target.closest('[data-unpick]');
    if (b) { picked.splice(parseInt(b.getAttribute('data-unpick'), 10), 1); renderPicked(); }
  });
  var searchTimer = null;
  if (search) search.addEventListener('input', function() {
    clearTimeout(searchTimer);
    var q = search.value.trim();
    if (q.length < 2) { resBox.innerHTML = ''; return; }
    searchTimer = setTimeout(function() {
      api('/api/videos?q=' + encodeURIComponent(q) + '&limit=6').then(function(d) {
        resBox.innerHTML = (d.videos || []).map(function(v) {
          return '<div class="plpick" data-pick="' + v.id + '"><img src="' + thumb(v.id) + '" alt=""><div><div class="t">' + esc(v.title) + '</div><div class="s">' + esc(v.channel.name) + ' · ' + fmtViews(v.views) + '</div></div></div>';
        }).join('');
        resBox.querySelectorAll('[data-pick]').forEach(function(el) {
          el.addEventListener('click', function() {
            var id = el.getAttribute('data-pick');
            api('/api/videos/' + encodeURIComponent(id)).then(function(v) { if (v && v.id) addPicked(v); });
          });
        });
      }).catch(function() {});
    }, 250);
  });
  var params = new URLSearchParams(location.search);
  var pre = params.get('videos');
  if (pre) {
    pre.split(',').filter(Boolean).slice(0, 100).forEach(function(id) {
      api('/api/videos/' + encodeURIComponent(id.trim())).then(function(v) { if (v && v.id) addPicked(v); }).catch(function() {});
    });
  }
  renderPicked();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
document.addEventListener('click', function(e) {
  var likeEl = e.target.closest('[data-like]');
  if (likeEl) {
    e.preventDefault(); e.stopPropagation();
    toggleLike(likeEl);
    return;
  }
  var addplEl = e.target.closest('[data-addpl]');
  if (addplEl) {
    e.preventDefault(); e.stopPropagation();
    openAddToPlaylist(addplEl.getAttribute('data-addpl'), addplEl);
    return;
  }
  var watchEl = e.target.closest('a[href^="/watch/"]');
  if (watchEl) {
    e.preventDefault();
    var href = watchEl.getAttribute('href');
    var wm = href.match(/^\/watch\/([\w-]{11})/);
    if (wm) navWatch({ id: wm[1] }, href);
    return;
  }
  // Real pages (SSR on direct load, pushState + client render here).
  var pageEl = e.target.closest('a[href="/new"], a[href="/playlists"], a[href^="/category/"], a[href^="/tag/"], a[href^="/channel/"], a[href^="/playlist/"]');
  if (pageEl) {
    e.preventDefault();
    var p = pageEl.getAttribute('href');
    if (location.pathname + location.hash !== p) history.pushState(null, '', p);
    route();
    return;
  }
  var upEl = e.target.closest('[data-pl-up]');
  if (upEl) {
    e.preventDefault();
    var pid = plCurrent && plCurrent.id;
    if (!pid) return;
    var ids = plCurrent.videos.map(function(v) { return v.id; });
    var i = ids.indexOf(upEl.getAttribute('data-pl-up'));
    if (i > 0) {
      var tmp = ids[i - 1]; ids[i - 1] = ids[i]; ids[i] = tmp;
      plApi(pid, 'reorder', { video_ids: ids }).then(function(res) { if (res.ok) viewPlaylist(pid); });
    }
    return;
  }
  var downEl = e.target.closest('[data-pl-down]');
  if (downEl) {
    e.preventDefault();
    var pid2 = plCurrent && plCurrent.id;
    if (!pid2) return;
    var ids2 = plCurrent.videos.map(function(v) { return v.id; });
    var j = ids2.indexOf(downEl.getAttribute('data-pl-down'));
    if (j >= 0 && j < ids2.length - 1) {
      var tmp2 = ids2[j + 1]; ids2[j + 1] = ids2[j]; ids2[j] = tmp2;
      plApi(pid2, 'reorder', { video_ids: ids2 }).then(function(res) { if (res.ok) viewPlaylist(pid2); });
    }
    return;
  }
  var rmEl = e.target.closest('[data-pl-remove]');
  if (rmEl) {
    e.preventDefault();
    var pid3 = plCurrent && plCurrent.id;
    if (!pid3) return;
    plApi(pid3, 'remove', { video_id: rmEl.getAttribute('data-pl-remove') }).then(function(res) { if (res.ok) viewPlaylist(pid3); });
    return;
  }
  var tierEl = e.target.closest('[data-tier]');
  if (tierEl) {
    state.tier = tierEl.getAttribute('data-tier') || null;
    applyFilters();
    return;
  }
  var lenEl = e.target.closest('[data-len]');
  if (lenEl) {
    var lv = lenEl.getAttribute('data-len');
    state.len = state.len === lv ? null : lv;
    applyFilters();
    return;
  }
});
document.addEventListener('change', function(e) {
  var t = e.target;
  if (t && t.id === 'sortsel') {
    state.sort = t.value;
    state.page = 1; state.done = false; state.nextPage = null;
    loadPage(1).then(watchSentinel);
    window.scrollTo(0, 0);
  } else if (t && t.id === 'autoNext') {
    autoplayNext = t.checked;
    try { localStorage.setItem('autoplayNext', autoplayNext ? '1' : '0'); } catch (err) {}
  }
});
document.getElementById('searchForm').addEventListener('submit', function(e) {
  e.preventDefault();
  var q = document.getElementById('q').value.trim();
  if (q) location.hash = '#/search/' + encodeURIComponent(q);
});
document.getElementById('themeBtn').addEventListener('click', function() {
  var root = document.documentElement;
  var cur = root.getAttribute('data-theme');
  var lightNow = cur === 'light' || (!cur && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  var next = lightNow ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (e) {}
});
document.getElementById('luckyBtn').addEventListener('click', function() { playNext(); });
document.getElementById('menuBtn').addEventListener('click', function() { if (drawerOpen()) closeDrawer(); else openDrawer(); });
document.getElementById('backdrop').addEventListener('click', closeDrawer);
document.getElementById('tvBtn').addEventListener('click', tvOpen);
document.getElementById('tvExit').addEventListener('click', tvClose);
document.querySelector('#tv .tvcatch').addEventListener('click', tvTogglePause);
document.getElementById('tv').addEventListener('mousemove', function() { if (tv.open) tvShowUI(2500); });
document.addEventListener('fullscreenchange', function() { if (!document.fullscreenElement && tv.open && tv.wentFull) tvClose(); });
document.addEventListener('keydown', function(e) {
  var typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable);
  if (tv.open) { tvKey(e); return; }
  if (drawerOpen() && e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
  if (typing) return;
  if (e.key === 't' || e.key === 'T') { e.preventDefault(); tvOpen(); }
  else if (e.key === '/') { e.preventDefault(); document.getElementById('q').focus(); }
  else if (e.shiftKey && (e.key === 'N' || e.key === 'n')) { e.preventDefault(); playNext(); }
});

window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);
boot();
`

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export default app
