#!/usr/bin/env python3
"""TubePlus SEO checks (a)-(f) + (j) against a local wrangler dev server.
Usage: python3 verify-seo.py [base_url]  (default http://127.0.0.1:8787)"""
import json, re, subprocess, sys, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
fails = []

def get(path):
    req = urllib.request.Request(BASE + path, method='GET')
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode('utf-8', 'replace')

def get_nofollow(path):
    # curl: no redirect following; prints "<status>|<Location>"
    out = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}|%{redirect_url}',
                          BASE + path], capture_output=True, text=True).stdout
    code, _, loc = out.partition('|')
    return int(code), loc

def check(name, ok, detail=''):
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + detail if detail else ''))
    if not ok:
        fails.append(name)

# (j) API returns slug
s, _, b = get('/api/videos?limit=3')
d = json.loads(b)
check('(j) /api/videos returns slug field', all('slug' in v and v['slug'] for v in d['videos']),
      'first: ' + json.dumps(d['videos'][0])[:160])
s, _, b = get('/api/videos/IvUU8joBb1Q')
d = json.loads(b)
check('(j) /api/videos/:id returns slug', d.get('slug') == 'wintergatan-marble-machine-music-instrument-using-2000', d.get('slug', ''))
WINTER_VIEWS = d.get('views')
s, _, b = get('/api/random')
d = json.loads(b)
check('(j) /api/random returns slug', isinstance(d.get('slug'), str) and len(d['slug']) > 0, d.get('slug', ''))

# (a) canonical watch page
s, _, b = get('/watch/IvUU8joBb1Q/wintergatan-marble-machine-music-instrument-using-2000')
check('(a) GET /watch/<id>/<slug> -> 200', s == 200, str(s))
check('(a) <title>', '<title>Wintergatan - Marble Machine (music instrument using 2000 marbles) — TubePlus</title>' in b)
m = re.search(r'<meta name="description" content="([^"]*)"', b)
check('(a) meta description', bool(m) and 'Wintergatan' in m.group(1) and 'Music &amp; Art' in m.group(1), m.group(1) if m else '')
check('(a) canonical link', '<link rel="canonical" href="https://tubeplus.www5.workers.dev/watch/IvUU8joBb1Q/wintergatan-marble-machine-music-instrument-using-2000">' in b)
check('(a) og:title/type/url/image',
      'property="og:title" content="Wintergatan - Marble Machine (music instrument using 2000 marbles)"' in b
      and 'property="og:type" content="video.other"' in b
      and 'property="og:url" content="https://tubeplus.www5.workers.dev/watch/IvUU8joBb1Q/wintergatan-marble-machine-music-instrument-using-2000"' in b
      and 'property="og:image" content="https://i.ytimg.com/vi/IvUU8joBb1Q/hqdefault.jpg"' in b)
check('(a) twitter card', 'name="twitter:card" content="summary_large_image"' in b
      and 'name="twitter:image" content="https://i.ytimg.com/vi/IvUU8joBb1Q/hqdefault.jpg"' in b)
ldm = re.search(r'<script type="application/ld\+json">(.*?)</script>', b, re.S)
ld_ok = False
if ldm:
    ld = json.loads(ldm.group(1))
    ld_ok = (ld.get('@type') == 'VideoObject'
             and ld.get('name', '').startswith('Wintergatan - Marble Machine')
             and ld.get('thumbnailUrl') == 'https://i.ytimg.com/vi/IvUU8joBb1Q/hqdefault.jpg'
             and ld.get('contentUrl') == 'https://www.youtube.com/watch?v=IvUU8joBb1Q'
             and ld.get('embedUrl') == 'https://www.youtube.com/embed/IvUU8joBb1Q'
             and ld.get('interactionStatistic', {}).get('userInteractionCount') == WINTER_VIEWS
             and 'uploadDate' not in ld)
