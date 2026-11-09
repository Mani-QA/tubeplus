#!/usr/bin/env python3
"""Generate an SEO slug from each video's title and write the D1 migration.

Slug rules (must match the TypeScript slugify in the Worker exactly):
  - NFKD normalize, drop non-ASCII (accents stripped, CJK/emoji dropped)
  - lowercase, any run of non [a-z0-9] becomes a single '-'
  - strip leading/trailing '-', collapse, truncate to 60 chars at a hyphen
    boundary (a single long word keeps its first 60 chars)
  - empty result stays empty -> the Worker treats it as "no slug" and the
    canonical URL is just /watch/<id>

Outputs:
  seed_slugs.sql  - ALTER TABLE videos ADD COLUMN slug TEXT + one UPDATE per
                    video (same chunked style as the other seed files)
  enriched.json   - rewritten with a "slug" key on every video (keeps the
                    dataset and the DB in sync for future rebuilds)
"""
import json, os, re, sqlite3, unicodedata
from collections import Counter

OUT = "/home/hatch/workspace/tubeplus/data"
MAX_LEN = 60

def slugify(title):
    s = unicodedata.normalize("NFKD", title or "")
    s = s.encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    if len(s) > MAX_LEN:
        cut = s[:MAX_LEN].rsplit("-", 1)[0]
        s = cut if cut else s[:MAX_LEN].rstrip("-")
        s = s.strip("-")
    return s

def sql_str(v):
    return "'" + str(v).replace("'", "''") + "'"

with open(os.path.join(OUT, "enriched.json")) as f:
    data = json.load(f)
videos = data["videos"]
assert len(videos) == 47339, len(videos)

slugs = {}
for v in videos:
    slugs[v["id"]] = slugify(v["title"])
    v["slug"] = slugs[v["id"]]

empty = [vid for vid, s in slugs.items() if not s]
dupes = [s for s, n in Counter(slugs.values()).items() if n > 1 and s]
print(f"videos: {len(videos)}")
print(f"empty slugs (non-ASCII-only titles): {len(empty)}")
print(f"duplicate slug values (harmless, id is in the URL): {len(dupes)}")
print(f"max slug length: {max(len(s) for s in slugs.values())}")
for vid in empty[:10]:
    t = next(v["title"] for v in videos if v["id"] == vid)
    print(f"  empty: {vid} :: {t[:80]}")

# --- write migration: ALTER + one UPDATE per video, 500 per chunk --------
path = os.path.join(OUT, "seed_slugs.sql")
with open(path, "w") as f:
    f.write("ALTER TABLE videos ADD COLUMN slug TEXT;\n")
    items = list(slugs.items())
    for i in range(0, len(items), 500):
        for vid, s in items[i:i + 500]:
            f.write(f"UPDATE videos SET slug={sql_str(s)} WHERE id={sql_str(vid)};\n")
print(f"wrote {path}: {os.path.getsize(path):,} bytes")

# --- enriched.json with slugs ---------------------------------------------
with open(os.path.join(OUT, "enriched.json"), "w") as f:
    json.dump(data, f)
print("enriched.json rewritten with slug per video")

# --- validate in SQLite: schema + seeds + migration -----------------------
con = sqlite3.connect(":memory:")
with open(os.path.join(OUT, "schema.sql")) as f:
    con.executescript(f.read())
# schema.sql is the OLD one (no slug column) unless already updated; the
# migration's ALTER adds it. Apply seeds first, then the migration.
for fn in ["seed_categories.sql", "seed_channels.sql", "seed_videos.sql",
           "seed_tags.sql", "seed_video_tags.sql", "seed_slugs.sql"]:
    with open(os.path.join(OUT, fn)) as f:
        con.executescript(f.read())
cur = con.cursor()
print("=== sqlite validation ===")
print("videos:", cur.execute("SELECT COUNT(*) FROM videos").fetchone()[0])
print("with slug:", cur.execute("SELECT COUNT(*) FROM videos WHERE slug IS NOT NULL AND slug != ''").fetchone()[0])
print("empty slug:", cur.execute("SELECT COUNT(*) FROM videos WHERE slug IS NULL OR slug = ''").fetchone()[0])
print("max slug len:", cur.execute("SELECT MAX(LENGTH(slug)) FROM videos").fetchone()[0])
print("bad chars:", cur.execute("SELECT COUNT(*) FROM videos WHERE slug GLOB '*[^a-z0-9-]*'").fetchone()[0])
for row in cur.execute(
    "SELECT id, title, slug FROM videos WHERE title LIKE '%Marble Machine%' LIMIT 3").fetchall():
    print(f"  {row[0]} :: {row[1][:60]} -> {row[2]}")
for row in cur.execute(
    "SELECT id, title, slug FROM videos ORDER BY views DESC LIMIT 3").fetchall():
    print(f"  top: {row[0]} :: {row[1][:60]} -> {row[2]}")
con.close()
print("OK")
