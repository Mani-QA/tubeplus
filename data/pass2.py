#!/usr/bin/env python3
"""TubePlus pass 2: replace the 'general' fallback tag with per-channel topic tags.

Reproducible from the source JSON — run `python3 pass2.py`:
  1. Runs build.py (pass 1) to regenerate the base dataset from the source
     videos.json (keyword tags from titles, 'general' fallback).
  2. For every video whose ONLY tag is 'general', replaces it with the
     channel's topic tag(s) from CHANNEL_TOPIC_TAGS below. Topic tags are
     curated from each channel's name + blurb (+ sampled video titles for
     empty blurbs). Every topic tag reuses an existing tag name, so no new
     tags are introduced and all tag IDs stay frozen.
  3. Rewrites seed_tags.sql (identical), seed_video_tags.sql and
     enriched.json with the pass-2 tags.
  4. Writes delta.sql: the minimal change for the live D1, which already
     has the pass-1 seeds. Per-channel DELETE of the 'general' tag rows +
     INSERT OR IGNORE of the new tag rows. Idempotent: re-running it deletes
     nothing (general already gone) and ignores existing rows. It only
     touches videos whose only tag was 'general' — 'general' never co-occurs
     with a real tag in pass 1, so no video with a real tag is affected.
  5. Validates in temp SQLite DBs: full-seed load, and delta applied to a
     copy of the old-seed DB compared against the regenerated seeds.

Outputs: /home/hatch/workspace/tubeplus/data/
  channel_topic_tags.json, seed_tags.sql, seed_video_tags.sql,
  enriched.json, delta.sql
"""
import json, os, random, re, sqlite3, subprocess, sys, tempfile
from collections import Counter

OUT = "/home/hatch/workspace/tubeplus/data"
GENERAL_TAG = "general"