check('(a) JSON-LD VideoObject', ld_ok, json.dumps(json.loads(ldm.group(1)))[:200] if ldm else 'missing')
check('(a) SSR watch body: player + up-next + like',
      '<div id="ytplayer"></div>' in b and 'id="upnext"' in b and 'data-like="IvUU8joBb1Q"' in b
      and b.count('class="mini"') >= 1)
check('(a) SSR watch: card links are paths, no href="#/watch/ links',
      'href="#/watch/' not in b and '/watch/' in b)

# (b) no slug -> 301 to canonical
s, loc = get_nofollow('/watch/IvUU8joBb1Q')
check('(b) GET /watch/<id> -> 301 to canonical', s == 301 and loc.endswith('/watch/IvUU8joBb1Q/wintergatan-marble-machine-music-instrument-using-2000'),
      f'{s} Location={loc}')

# (c) wrong slug -> 301 to canonical
s, loc = get_nofollow('/watch/IvUU8joBb1Q/totally-wrong-slug')
check('(c) GET /watch/<id>/wrong-slug -> 301 to canonical', s == 301 and loc.endswith('/watch/IvUU8joBb1Q/wintergatan-marble-machine-music-instrument-using-2000'),
      f'{s} Location={loc}')

# (d) unknown id -> 404
s, _, b = get('/watch/AAAAAAAAAAA/whatever-slug')
check('(d) GET /watch/<unknown-id> -> 404', s == 404 and 'Video not found' in b, str(s))

# (e) sitemaps
s, _, b = get('/sitemap.xml')
shards = re.findall(r'/sitemap-videos-(\d+)\.xml', b)
check('(e) /sitemap.xml lists 5 video shards + pages', s == 200 and shards == ['0', '1', '2', '3', '4'] and '/sitemap-pages.xml' in b,
      f'{s} shards={shards}')
s, _, b = get('/sitemap-videos-0.xml')
locs = re.findall(r'<loc>([^<]+)</loc>', b)
check('(e) shard 0 has 10,000 <loc>', len(locs) == 10000, str(len(locs)))
ok_fmt = all(re.match(r'^https://tubeplus\.www5\.workers\.dev/watch/[A-Za-z0-9_-]{11}/[a-z0-9-]+$', u) for u in locs)
check('(e) shard 0 locs all match /watch/<id>/<slug>', ok_fmt, locs[0] if locs else '')
check('(e) shard 0 first loc is most-viewed video', locs and locs[0] == 'https://tubeplus.www5.workers.dev/watch/IvUU8joBb1Q/wintergatan-marble-machine-music-instrument-using-2000',
      locs[0] if locs else '')
check('(e) shard 0 has no <lastmod>', '<lastmod>' not in b)
s, _, b = get('/sitemap-videos-4.xml')
locs4 = re.findall(r'<loc>([^<]+)</loc>', b)
check('(e) shard 4 has 7,339 <loc>', len(locs4) == 7339, str(len(locs4)))
s, _, b = get('/sitemap-videos-5.xml')
check('(e) shard 5 (out of range) -> 404', s == 404, str(s))
s, _, b = get('/sitemap-pages.xml')
check('(e) /sitemap-pages.xml lists only home', s == 200 and b.count('<loc>') == 1 and 'https://tubeplus.www5.workers.dev/</loc>' in b, b.strip()[:200])

# (f) robots.txt
s, _, b = get('/robots.txt')
check('(f) /robots.txt has sitemap line', s == 200 and 'Sitemap: https://tubeplus.www5.workers.dev/sitemap.xml' in b and 'User-agent: *' in b and 'Allow: /' in b, b.strip().replace('\n', ' | '))

# home page still SSR + path links
s, _, b = get('/')
check('home still 200 + cards use path links', s == 200 and 'class="card"' in b and 'href="#/watch/' not in b, str(s))

print()
print('RESULT:', 'ALL PASS' if not fails else f'{len(fails)} FAILURES: {fails}')
sys.exit(1 if fails else 0)
