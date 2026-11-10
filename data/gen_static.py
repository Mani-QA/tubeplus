#!/usr/bin/env python3
"""Generate the static HTML snapshot of the TubePlus catalog.

A fast, self-contained version of the site that needs no database and no
Worker: every video is embedded as compact JSON and rendered by inline
JS (search, sort, filter, incremental rendering). Served as a static
asset at /videos/ (tubeplus.net/videos/).

Data per video (compact array, slug computed client-side from the title
with the same slugify as the Worker; a wrong slug 301s to canonical):
  [youtube_id, title, duration_s, views, channel_index, published_ts]
Channels: [name, tier, category_slug].

Usage:
  python3 gen_static.py [--local] [--out PATH]
    --local  run wrangler directly (use on the box, where wrangler
             handles --remote). Default: SSH to the box from the VM.
    --out    output HTML path (default: the Worker's assets dir).

Regenerate whenever new videos arrive (daily ingest cron runs this
after the RSS ingest + API enrichment, then redeploys the Worker so
the new asset goes live).
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone

BOX = "ubuntu@129.154.35.102"
SSH_KEY = "/home/hatch/.ssh/id_ed25519"
WRANGLER = "/home/ubuntu/.npm-global/bin/wrangler"
OUT_VM = "/home/hatch/workspace/tubeplus/worker/assets/videos/index.html"
OUT_BOX = "/home/ubuntu/tubeplus/worker/assets/videos/index.html"
BATCH = 10000


def run_ssh(cmd, timeout=180):
    full = ["ssh", "-i", SSH_KEY, "-o", "StrictHostKeyChecking=accept-new", BOX, cmd]
    p = subprocess.run(full, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def d1_query(sql, local=False, timeout=180):
    """Run a read query against live D1. Returns rows."""
    if local:
        cmd = (
            f"cd ~/tubeplus/worker && {WRANGLER} d1 execute tubeplus-db "
            f"--remote --json --command '{sql}'"
        )
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        rc, out, err = p.returncode, p.stdout, p.stderr
    else:
        safe = sql.replace("'", "'\\''")
        cmd = (
            f"cd ~/tubeplus/worker && {WRANGLER} d1 execute tubeplus-db "
            f"--remote --json --command '{safe}'"
        )
        rc, out, err = run_ssh(cmd, timeout=timeout)
    if rc != 0:
        raise RuntimeError(f"D1 query failed ({sql[:80]}): {err.strip()}")
    data = json.loads(out)
    rows = []
    for block in data:
        rows.extend(block.get("results", []))
    return rows


def d1_all(sql, local=False):
    """Fetch all rows for a query, in batches (wrangler JSON gets big)."""
    rows = []
    offset = 0
    while True:
        batch = d1_query(f"{sql} LIMIT {BATCH} OFFSET {offset}", local=local)
        rows.extend(batch)
        if len(batch) < BATCH:
            break
        offset += BATCH
    return rows


def to_ts(iso):
    """'2026-10-28T20:26:11+00:00' -> unix seconds (UTC). None if missing."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return None


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All videos - TubePlus</title>
<meta name="description" content="Every video on TubePlus — __COUNT__ videos from __CHANS__ channels. A fast static snapshot, no database needed.">
<link rel="canonical" href="https://tubeplus.net/videos/">
<style>
:root{--bg:#0f0f0f;--fg:#f1f1f1;--fg2:#aaa;--bg3:#272727;--bg4:#3d3d3d;--accent:#ff0033}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--fg);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{font-size:24px;margin:0}
h1 a{color:var(--fg)}
.sub{color:var(--fg2);font-size:14px}
.sub b{color:var(--fg)}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
.controls input,.controls select{height:38px;padding:0 12px;border:1px solid var(--bg4);border-radius:19px;background:var(--bg3);color:var(--fg);font:inherit;font-size:14px}
.controls input{flex:1;min-width:180px}
.controls select{cursor:pointer}
#count{color:var(--fg2);font-size:13px;margin:4px 0 12px}
.row{display:flex;gap:10px;align-items:baseline;padding:9px 4px;border-bottom:1px solid #222}
.row .t{flex:1;min-width:0;font-size:15px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .t a:hover{color:#fff}
.row .meta{flex:none;color:var(--fg2);font-size:12px;white-space:nowrap}
.tier{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;font-size:11px;font-weight:700;color:#000;margin-left:6px;vertical-align:1px}
.tS{background:#ffd700}.tA{background:#c0c0c0}.tB{background:#cd7f32}.tC{background:#7fb3d5}.tD{background:#95a5a6}
#more{display:block;margin:20px auto 0;height:38px;padding:0 22px;border-radius:19px;border:0;background:var(--fg);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
#more:hover{opacity:.9}
.empty{color:var(--fg2);padding:24px 4px}
footer{margin-top:32px;color:var(--fg2);font-size:13px}
footer a{color:#3ea6ff}
@media (max-width:700px){.row .meta .dur{display:none}}
</style>
</head>
<body>
<div class="wrap">
<header><h1><a href="/">TubePlus</a> — All videos</h1></header>
<p class="sub"><b>__COUNT__</b> videos · <b>__CHANS__</b> channels · static snapshot, updated <b>__UPDATED__</b> · <a href="/">back to the site ↗</a></p>
<div class="controls">
<input id="q" type="search" placeholder="Search __COUNT__ videos…" autocomplete="off">
<select id="sort"><option value="views">Most viewed</option><option value="new">Newest first</option><option value="old">Oldest first</option><option value="title">Title A–Z</option><option value="long">Longest</option></select>
<select id="chan"><option value="">All channels</option></select>
<select id="cat"><option value="">All categories</option></select>
</div>
<p id="count"></p>
<div id="list"></div>
<button id="more">Show more</button>
<footer>Fast static copy of the catalog — no database, no Worker. Video pages, search and the full site live at <a href="https://tubeplus.net/">tubeplus.net</a>.</footer>
</div>
<script>
var VIDEOS = __VIDEOS_JSON__;
var CHANNELS = __CHANNELS_JSON__;
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function slugify(title){
  var t = (title||'').normalize('NFKD').replace(/[^\x00-\x7F]/g,'').toLowerCase();
  t = t.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  if(t.length>60){var head=t.slice(0,60);var idx=head.lastIndexOf('-');var cut=idx>=0?head.slice(0,idx):head;t=(cut?cut:head.replace(/-+$/,'')).replace(/^-+|-+$/g,'');}
  return t;
}
function fmtViews(n){if(n==null)return '';if(n>=1e6)return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';if(n>=1e3)return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K';return ''+n;}
function fmtDur(s){if(s==null)return '';s=Math.round(s);var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h?h+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'):m+':'+String(x).padStart(2,'0');}
function fmtDate(ts){if(!ts)return '';var d=new Date(ts*1000);return String(d.getUTCDate()).padStart(2,'0')+'-'+MONTHS[d.getUTCMonth()]+'-'+d.getUTCFullYear();}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
var shown = 0, PAGE = 100, current = VIDEOS.slice();
var chanSel = document.getElementById('chan'), catSel = document.getElementById('cat');
CHANNELS.forEach(function(c,i){var o=document.createElement('option');o.value=i;o.textContent=c[0]+' ('+c[3]+')';chanSel.appendChild(o);});
var cats = {}; CHANNELS.forEach(function(c){cats[c[2]]=1;});
Object.keys(cats).sort().forEach(function(k){var o=document.createElement('option');o.value=k;o.textContent=k;catSel.appendChild(o);});
function rowHTML(v){
  var c = CHANNELS[v[4]];
  var url = '/watch/'+v[0]+'/'+slugify(v[1]);
  var meta = [c?esc(c[0]):'', v[3]!=null?fmtViews(v[3])+' views':'', v[2]!=null?fmtDur(v[2]):'', fmtDate(v[5])].filter(Boolean).join(' · ');
  return '<div class="row"><div class="t"><a href="'+url+'">'+esc(v[1])+'</a>'+(c?'<span class="tier t'+c[1]+'" title="'+c[1]+' tier">'+c[1]+'</span>':'')+'</div><div class="meta">'+meta+'</div></div>';
}
function render(reset){
  var list = document.getElementById('list');
  if(reset){shown=0;list.innerHTML='';}
  var end = Math.min(shown+PAGE, current.length);
  var html='';
  for(var i=shown;i<end;i++) html+=rowHTML(current[i]);
  list.insertAdjacentHTML('beforeend', html);
  shown=end;
  document.getElementById('count').textContent = current.length.toLocaleString()+' videos'+(shown<current.length?' · showing '+shown.toLocaleString():'');
  document.getElementById('more').style.display = shown<current.length?'':'none';
  if(!current.length) list.innerHTML='<div class="empty">No videos match.</div>';
}
function apply(){
  var q = document.getElementById('q').value.trim().toLowerCase();
  var ch = chanSel.value, ct = catSel.value, s = document.getElementById('sort').value;
  current = VIDEOS.filter(function(v){
    if(ch!=='' && v[4]!==+ch) return false;
    if(ct!=='' && CHANNELS[v[4]][2]!==ct) return false;
    if(q){var c=CHANNELS[v[4]];if((v[1]+' '+(c?c[0]:'')).toLowerCase().indexOf(q)<0) return false;}
    return true;
  });
  current.sort(function(a,b){
    if(s==='views') return (b[3]||0)-(a[3]||0);
    if(s==='new') return (b[5]||0)-(a[5]||0);
    if(s==='old') return (a[5]||0)-(b[5]||0);
    if(s==='title') return a[1].localeCompare(b[1]);
    if(s==='long') return (b[2]||0)-(a[2]||0);
    return 0;
  });
  render(true);
}
document.getElementById('q').addEventListener('input', apply);
document.getElementById('sort').addEventListener('change', apply);
chanSel.addEventListener('change', apply);
catSel.addEventListener('change', apply);
document.getElementById('more').addEventListener('click', function(){render(false);});
apply();
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true", help="run wrangler directly (on the box)")
    ap.add_argument("--out", default=None, help="output HTML path (default: VM staging, or the box assets dir with --local)")
    args = ap.parse_args()
    out = args.out or (OUT_BOX if args.local else OUT_VM)

    # Channels first (small), then all videos in batches.
    chans = d1_query(
        "SELECT id, name, tier, category_id FROM channels ORDER BY id",
        local=args.local,
    )
    chan_ids = {c["id"]: i for i, c in enumerate(chans)}
    # Category slug per channel id.
    cats = d1_query(
        "SELECT id, slug FROM categories",
        local=args.local,
    )
    cat_slug = {c["id"]: c["slug"] for c in cats}
    chan_cat = {}
    for c in chans:
        # channel -> category via channels.category_id
        chan_cat[c["id"]] = cat_slug.get(c.get("category_id"), "")

    # Per-channel video counts (for the filter dropdown labels).
    counts = d1_query(
        "SELECT channel_id, COUNT(*) AS n FROM videos GROUP BY channel_id",
        local=args.local,
    )
    chan_n = {r["channel_id"]: r["n"] for r in counts}

    videos = d1_all(
        "SELECT id, title, duration_s, views, channel_id, published_at "
        "FROM videos ORDER BY views DESC",
        local=args.local,
    )
    print(f"channels: {len(chans)}, videos: {len(videos)}")

    channels_json = [
        [c["name"], c["tier"], chan_cat.get(c["id"], ""), chan_n.get(c["id"], 0)]
        for c in chans
    ]
    videos_json = []
    for v in videos:
        ci = chan_ids.get(v["channel_id"])
        if ci is None:
            continue
        videos_json.append(
            [
                v["id"],
                v["title"],
                v["duration_s"],
                v["views"],
                ci,
                to_ts(v.get("published_at")),
            ]
        )

    updated = datetime.now(timezone.utc).strftime("%d-%b-%Y %H:%M UTC")
    html = (
        HTML_TEMPLATE.replace("__COUNT__", f"{len(videos_json):,}")
        .replace("__CHANS__", str(len(channels_json)))
        .replace("__UPDATED__", updated)
        .replace(
            "__VIDEOS_JSON__",
            json.dumps(videos_json, separators=(",", ":"), ensure_ascii=False).replace(
                "<", "\\u003c"
            ),
        )
        .replace(
            "__CHANNELS_JSON__",
            json.dumps(channels_json, separators=(",", ":"), ensure_ascii=False).replace(
                "<", "\\u003c"
            ),
        )
    )
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {out} ({len(html)/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