# channel index -> [topic tag, ...]. 1 tag normally; 2 where the channel
# clearly has two subjects (blurb names both). Only channels that have
# general-only videos are listed (152 of 156; 7 Primitive Technology,
# 17 Joshua Bird, 50 Prop Department, 135 Brick Experiment Channel have none).
# Evidence: channel name + blurb; empty blurbs resolved by sampling the
# channel's general-only video titles (see notes).
CHANNEL_TOPIC_TAGS = {
    0: ["science"],        # Applied Science: electronics/machining/chemistry/physics lab work
    1: ["clock"],          # Clickspring: clockmaking
    2: ["engineering"],    # Stuff Made Here: engineering builds
    3: ["animation"],      # Captain Disillusion: VFX debunking (closest existing tag)
    4: ["knife"],          # Kiwami Japan: knives from odd materials
    5: ["science"],        # Steve Mould: science explainers
    6: ["business"],       # S3: startups
    8: ["engineering"],    # Know Art: animated mechanism explainers
    9: ["science"],        # Breaking Taps: science/hardware/software, "like Applied Science"
    10: ["chemistry"],     # NileRed: chemistry
    11: ["light"],         # Huygens Optics: optics / lenses
    12: ["science"],       # AlphaPhoenix: experimental science apparatus
    13: ["science"],       # NightHawkInLight: original science experiments
    14: ["animation"],     # Animagraffs: detailed 3D models explaining how things work
    15: ["engineering"],   # Works By Design: engineering projects
    16: ["programming", "comedy"],  # suckerpinch: "computer science elaborate joke videos"
    18: ["machining"],     # Dan Gelbart: machine shop / prototyping
    19: ["engineering"],   # Practical Engineering: civil engineering
    20: ["engineering"],   # Real Engineering: engineering explainers
    21: ["history"],       # Historia Civilis: Roman history
    22: ["rocket"],        # BPS.space: model rockets, Falcon-style landing
    23: ["biology"],       # The Thought Emporium: biology experiments, DIY gene therapy
    24: ["biology"],       # TierZoo: animal facts (biologist)
    25: ["electronics"],   # Excessive Overkill: mechatronics, FPGA robot controllers
    26: ["science"],       # Tech Ingredients: science/engineering demos
    27: ["crash"],         # USCSB: animated industrial disasters
    28: ["3d-printing"],   # Tom Stanton: creative engineering, mostly 3D printing + drones
    29: ["electronics"],   # Sam Zeloof: home silicon IC fabrication
    30: ["animation"],     # Demoscene: 64k intros (visuals + audio)
    31: ["car"],           # Engineering Explained: cars and engines
    32: ["car"],           # SuperfastMatt: custom car projects
    33: ["war"],           # The Operations Room: animated major battles
    34: ["geography"],     # Tom Scott: interesting places around the world
    35: ["electronics"],   # Hyperspace Pirate: cryo refrigerators, coil drivers, transmitters
    36: ["car"],           # Munro Live: car teardowns, manufacturing tradeoffs
    37: ["factory"],       # BuildWitt: tours of mines and industrial sites
    38: ["minecraft"],     # cubicmetre: technical Minecraft
    39: ["geography"],     # Map Men: geography
    40: ["engineering"],   # Hacksmith Industries: real versions of fictional gadgets
    41: ["science"],       # The Action Lab: science demos
    42: ["tech"],          # Technology Connections: tech history, everyday gadgets
    43: ["geography"],     # GeoWizard: GeoGuessr / geography
    44: ["war"],           # The Intel Report: military history analysis
    45: ["machining"],     # Not An Engineer: home machine shop projects
    46: ["spacex"],        # CSI Starbase: Starbase TX / Starship program
    47: ["engine"],        # AngeTheGreat: realistic engine physics simulator
    48: ["math"],          # 3Blue1Brown: animated math
    49: ["machining"],     # Chronova Engineering: machining small machines
    51: ["engineering"],   # Joel Creates: small fun engineering videos
    52: ["machining"],     # Contraption Collection: machining series (scissors)
    53: ["tool"],          # Fireball Tool: tool making and machining
    54: ["rocket"],        # Lafayette Systems: amateur rocketry, active controls
    55: ["aviation"],      # Tucker Gott: paramotor pilot
    56: ["machining"],     # This Old Tony: machine shop videos
    57: ["animation"],     # Deconstructed: 3D model deconstruction videos
    58: ["experiment"],    # Current Concept: funny maker stunt experiments (sampled titles)
    59: ["math"],          # 2swap: animated math explainers
    60: ["lego"],          # Akiyuki Brick Channel: Lego mechanical contraptions
    61: ["speedrun"],      # SethBling: Mario speedruns, code injection
    62: ["electronics"],   # CNLohr: electronics projects
    63: ["speedrun"],      # Pannen: SM64 speedrun glitches
    64: ["car"],           # Edison Motors: electric hybrid trucks
    65: ["combat"],        # NHRL: robot combat league (sampled titles: match coverage)
    66: ["comedy"],        # William Osman 2: comedy builds (sampled titles)
    67: ["minecraft"],     # ilmango: technical Minecraft
    68: ["space", "gaming"],  # Scott Manley: space games + space explainers (sampled titles)
    69: ["combat"],        # Team Just 'Cuz Robotics: BattleBots coverage
    70: ["3d-printing"],   # Robert Cowan: Prusa 3D-printing projects (sampled titles)
    71: ["science"],       # Veritasium: science videos
    72: ["combat"],        # Jake Hoffmann: NHRL fight recaps (sampled titles)
    73: ["aviation"],      # DarkAero: building a small aircraft, carbon fiber
    74: ["factorio"],      # DoshDoshington: technical Factorio
    75: ["combat"],        # Broken Link Robotics: combat robots (sampled titles)
    76: ["engineering"],   # Mark Rober: engineering projects
    77: ["tech"],          # Asianometry: semiconductors / tech industry (sampled titles)
    78: ["light"],         # Diffraction Limited: optical instruments (sampled titles)
    79: ["music"],         # Wintergatan: Marble Machine / musical instruments
    80: ["comedy"],        # I did a thing: "Comedy DIY videos"
    81: ["electronics"],   # Failed EW Engineer: RF / radar jamming
    82: ["science"],       # xkcd's What If?: science hypotheticals
    83: ["space"],         # What about it!?: Starbase/SpaceX channel (sampled titles)
    84: ["car"],           # Matt's Off Road Recovery: offroad recovery, tow trucks
    85: ["space"],         # Everyday Astronaut: space
    86: ["blacksmith"],    # Alec Steele: blacksmithing
    87: ["science"],       # SmarterEveryDay: science videos
    88: ["lock"],          # LockPickingLawyer: lockpicking (sampled titles)
    89: ["geography"],     # Half as Interesting: geography-flavoured explainers
    90: ["tech"],          # Ben Vallack: tech / EDC / phones (sampled titles)
    91: ["3d-printing"],   # CNC Kitchen: 3D printing (sampled titles)
    92: ["aviation"],      # rctestflight: RC aircraft (sampled titles)
    93: ["chemistry"],     # NileBlue: chemistry (sampled titles)
    94: ["chemistry"],     # Reactions: chemistry explainers
    95: ["challenge"],     # Mike Shake: learn-a-skill-fast challenges (sampled titles)
    96: ["diy"],           # How To Make Everything: making things from scratch
    97: ["tech"],          # JLaservideo: gadget hacks (sampled titles)
    98: ["boat"],          # Casual Navigation: ships / maritime
    99: ["electronics"],   # bitluni: PCBs and LED walls
    100: ["diy"],          # Xyla Foxlin: maker / crafts (sampled titles)
    101: ["engineering"],  # Mustard: engineering essays (airliners, ekranoplans)
    102: ["factory"],      # Strange Parts: tours of Chinese factories
    103: ["3d-printing"],  # Roetz 4.0: 3D-printing builds (sampled titles)
    104: ["engineering"],  # colinfurze: wild engineering projects / vehicles
    105: ["geography"],    # CGP Grey: geography / politics / history explainers
    106: ["factorio"],     # DocJade: "Bobs and Angels" Factorio series (sampled titles)
    107: ["laser"],        # styropyro: lasers (sampled titles)
    108: ["robotics"],     # Simone Giertz: robots / artsy objects
    109: ["3d-printing"],  # Ivan Miranda: 3D printing (sampled title)
    110: ["aviation"],     # PeterSripol: model airplanes
    111: ["war"],          # Alexander the ok: military tech history (sampled titles)
    112: ["chemistry"],    # Advanced Tinkering: alkali metals / lab chemistry (sampled titles)
    113: ["chemistry"],    # Rowow: gold refining via electrochemistry (sampled titles)
    114: ["chemistry"],    # TheBackyardScientist: chemistry experiments (sampled titles)
    115: ["aviation"],     # Hoarder Sam: DARPA heavy lift challenge videos
    116: ["machining"],    # Cylo's Garage: super high precision machinery
    117: ["physics"],      # minutephysics: physics
    118: ["drone"],        # Luke Maximo Bell: world's fastest drones
    119: ["car"],          # Grind Hard Plumbing Co: custom vehicles / trucks
    120: ["diy"],          # DIY Perks: DIY projects
    121: ["engineering"],  # Allen Pan: engineering projects
    122: ["guitar"],       # Mattias Krantz: guitar covers (sampled titles)
    123: ["science"],      # Atomic Frontier: science explainers
    124: ["biology"],      # Real Science: biology / nature science (sampled titles)
    125: ["history"],      # Battleship New Jersey: battleship history (sampled titles)
    126: ["robotics"],     # James Bruton: 3D printed robots
    127: ["gaming"],       # Bismuth: Mario World kaizo playthroughs (sampled titles)
    128: ["rocket"],       # Integza: liquid rocket engines (channel topic; sampled titles are misc)
    129: ["comedy", "robotics"],  # Michael Reeves: "Comedy robot videos"
    130: ["robotics"],     # Carl Bugeja: actuators / robotics (sampled titles)
    131: ["aviation"],     # Think Flight: aviation futures (sampled titles)
    132: ["cooking"],      # You Suck At Cooking: comedy cooking, actual recipes
    133: ["programming"],  # Jonathan Blow: live programming / game dev
    134: ["ai"],           # Two Minute Papers: ML / computer graphics papers
    136: ["chemistry"],    # Cody'sLab: chemistry-heavy science (sampled titles)
    137: ["woodworking"],  # Matthias Wandel: woodworking
    138: ["metalwork"],    # Makercise: aluminum casting, Gingery lathe/shaper
    139: ["programming"],  # Strange Loop: programming conference talks
    140: ["science"],      # Bruce Yeany: science demos
    141: ["lego"],         # The Brick Wall: Lego farm equipment / factories
    142: ["tool"],         # AvE: tool teardowns / reviews
    143: ["science"],      # Keystone Science: science videos
    144: ["programming"],  # Ferris: programmer, demo group Logicoma
    145: ["cooking"],      # The Taste Emporium: fancy recipes
    146: ["art"],          # EvanAndKatelyn: resin crafts / art (sampled titles)
    147: ["3d-printing"],  # JAIRUS OF ALL: 3D-printed cosplay props (sampled titles)
    148: ["math", "programming"],  # Inigo Quilez: math + shader coding (sampled titles)
    149: ["camera"],       # Daniel Schiffer: videography / commercials
    150: ["programming"],  # Makin' Stuff Look Good: shader effect tutorials
    151: ["minecraft"],    # JL2579: technical Minecraft
    152: ["animation"],    # Roger Kilmanjaro: CG looping animations
    153: ["blender"],      # Blender Guru: Blender 3D modeling tutorials
    154: ["diy"],          # I Like To Make Stuff: miscellaneous crafts
    155: ["build"],        # Joseph's Machines: Rube Goldberg machines
}


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("\r", " ").replace("\n", " ").replace("'", "''") + "'"


