#!/usr/bin/env python3
"""TubePlus RSS ingest — add new videos from channel RSS feeds into the D1.

Usage:
  python3 ingest.py [--local | --remote] [--channels 68,10 | --all]
                    [--limit N] [--apply] [--out FILE] [--delay 0.5]
                    [--no-duration]

- Reads the channel list from D1 (id, name, url, category_id) and the tag
  table (id, name). The channel's category comes from channels.category_id
  (backfilled from data/channel_categories.json in v3); if a channel has
  none, it falls back to that JSON file.
- Fetches each channel's YouTube RSS feed (curl, browser UA, a polite delay
  between channels). For each entry whose video ID is not already in D1 it
  inserts a row: id, title, slug (ytutil.slugify), duration (best-effort
  from the watch page's lengthSeconds, else NULL), views (media:statistics),
  channel_id, category_id (from the channel), published_at (RSS <published>),
  tags (ytutil.video_tags_for — keyword tags + channel topic fallback).
- Dedupe: INSERT OR IGNORE (id is the PK) plus a pre-check against the
  existing video IDs, so duration fetches are skipped for videos
  already in the catalog. Idempotent: re-running inserts nothing new.
- Performance: the existence check is ONE batched SELECT ... WHERE id IN
  (...) per 500 entry IDs (not one wrangler call per channel — wrangler
  startup is ~3s each and 156 of them was the bulk of the ~30 min first
  run), and duration fetches run in a 5-thread pool. The first (catch-up)
  run inserts ~800 videos in ~5 min; a daily re-run (0 new) takes ~2 min.
  Channels whose url has no /channel/UC... ID are skipped (two seed rows,
  Ferris + Blender Guru, were fixed to canonical /channel/UC... URLs).
- By default it only WRITES the SQL file and prints a report (safe). Pass
  --apply to also run `wrangler d1 execute tubeplus-db --local/--remote
  --file <sql>`. The default target is --local; use --remote for the real run.
- The new-video count is verified by counting videos with published_at set
  before and after applying (seed videos have published_at NULL).

Recommended schedule (daily, before the morning stock note):
  06:00 IST, from the box:  cd ~/tubeplus && python3 ingest.py --remote --apply
  (the box copy lives at ~/tubeplus/ with the same worker/ + data/ layout).
  No cron is created by this script; the parent sets the schedule up.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
WORKER_DIR = os.path.join(HERE, "worker")
sys.path.insert(0, DATA)
import ytutil  # noqa: E402

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
NS = {"a": "http://www.w3.org/2005/Atom",
      "yt": "http://www.youtube.com/xml/schemas/2015",
      "media": "http://search.yahoo.com/mrss/"}
DUR_RE = re.compile(r'"lengthSeconds"\s*:\s*"(\d+)"')


def run_wrangler(args, input_data=None):
    """Run `npx wrangler d1 execute tubeplus-db ...` in the worker dir.
    Returns (returncode, stdout, stderr)."""
    cmd = ["npx", "wrangler", "d1", "execute", "tubeplus-db"] + args
    p = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=True,
                       text=True, input=input_data)
    return p.returncode, p.stdout, p.stderr


def d1_query(sql, target):
    """Run one SQL statement against D1; return the list of result rows."""
    rc, out, _err = run_wrangler(
        ["--" + target, "--command", sql, "--json"])
    if rc != 0:
        raise RuntimeError(f"wrangler d1 execute failed ({rc}): {out[:500]}")
    data = json.loads(out)
    return data[0].get("results", [])


def d1_count_published(target):
    rows = d1_query(
        "SELECT COUNT(*) AS c FROM videos WHERE published_at IS NOT NULL",
        target)
    return rows[0]["c"]


def curl(url, timeout=20):
    """Fetch a URL with curl (browser UA); return text or None on failure."""
    p = subprocess.run(["curl", "-s", "-m", str(timeout), "-A", UA, url],
                       capture_output=True, text=True)
    if p.returncode != 0 or not p.stdout:
        return None
    return p.stdout


def fetch_rss(uc_id):
    """Fetch a channel RSS feed. Returns (feed_title, entries) or None.
    Each entry: {id, title, published, views, channel_id, author}."""
    xml = curl(f"https://www.youtube.com/feeds/videos.xml?channel_id={uc_id}")
    if xml is None:
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    entries = []
    for e in root.findall("a:entry", NS):
        vid = e.findtext("yt:videoId", "", NS)
        if not vid:
            continue
        stats = e.find("media:group/media:community/media:statistics", NS)
        views = None
        if stats is not None and stats.get("views"):
            try:
                views = int(stats.get("views"))
            except ValueError:
                views = None
        entries.append({
            "id": vid,
            "title": e.findtext("a:title", "", NS),
            "published": e.findtext("a:published", "", NS) or None,
            "views": views,
            "channel_id": e.findtext("yt:channelId", "", NS),
            "author": e.findtext("a:author/a:name", "", NS),
        })
    return root.findtext("a:title", "", NS), entries


def fetch_duration(video_id):
    """Best-effort duration (seconds) from the watch page; None on failure."""
    html = curl(f"https://www.youtube.com/watch?v={video_id}", timeout=15)
    if not html:
        return None
    m = DUR_RE.search(html)
    return int(m.group(1)) if m else None


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("\r", " ").replace("\n", " ").replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser(description="TubePlus RSS ingest")
    ap.add_argument("--local", action="store_true", default=True,
                    help="target the local D1 (default)")
    ap.add_argument("--remote", action="store_true",
                    help="target the live D1")
    ap.add_argument("--channels", default="all",
                    help="comma list of channel ids or UC IDs, or 'all'")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap the number of channels (for testing)")
    ap.add_argument("--apply", action="store_true",
                    help="apply the SQL to D1 (default: only write the file)")
    ap.add_argument("--out", default=None,
                    help="SQL output path (default data/ingest_<timestamp>.sql)")
    ap.add_argument("--delay", type=float, default=0.5,
                    help="seconds between RSS fetches (default 0.5)")
    ap.add_argument("--no-duration", action="store_true",
                    help="skip the watch-page duration fetch (durations NULL)")
    args = ap.parse_args()
    target = "remote" if args.remote else "local"

    # --- reference data from D1
    channels = d1_query(
        "SELECT id, name, url, category_id FROM channels ORDER BY id", target)
    cat_rows = d1_query("SELECT id, slug FROM categories", target)
    cat_by_slug = {r["slug"]: r["id"] for r in cat_rows}
    tag_rows = d1_query("SELECT id, name FROM tags", target)
    tag_id = {r["name"]: r["id"] for r in tag_rows}
    max_tag_id = max(tag_id.values()) if tag_id else 0
    # Fallback category map (channel index -> slug) for channels with no
    # category_id in D1 (e.g. a fresh local seed before the backfill).
    chan_cat = {}
    cc_path = os.path.join(DATA, "channel_categories.json")
    if os.path.exists(cc_path):
        chan_cat = json.load(open(cc_path))

    # --- channel selection
    if args.channels != "all":
        wanted = set()
        for tok in args.channels.split(","):
            tok = tok.strip()
            if tok.startswith("UC"):
                wanted.add(tok)
            else:
                wanted.add(int(tok))
        channels = [c for c in channels
                    if c["id"] in wanted or
                    (c["url"] and c["url"].rstrip("/").split("/")[-1] in wanted)]
    if args.limit:
        channels = channels[: args.limit]

    out_path = args.out or os.path.join(
        DATA, "ingest_" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".sql")
    sql_lines = ["-- TubePlus RSS ingest (ingest.py). INSERT OR IGNORE: "
                 "re-running is safe.",
                 "BEGIN TRANSACTION;"]
    new_tags = {}  # name -> id (assigned on the fly)
    report = []
    total_new = 0
    total_fail = 0

    # --- phase 1: fetch every channel's RSS (collect entries per channel)
    feeds = []  # (channel, entries)
    for ch in channels:
        url = (ch.get("url") or "")
        uc = url.rstrip("/").split("/")[-1] if "/channel/" in url else None
        if not uc or not uc.startswith("UC"):
            report.append((ch["id"], ch["name"], "skip (no UC ID)", 0))
            continue
        got = fetch_rss(uc)
        if got is None:
            report.append((ch["id"], ch["name"], "RSS fetch FAILED", 0))
            total_fail += 1
            continue
        _feed_title, entries = got
        feeds.append((ch, entries))
        time.sleep(args.delay)

    # --- phase 2: one batched existence check for ALL entry IDs
    # (a single SELECT ... WHERE id IN (...) per 500-id chunk, instead of one
    # wrangler call per channel — wrangler startup is ~3s each, and 156 of
    # them was the bulk of the ~30 min first run)
    all_ids = sorted({e["id"] for _ch, entries in feeds for e in entries})
    existing = set()
    for i in range(0, len(all_ids), 500):
        chunk = all_ids[i:i + 500]
        in_list = ",".join("'" + vid.replace("'", "''") + "'"
                           for vid in chunk)
        existing |= {r["id"] for r in d1_query(
            f"SELECT id FROM videos WHERE id IN ({in_list})", target)}

    # --- phase 3: durations + SQL for the new entries
    # Duration fetches run in a small thread pool (independent I/O); the SQL
    # is still built in feed order so the file is deterministic.
    from concurrent.futures import ThreadPoolExecutor
    new_entries = []  # (channel, entry, category_id)
    for ch, entries in feeds:
        cat_id = ch.get("category_id")
        if cat_id is None:
            slug = chan_cat.get(str(ch["id"]))
            cat_id = cat_by_slug.get(slug) if slug else None
        new = [e for e in entries if e["id"] not in existing]
        for e in new:
            new_entries.append((ch, e, cat_id))
        total_new += len(new)
        report.append((ch["id"], ch["name"], f"{len(entries)} in feed",
                       len(new)))
    durations = {}
    if not args.no_duration and new_entries:
        with ThreadPoolExecutor(max_workers=5) as pool:
            futs = {pool.submit(fetch_duration, e["id"]): e["id"]
                    for _ch, e, _c in new_entries}
            for fut, vid in futs.items():
                try:
                    durations[vid] = fut.result()
                except Exception:
                    durations[vid] = None
    for ch, e, cat_id in new_entries:
        dur = None if args.no_duration else durations.get(e["id"])
        tags = ytutil.video_tags_for(e["title"], ch["id"])
        sql_lines.append(
            f"INSERT OR IGNORE INTO videos (id, title, slug, duration_s, "
            f"views, channel_id, category_id, published_at) VALUES "
            f"({sql_str(e['id'])}, {sql_str(e['title'])}, "
            f"{sql_str(ytutil.slugify(e['title']))}, "
            f"{'NULL' if dur is None else dur}, "
            f"{'NULL' if e['views'] is None else e['views']}, "
            f"{ch['id']}, {'NULL' if cat_id is None else cat_id}, "
            f"{sql_str(e['published'])});")
        for t in tags:
            if t not in tag_id and t not in new_tags:
                max_tag_id += 1
                new_tags[t] = max_tag_id
            tid = tag_id.get(t, new_tags.get(t))
            if tid is not None:
                sql_lines.append(
                    f"INSERT OR IGNORE INTO video_tags (video_id, tag_id) "
                    f"VALUES ({sql_str(e['id'])}, {tid});")
    for t, tid in sorted(new_tags.items(), key=lambda kv: kv[1]):
        sql_lines.insert(2, f"INSERT OR IGNORE INTO tags (id, name) VALUES "
                            f"({tid}, {sql_str(t)});")
    # channels.n is what the site uses for drawer and result counts.
    for cid in sorted({int(ch["id"]) for ch, _e, _c in new_entries}):
        sql_lines.append(
            "UPDATE channels SET n = (SELECT COUNT(*) FROM videos "
            f"WHERE channel_id = {cid}) WHERE id = {cid};")
    sql_lines.append("COMMIT;")
    with open(out_path, "w") as f:
        f.write("\n".join(sql_lines) + "\n")

    before = d1_count_published(target)
    applied = False
    after = before
    if args.apply:
        rc, out, err = run_wrangler(
            ["--" + target, "--file", out_path])
        if rc != 0:
            print(f"ERROR applying {out_path}:\n{out}\n{err}")
            sys.exit(1)
        applied = True
        after = d1_count_published(target)

    print(f"target: {target} | channels checked: {len(channels)} | "
          f"new videos: {total_new} | RSS failures: {total_fail}")
    print(f"SQL written to {out_path}")
    if applied:
        print(f"applied. videos with published_at: {before} -> {after} "
              f"(inserted {after - before})")
    else:
        print("not applied (pass --apply to write to D1)")
    for cid, name, feed, n in report:
        if n or "FAIL" in feed or "skip" in feed:
            print(f"  ch {cid} {name}: {feed}, new={n}")


if __name__ == "__main__":
    main()