def chunked_insert(path, header, rows, chunk=500):
    with open(path, "w") as f:
        for i in range(0, len(rows), chunk):
            part = rows[i:i + chunk]
            f.write(header + ",\n".join(part) + ";\n")


def parse_tags_sql(path):
    """Return {name: id} from a seed_tags.sql file."""
    txt = open(path).read()
    return {name: int(i) for i, name in re.findall(r"\((\d+),\s*'([^']+)'\)", txt)}


def load_db(paths):
    """Load schema + seed files into a temp SQLite DB, return connection."""
    con = sqlite3.connect(":memory:")
    cur = con.cursor()
    for p in paths:
        cur.executescript(open(p).read())
    con.commit()
    return con


def main():
    # 1. Regenerate pass-1 outputs from the source JSON.
    print("=== running build.py (pass 1) ===")
    subprocess.run([sys.executable, os.path.join(OUT, "build.py")], check=True)

    # 2. Frozen tag IDs from the (just regenerated) seed_tags.sql.
    tag_id = parse_tags_sql(os.path.join(OUT, "seed_tags.sql"))
    assert len(tag_id) == 120, f"expected 120 tags, got {len(tag_id)}"
    assert GENERAL_TAG in tag_id, "general tag missing"
    general_id = tag_id[GENERAL_TAG]
    missing = {t for tags in CHANNEL_TOPIC_TAGS.values() for t in tags} - set(tag_id)
    assert not missing, f"topic tags not in tag set: {missing}"
    print(f"tag ids frozen: 120 tags, general={general_id}, new tags introduced: 0")

    # 3. Load enriched.json and apply the pass.
    with open(os.path.join(OUT, "enriched.json")) as f:
        data = json.load(f)
    channels, videos = data["channels"], data["videos"]
    assert len(videos) == 47339
    affected = []  # (video_id, channel, old_tags, new_tags)
    per_channel = Counter()
    for v in videos:
        if v["tags"] == [GENERAL_TAG]:
            topic = CHANNEL_TOPIC_TAGS.get(v["channel"])
            assert topic, f"channel {v['channel']} has general-only videos but no topic tag"
            v["tags"] = list(topic)
            affected.append((v["id"], v["channel"], ["general"], list(topic)))
            per_channel[v["channel"]] += 1
    remaining = sum(1 for v in videos if v["tags"] == [GENERAL_TAG])
    print(f"videos fixed: {len(affected)} | still only 'general': {remaining}")

    # 4. Write channel_topic_tags.json.
    with open(os.path.join(OUT, "channel_topic_tags.json"), "w") as f:
        json.dump({str(i): CHANNEL_TOPIC_TAGS[i] for i in sorted(CHANNEL_TOPIC_TAGS)}, f, indent=2)

    # 5. Rewrite seed_tags.sql (identical content, from the frozen mapping).
    rows = [f"({tag_id[t]}, {sql_str(t)})" for t in sorted(tag_id, key=lambda t: tag_id[t])]
    chunked_insert(os.path.join(OUT, "seed_tags.sql"),
                   "INSERT INTO tags (id, name) VALUES\n", rows)

    # 6. Rewrite seed_video_tags.sql from the updated videos.
    rows = []
    for v in videos:
        for t in v["tags"]:
            rows.append(f"({sql_str(v['id'])}, {tag_id[t]})")
    chunked_insert(os.path.join(OUT, "seed_video_tags.sql"),
                   "INSERT INTO video_tags (video_id, tag_id) VALUES\n", rows)
    print(f"seed_video_tags.sql rows: {len(rows)}")

    # 7. Rewrite enriched.json.
    with open(os.path.join(OUT, "enriched.json"), "w") as f:
        json.dump(data, f)

    # 8. delta.sql — minimal change for the live D1 (pass-1 seeds already applied).
    # Snapshot the OLD seed_video_tags.sql first (it is still the pass-1 version
    # on disk? No — step 6 already overwrote it. So delta is built from the
    # `affected` list computed in step 3, which is exactly the diff.)
    delta_lines = [
        "-- TubePlus pass 2 delta — apply to the live D1 (pass-1 seeds already loaded).",
        "-- For each channel: delete the 'general' tag rows of its general-only",
        "-- videos, then insert the channel topic tag(s). Idempotent: re-running",
        "-- deletes nothing (general already gone) and INSERT OR IGNORE skips",
        "-- rows that exist. Videos with a real tag are never touched: 'general'",
        "-- never co-occurs with another tag in pass 1.",
        "",
    ]
    n_delete = n_insert_stmts = n_insert_rows = 0
    for ch in sorted(per_channel):
        name = channels[ch]["name"]
        topic = CHANNEL_TOPIC_TAGS[ch]
        n = per_channel[ch]
        delta_lines.append(f"-- {ch} {name}: {n} videos, general -> {', '.join(topic)}")
        delta_lines.append(
            f"DELETE FROM video_tags WHERE tag_id = {general_id} "
            f"AND video_id IN (SELECT id FROM videos WHERE channel_id = {ch});")
        n_delete += 1
        ins_rows = []
        for vid, vch, _, new_tags in affected:
            if vch != ch:
                continue
            for t in new_tags:
                ins_rows.append(f"({sql_str(vid)}, {tag_id[t]})")
        for i in range(0, len(ins_rows), 500):
            part = ins_rows[i:i + 500]
            delta_lines.append(
                "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES\n"
                + ",\n".join(part) + ";")
            n_insert_stmts += 1
        n_insert_rows += len(ins_rows)
        delta_lines.append("")
    with open(os.path.join(OUT, "delta.sql"), "w") as f:
        f.write("\n".join(delta_lines))
    print(f"delta.sql: {n_delete} DELETEs, {n_insert_stmts} INSERT statements, "
          f"{n_insert_rows} inserted rows, "
          f"{os.path.getsize(os.path.join(OUT, 'delta.sql')):,} bytes")

    # 9. Validation A: load the updated seeds into a temp DB.
    print("=== validation A: updated seeds ===")
    con = load_db([os.path.join(OUT, p) for p in
                   ["schema.sql", "seed_categories.sql", "seed_channels.sql",
                    "seed_videos.sql", "seed_tags.sql", "seed_video_tags.sql"]])
    cur = con.cursor()
    for t in ["categories", "channels", "videos", "tags", "video_tags"]:
        print(f"  {t}: {cur.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
    print("  videos with 0 tags:",
          cur.execute("SELECT COUNT(*) FROM videos v WHERE NOT EXISTS "
                      "(SELECT 1 FROM video_tags t WHERE t.video_id = v.id)").fetchone()[0])
    print("  videos with only 'general':",
          cur.execute("SELECT COUNT(*) FROM videos v WHERE EXISTS "
                      "(SELECT 1 FROM video_tags t WHERE t.video_id = v.id AND t.tag_id = ?) "
                      "AND NOT EXISTS (SELECT 1 FROM video_tags t WHERE t.video_id = v.id "
                      "AND t.tag_id <> ?)", (general_id, general_id)).fetchone()[0])
    print("  'general' tag rows remaining:",
          cur.execute("SELECT COUNT(*) FROM video_tags WHERE tag_id = ?", (general_id,)).fetchone()[0])
    print("  FK violations:", cur.execute("PRAGMA foreign_key_check").fetchall())
    print("  videos with 'general' + another tag (must be 0):",
          cur.execute("SELECT COUNT(*) FROM videos v WHERE EXISTS "
                      "(SELECT 1 FROM video_tags t WHERE t.video_id = v.id AND t.tag_id = ?) "
                      "AND EXISTS (SELECT 1 FROM video_tags t WHERE t.video_id = v.id "
                      "AND t.tag_id <> ?)", (general_id, general_id)).fetchone()[0])
    tc = Counter()
    for (tid, n) in cur.execute("SELECT tag_id, COUNT(*) FROM video_tags GROUP BY tag_id"):
        tc[tid] = n
    inv = {i: t for t, i in tag_id.items()}
    print("  top tags after pass 2:")
    for tid, n in sorted(tc.items(), key=lambda kv: -kv[1])[:8]:
        print(f"    {inv[tid]:15s} {n:>6}")
    new_state = {vid: tuple(sorted(int(x) for x in s.split(",")))
                 for vid, s in cur.execute(
                     "SELECT video_id, GROUP_CONCAT(tag_id) FROM video_tags GROUP BY video_id")}
    con.close()

    # 10. Validation B: delta applied to a copy of the OLD (pass-1) seeds must
    # equal the regenerated seeds. Rebuild the old DB from the pass-1 tag
    # assignment: re-run the pass-1 keyword logic is overkill — instead, take
    # the NEW db state and reverse it: old = new with topic rows removed and
    # general restored for affected videos. That is exactly what the live D1
    # holds, and applying delta.sql to it must reproduce `new_state`.
    print("=== validation B: delta.sql on old-seed state ===")
    con = load_db([os.path.join(OUT, p) for p in
                   ["schema.sql", "seed_categories.sql", "seed_channels.sql",
                    "seed_videos.sql", "seed_tags.sql", "seed_video_tags.sql"]])
    cur = con.cursor()
    # reverse pass 2 -> reconstruct pass-1 state
    for vid, ch, _, new_tags in affected:
        for t in new_tags:
            cur.execute("DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?",
                        (vid, tag_id[t]))
        cur.execute("INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)",
                    (vid, general_id))
    con.commit()
    old_count = cur.execute("SELECT COUNT(*) FROM video_tags").fetchone()[0]
    print(f"  reconstructed old video_tags rows: {old_count} (expect 71763)")
    # apply delta.sql
    cur.executescript(open(os.path.join(OUT, "delta.sql")).read())
    con.commit()
    after_count = cur.execute("SELECT COUNT(*) FROM video_tags").fetchone()[0]
    print(f"  after delta video_tags rows: {after_count} (expect {len(rows)})")
    after_state = {vid: tuple(sorted(int(x) for x in s.split(",")))
                   for vid, s in cur.execute(
                       "SELECT video_id, GROUP_CONCAT(tag_id) FROM video_tags GROUP BY video_id")}
    diff = [vid for vid in set(new_state) | set(after_state)
            if new_state.get(vid) != after_state.get(vid)]
    print(f"  per-video tag diffs (old+delta vs regenerated): {len(diff)} {diff[:5]}")
    print("  FK violations after delta:", cur.execute("PRAGMA foreign_key_check").fetchall())
    con.close()

    # 11. Spot-check 10 random previously-general videos.
    print("=== spot-check 10 random previously-general videos ===")
    random.seed(42)
    by_id = {v["id"]: v for v in videos}
    for vid, ch, _, new_tags in random.sample(affected, 10):
        v = by_id[vid]
        print(f"  [{v['category']}] {v['title'][:85]} | {channels[ch]['name']} | tags={','.join(new_tags)}")

    print("=== files ===")
    for fn in ["channel_topic_tags.json", "seed_tags.sql", "seed_video_tags.sql",
               "enriched.json", "delta.sql"]:
        p = os.path.join(OUT, fn)
        print(f"  {fn}: {os.path.getsize(p):,} bytes")


if __name__ == "__main__":
    main()
