#!/usr/bin/env python3
"""Build the TubePlus enriched dataset from the Tristan Tube videos.json.

Inputs : /home/hatch/workspace/your_files/tristan-tube-videos.json (read-only)
Outputs: /home/hatch/workspace/tubeplus/data/
  channel_categories.json, schema.sql, seed_categories.sql, seed_channels.sql,
  seed_videos.sql, seed_tags.sql, seed_video_tags.sql, enriched.json

Category assignment: one primary category per channel, decided from the
channel name + blurb (+ sampled video titles for empty blurbs).
Tags: keyword->tag map matched against video titles (case-insensitive,
word-boundary aware via token padding). 1-5 tags per video, else "general".
"""
import json, os, random, re, sqlite3, unicodedata
from collections import Counter

SRC = "/home/hatch/workspace/your_files/tristan-tube-videos.json"
OUT = "/home/hatch/workspace/tubeplus/data"
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- categories
CATEGORIES = [
    ("science", "Science"),
    ("engineering", "Engineering"),
    ("making", "Making & Craft"),
    ("space", "Space & Rockets"),
    ("tech", "Tech & Computing"),
    ("history", "History & Geography"),
    ("gaming", "Gaming"),
    ("vehicles", "Vehicles"),
    ("food", "Food & Cooking"),
    ("music", "Music & Art"),
    ("aviation", "Aviation & Flight"),
    ("outdoors", "Outdoors & Survival"),
    ("entertainment", "Entertainment"),
]
CAT_ID = {slug: i + 1 for i, (slug, _) in enumerate(CATEGORIES)}

# channel index -> category slug. Decided from name + blurb; empty blurbs were
# resolved by sampling the channel's video titles. Ambiguous ones noted in the
# final report (see AMBIGUOUS below).
CHANNEL_CATEGORY = {
    0: "science", 1: "making", 2: "engineering", 3: "entertainment", 4: "making",
    5: "science", 6: "tech", 7: "outdoors", 8: "engineering", 9: "science",
    10: "science", 11: "science", 12: "science", 13: "science", 14: "engineering",
    15: "engineering", 16: "tech", 17: "engineering", 18: "engineering", 19: "engineering",
    20: "engineering", 21: "history", 22: "space", 23: "science", 24: "science",
    25: "engineering", 26: "science", 27: "engineering", 28: "engineering", 29: "tech",
    30: "tech", 31: "vehicles", 32: "vehicles", 33: "history", 34: "history",
    35: "science", 36: "vehicles", 37: "engineering", 38: "gaming", 39: "history",
    40: "engineering", 41: "science", 42: "tech", 43: "history", 44: "history",
    45: "making", 46: "space", 47: "tech", 48: "science", 49: "making",
    50: "vehicles", 51: "engineering", 52: "making", 53: "making", 54: "space",
    55: "aviation", 56: "making", 57: "engineering", 58: "making", 59: "science",
    60: "making", 61: "gaming", 62: "tech", 63: "gaming", 64: "vehicles",
    65: "entertainment", 66: "making", 67: "gaming", 68: "space", 69: "entertainment",
    70: "making", 71: "science", 72: "entertainment", 73: "aviation", 74: "gaming",
    75: "making", 76: "engineering", 77: "tech", 78: "science", 79: "music",
    80: "making", 81: "tech", 82: "science", 83: "space", 84: "vehicles",
    85: "space", 86: "making", 87: "science", 88: "making", 89: "history",
    90: "tech", 91: "making", 92: "aviation", 93: "science", 94: "science",
    95: "science", 96: "making", 97: "making", 98: "vehicles", 99: "tech",
    100: "making", 101: "engineering", 102: "tech", 103: "making", 104: "engineering",
    105: "history", 106: "gaming", 107: "science", 108: "making", 109: "making",
    110: "aviation", 111: "history", 112: "science", 113: "making", 114: "science",
    115: "aviation", 116: "making", 117: "science", 118: "aviation", 119: "vehicles",
    120: "making", 121: "engineering", 122: "music", 123: "science", 124: "science",
    125: "history", 126: "engineering", 127: "gaming", 128: "space", 129: "entertainment",
    130: "engineering", 131: "aviation", 132: "food", 133: "tech", 134: "tech",
    135: "making", 136: "science", 137: "making", 138: "making", 139: "tech",
    140: "science", 141: "making", 142: "making", 143: "science", 144: "tech",
    145: "food", 146: "making", 147: "making", 148: "tech", 149: "entertainment",
    150: "tech", 151: "gaming", 152: "music", 153: "tech", 154: "making",
    155: "making",
}
AMBIGUOUS = {
    0: "Applied Science: science vs engineering (blurb says both; science demos win)",
    3: "Captain Disillusion: entertainment (VFX debunking, not tech)",
    26: "Tech Ingredients: science vs engineering (science demos win)",
    47: "AngeTheGreat: tech (engine physics simulator = software)",
    65: "NHRL: entertainment (robot combat league, fight coverage)",
    66: "William Osman 2: making (comedy builds)",
    69: "Team Just 'Cuz Robotics: entertainment (fight coverage, though they build the bots)",
    72: "Jake Hoffmann: entertainment (NHRL fight coverage + one guide)",
    75: "Broken Link Robotics: making vs entertainment (titles stress building)",
    79: "Wintergatan: music vs making (Marble Machine is a musical instrument)",
    88: "LockPickingLawyer: making (lockpicking as hands-on craft)",
    90: "Ben Vallack: tech vs making (PCB/keyboard electronics win)",
    98: "Casual Navigation: vehicles (maritime explainers; ships are vehicles)",
    101: "Mustard: engineering vs history (transport engineering essays)",
    103: "Roetz 4.0: making vs tech (3D-printing builds win)",
    111: "Alexander the ok: history (military/nuclear tech history)",
    113: "Rowow: making vs engineering (workshop gold-refining projects win)",
    118: "Luke Maximo Bell: aviation (drones, though titles are mixed)",
    122: "Mattias Krantz: music (guitar covers)",
    128: "Integza: space vs engineering (liquid rocket engine focus)",
    136: "Cody'sLab: science (geology/farming/engineering mix)",
    149: "Daniel Schiffer: entertainment (videography/commercials)",
    152: "Roger Kilmanjaro: music (CG looping animations as art)",
}

# ---------------------------------------------------------------- tags
# (keyword, tag) in priority order: specific first, generic last.
# Matching is case-insensitive and word-boundary aware (see norm()).
KEYWORDS = [
    ("spacex", "spacex"), ("starship", "starship"), ("falcon", "spacex"),
    ("mars", "mars"), ("moon", "moon"), ("lunar", "moon"),
    ("satellite", "satellite"), ("satellites", "satellite"),
    ("nasa", "nasa"), ("rocket", "rocket"), ("rockets", "rocket"),
    ("telescope", "telescope"), ("microscope", "microscope"),
    ("3d print", "3d-printing"), ("3d printed", "3d-printing"),
    ("3d printing", "3d-printing"), ("3d printer", "3d-printing"), ("3d printers", "3d-printing"),
    ("laser", "laser"), ("lasers", "laser"), ("cnc", "cnc"),
    ("machining", "machining"), ("machinist", "machining"), ("lathe", "machining"),
    ("milling", "machining"), ("mill", "machining"),
    ("welding", "welding"), ("weld", "welding"), ("welder", "welding"),
    ("woodworking", "woodworking"), ("wood", "woodworking"), ("wooden", "woodworking"), ("carpentry", "woodworking"),
    ("blacksmith", "blacksmith"), ("forge", "blacksmith"), ("forging", "blacksmith"),
    ("metal", "metalwork"), ("casting", "metalwork"), ("cast", "metalwork"),
    ("steel", "metalwork"), ("aluminum", "metalwork"), ("aluminium", "metalwork"), ("copper", "metalwork"),
    ("knife", "knife"), ("knives", "knife"),
    ("sword", "sword"), ("swords", "sword"), ("katana", "sword"), ("saber", "sword"), ("sabre", "sword"),
    ("clock", "clock"), ("clockmaking", "clock"),
    ("lego", "lego"),
    ("raspberry pi", "raspberry-pi"), ("raspberry", "raspberry-pi"),
    ("arduino", "arduino"), ("esp32", "electronics"),
    ("python", "python"), ("javascript", "javascript"), ("c++", "cpp"), ("rust", "rust"),
    ("minecraft", "minecraft"), ("factorio", "factorio"),
    ("blender", "blender"),
    ("pcb", "electronics"), ("pcbs", "electronics"),
    ("microcontroller", "electronics"), ("fpga", "electronics"),
    ("electronics", "electronics"), ("electronic", "electronics"),
    ("circuit", "electronics"), ("circuits", "electronics"),
    ("soldering", "electronics"), ("solder", "electronics"),
    ("sensor", "electronics"), ("sensors", "electronics"),
    ("black hole", "astronomy"), ("astronomy", "astronomy"), ("astronomer", "astronomy"),
    ("galaxy", "astronomy"), ("universe", "astronomy"), ("nebula", "astronomy"),
    ("quantum", "quantum"),
    ("nuclear", "nuclear"), ("radiation", "nuclear"), ("radioactive", "nuclear"),
    ("uranium", "nuclear"), ("reactor", "nuclear"),
    ("physics", "physics"), ("physicist", "physics"),
    ("chemistry", "chemistry"), ("chemical", "chemistry"),
    ("math", "math"), ("mathematics", "math"), ("maths", "math"),
    ("biology", "biology"), ("biologist", "biology"), ("bacteria", "biology"),
    ("virus", "biology"), ("dna", "biology"), ("evolution", "biology"),
    ("animal", "biology"), ("animals", "biology"),
    ("geology", "geology"), ("volcano", "geology"), ("earthquake", "geology"),
    ("fossil", "geology"), ("rock", "geology"),
    ("weather", "weather"), ("storm", "weather"), ("rain", "weather"),
    ("snow", "weather"), ("tornado", "weather"), ("hurricane", "weather"),
    ("vacuum", "vacuum"), ("pressure", "pressure"), ("gravity", "gravity"),
    ("electricity", "electricity"), ("electric", "electricity"), ("voltage", "electricity"),
    ("magnet", "magnet"), ("magnetic", "magnet"), ("magnets", "magnet"),
    ("sound", "sound"), ("audio", "sound"), ("acoustic", "sound"),
    ("light", "light"), ("optics", "light"), ("optical", "light"), ("prism", "light"),
    ("water", "water"), ("fluid", "water"), ("hydro", "water"),
    ("fire", "fire"), ("flame", "fire"), ("flames", "fire"),
    ("ice", "ice"), ("frozen", "ice"), ("freeze", "ice"),
    ("energy", "energy"), ("solar", "solar"), ("battery", "battery"), ("batteries", "battery"),
    ("airplane", "aviation"), ("aircraft", "aviation"), ("plane", "aviation"), ("planes", "aviation"),
    ("jet", "aviation"), ("fighter", "aviation"), ("bomber", "aviation"),
    ("helicopter", "aviation"), ("glider", "aviation"), ("paramotor", "aviation"),
    ("paraglider", "aviation"), ("balloon", "aviation"), ("flight", "aviation"), ("flying", "aviation"),
    ("car", "car"), ("cars", "car"), ("truck", "car"), ("trucks", "car"),
    ("jeep", "car"), ("vehicle", "car"), ("vehicles", "car"), ("automobile", "car"), ("tesla", "car"),
    ("engine", "engine"), ("motor", "engine"), ("v8", "engine"), ("turbo", "engine"),
    ("diesel", "engine"), ("piston", "engine"), ("turbine", "engine"),
    ("boat", "boat"), ("ship", "boat"), ("ships", "boat"), ("submarine", "boat"),
    ("yacht", "boat"), ("cruise", "boat"), ("sailing", "boat"), ("kayak", "boat"), ("canoe", "boat"),
    ("train", "train"), ("trains", "train"), ("railway", "train"), ("locomotive", "train"),
    ("bike", "bike"), ("bicycle", "bike"), ("motorcycle", "bike"), ("bikes", "bike"), ("scooter", "bike"),
    ("tank", "tank"), ("tanks", "tank"),
    ("bridge", "bridge"), ("bridges", "bridge"), ("dam", "dam"), ("dams", "dam"),
    ("tunnel", "tunnel"), ("tunnels", "tunnel"), ("tower", "tower"), ("towers", "tower"),
    ("skyscraper", "tower"),
    ("gun", "weapons"), ("guns", "weapons"), ("rifle", "weapons"), ("pistol", "weapons"),
    ("cannon", "weapons"), ("missile", "weapons"), ("bomb", "weapons"), ("bombs", "weapons"),
    ("firearm", "weapons"),
    ("lock", "lock"), ("locks", "lock"),
    ("tool", "tool"), ("tools", "tool"),
    ("workshop", "workshop"), ("garage", "workshop"),
    ("factory", "factory"), ("manufacturing", "factory"), ("industrial", "factory"), ("mining", "factory"),
    ("history", "history"), ("historical", "history"),
    ("roman", "history"), ("rome", "history"), ("ancient", "history"),
    ("medieval", "history"), ("viking", "history"),
    ("war", "war"), ("wars", "war"), ("battle", "war"), ("battles", "war"),
    ("army", "war"), ("military", "war"), ("soldier", "war"), ("ww2", "war"), ("wwii", "war"),
    ("geography", "geography"), ("map", "geography"), ("maps", "geography"),
    ("country", "geography"), ("border", "geography"), ("geoguessr", "geography"),
    ("politics", "politics"), ("election", "politics"), ("president", "politics"), ("government", "politics"),
    ("business", "business"), ("startup", "business"), ("startups", "business"), ("money", "business"),
    ("cooking", "cooking"), ("cook", "cooking"), ("recipe", "cooking"), ("food", "cooking"),
    ("kitchen", "cooking"), ("bread", "cooking"), ("chocolate", "cooking"), ("cheese", "cooking"),
    ("bbq", "cooking"), ("grill", "cooking"), ("baking", "cooking"), ("bake", "cooking"),
    ("survival", "survival"), ("wilderness", "survival"), ("camping", "survival"),
    ("shelter", "survival"), ("bushcraft", "survival"), ("hike", "survival"), ("hiking", "survival"),
    ("farming", "farming"), ("farm", "farming"), ("garden", "farming"), ("bees", "farming"),
    ("beekeeping", "farming"), ("chicken", "farming"), ("bee", "farming"),
    ("fishing", "fishing"), ("fish", "fishing"), ("hunting", "hunting"),
    ("guitar", "guitar"), ("guitars", "guitar"), ("piano", "piano"),
    ("music", "music"), ("musical", "music"), ("song", "music"), ("songs", "music"),
    ("singing", "music"), ("band", "music"), ("synth", "music"), ("drum", "music"), ("drums", "music"),
    ("art", "art"), ("painting", "art"), ("drawing", "art"), ("sculpture", "art"),
    ("comedy", "comedy"), ("funny", "comedy"), ("joke", "comedy"), ("jokes", "comedy"), ("prank", "comedy"),
    ("magic", "magic"), ("trick", "magic"), ("tricks", "magic"), ("illusion", "magic"),
    ("sport", "sport"), ("football", "sport"), ("soccer", "sport"), ("basketball", "sport"),
    ("race", "sport"), ("racing", "sport"), ("olympic", "sport"), ("olympics", "sport"),
    ("camera", "camera"), ("lens", "camera"), ("photo", "camera"), ("photography", "camera"),
    ("speedrun", "speedrun"), ("speedruns", "speedrun"),
    ("glitch", "glitch"), ("glitches", "glitch"),
    ("mario", "gaming"), ("zelda", "gaming"), ("pokemon", "gaming"),
    ("gaming", "gaming"), ("game", "gaming"), ("games", "gaming"), ("gamer", "gaming"),
    ("robot", "robotics"), ("robots", "robotics"), ("robotic", "robotics"), ("robotics", "robotics"),
    ("servo", "robotics"), ("servos", "robotics"),
    ("drone", "drone"), ("drones", "drone"), ("fpv", "drone"), ("quadcopter", "drone"),
    ("model", "modeling"), ("models", "modeling"), ("modeling", "modeling"), ("modelling", "modeling"),
    ("animation", "animation"), ("animated", "animation"), ("cgi", "animation"),
    ("programming", "programming"), ("programmer", "programming"), ("code", "programming"),
    ("coding", "programming"), ("software", "programming"), ("algorithm", "programming"), ("compiler", "programming"),
    ("computer", "computer"), ("computers", "computer"), ("pc", "computer"), ("laptop", "computer"),
    ("cpu", "computer"), ("gpu", "computer"), ("keyboard", "computer"), ("keyboards", "computer"),
    ("iphone", "computer"), ("samsung", "computer"), ("apple", "computer"),
    ("linux", "computer"), ("server", "computer"), ("servers", "computer"),
    ("ai", "ai"), ("artificial intelligence", "ai"), ("machine learning", "ai"),
    ("neural", "ai"), ("llm", "ai"), ("gpt", "ai"), ("chatgpt", "ai"), ("deep learning", "ai"),
    ("space", "space"), ("orbit", "space"), ("orbital", "space"),
    ("astronaut", "space"), ("astronauts", "space"), ("planet", "space"), ("planets", "space"), ("cosmos", "space"),
    ("diy", "diy"),
    ("build", "build"), ("built", "build"), ("building", "build"), ("builds", "build"), ("rebuild", "build"),
    ("tutorial", "tutorial"), ("how to", "tutorial"), ("guide", "tutorial"),
    ("explained", "tutorial"), ("explains", "tutorial"), ("explanation", "tutorial"),
    ("experiment", "experiment"), ("experiments", "experiment"), ("experimental", "experiment"),
    ("test", "experiment"), ("tested", "experiment"), ("testing", "experiment"),
    ("review", "review"), ("reviews", "review"), ("teardown", "review"), ("unboxing", "review"),
    ("comparison", "review"), ("vs", "review"), ("versus", "review"),
    ("challenge", "challenge"), ("challenges", "challenge"), ("impossible", "challenge"),
    ("world record", "challenge"), ("fastest", "challenge"), ("biggest", "challenge"),
    ("largest", "challenge"), ("smallest", "challenge"), ("longest", "challenge"),
    ("shortest", "challenge"), ("tallest", "challenge"), ("strongest", "challenge"),
    ("documentary", "documentary"),
    ("interview", "interview"), ("interviews", "interview"),
    ("timelapse", "timelapse"), ("time lapse", "timelapse"),
    ("slow motion", "slow-motion"), ("slow-mo", "slow-motion"), ("slowmo", "slow-motion"),
    ("explosion", "explosion"), ("explosions", "explosion"), ("explode", "explosion"), ("exploding", "explosion"),
    ("crash", "crash"), ("crashes", "crash"), ("disaster", "crash"), ("disasters", "crash"),
    ("fail", "crash"), ("fails", "crash"),
]

# Batch 2: added after measuring pass 1 — the most common tokens in titles
# that still fell back to "general" (channel-specific vocab, shop terms,
# food/science words, content types). Specific first, generic last.
KEYWORDS_EXTRA = [
    ("battleship", "history"),
    ("padlock", "lock"), ("padlocks", "lock"), ("picked", "lock"), ("picking", "lock"),
    ("gutted", "lock"), ("cylinder", "lock"),
    ("demoscene", "animation"), ("64k", "animation"), ("demo", "animation"),
    ("marble", "music"),
    ("mindcrack", "minecraft"), ("scicraft", "minecraft"), ("hardcore", "gaming"),
    ("boltr", "review"),
    ("combat", "combat"), ("fight", "combat"), ("fighting", "combat"),
    ("iron", "metalwork"), ("gold", "metalwork"), ("silver", "metalwork"),
    ("titanium", "metalwork"), ("brass", "metalwork"), ("bronze", "metalwork"),
    ("furnace", "metalwork"), ("foundry", "metalwork"), ("anvil", "blacksmith"),
    ("hammer", "tool"), ("drill", "tool"), ("drills", "tool"), ("screwdriver", "tool"),
    ("wrench", "tool"), ("pliers", "tool"), ("chisel", "tool"), ("clamp", "tool"),
    ("vise", "tool"), ("grinder", "tool"), ("sander", "tool"), ("bandsaw", "tool"),
    ("tablesaw", "tool"), ("chainsaw", "tool"), ("dremel", "tool"),
    ("multimeter", "electronics"), ("oscilloscope", "electronics"),
    ("antenna", "electronics"), ("antennas", "electronics"), ("radio", "electronics"),
    ("radar", "electronics"), ("gps", "electronics"), ("bluetooth", "electronics"),
    ("wifi", "electronics"), ("usb", "electronics"), ("charger", "electronics"),
    ("capacitor", "electronics"), ("resistor", "electronics"), ("transistor", "electronics"),
    ("diode", "electronics"), ("cable", "electronics"), ("cables", "electronics"),
    ("wire", "electronics"),
    ("bulb", "light"), ("lamp", "light"), ("flashlight", "light"), ("candle", "light"),
    ("glow", "light"), ("neon", "light"), ("uv", "light"), ("infrared", "light"), ("x ray", "light"),
    ("gamma", "nuclear"), ("proton", "nuclear"), ("neutron", "nuclear"),
    ("atom", "nuclear"), ("atomic", "nuclear"),
    ("electron", "electricity"), ("electrons", "electricity"),
    ("molecule", "chemistry"), ("molecules", "chemistry"), ("acid", "chemistry"),
    ("salt", "chemistry"), ("polymer", "chemistry"),
    ("enzyme", "biology"), ("gene", "biology"), ("genes", "biology"),
    ("genetic", "biology"), ("genetics", "biology"), ("protein", "biology"),
    ("brain", "biology"), ("heart", "biology"), ("blood", "biology"),
    ("bone", "biology"), ("bones", "biology"), ("muscle", "biology"),
    ("skin", "biology"), ("eye", "biology"), ("human", "biology"), ("humans", "biology"),
    ("dog", "biology"), ("dogs", "biology"), ("cat", "biology"), ("cats", "biology"),
    ("bird", "biology"), ("birds", "biology"), ("snake", "biology"), ("spider", "biology"),
    ("insect", "biology"), ("insects", "biology"), ("ant", "biology"), ("ants", "biology"),
    ("coral", "biology"),
    ("tree", "farming"), ("trees", "farming"), ("plant", "farming"), ("plants", "farming"),
    ("flower", "farming"), ("flowers", "farming"), ("seed", "farming"), ("seeds", "farming"),
    ("soil", "farming"), ("harvest", "farming"), ("crop", "farming"), ("crops", "farming"),
    ("wheat", "farming"), ("corn", "farming"),
    ("potato", "cooking"), ("tomato", "cooking"), ("onion", "cooking"), ("garlic", "cooking"),
    ("pepper", "cooking"), ("sugar", "cooking"), ("honey", "cooking"), ("milk", "cooking"),
    ("egg", "cooking"), ("eggs", "cooking"), ("meat", "cooking"), ("beef", "cooking"),
    ("pork", "cooking"), ("pizza", "cooking"), ("burger", "cooking"), ("sandwich", "cooking"),
    ("pasta", "cooking"), ("cake", "cooking"), ("cookie", "cooking"), ("cookies", "cooking"),
    ("ice cream", "cooking"), ("coffee", "cooking"), ("tea", "cooking"), ("beer", "cooking"),
    ("wine", "cooking"), ("whiskey", "cooking"), ("whisky", "cooking"), ("cocktail", "cooking"),
    ("smoker", "cooking"), ("oven", "cooking"), ("stove", "cooking"), ("fridge", "cooking"),
    ("refrigerator", "cooking"), ("freezer", "cooking"),
    ("ocean", "water"), ("sea", "water"), ("river", "water"), ("lake", "water"),
    ("island", "geography"), ("mountain", "geography"), ("mountains", "geography"),
    ("desert", "geography"), ("forest", "geography"), ("jungle", "geography"),
    ("cave", "geology"), ("caves", "geology"), ("crystal", "geology"),
    ("crystals", "geology"), ("diamond", "geology"),
    ("sail", "boat"), ("anchor", "boat"),
    ("pottery", "art"),
    ("science", "science"),
    ("tour", "tour"), ("tours", "tour"),
    ("power", "energy"), ("wind", "energy"),
    ("steam", "engine"), ("valve", "engine"),
    ("tire", "car"), ("tires", "car"), ("tyre", "car"), ("tyres", "car"),
    ("brake", "car"), ("brakes", "car"), ("suspension", "car"), ("exhaust", "car"),
    ("transmission", "car"), ("steering", "car"), ("drift", "car"), ("drifting", "car"),
    ("offroad", "car"), ("off-road", "car"), ("4x4", "car"), ("road", "car"),
    ("shark", "fishing"),
    ("print", "3d-printing"), ("printed", "3d-printing"), ("printing", "3d-printing"),
    ("printer", "3d-printing"),
    ("impressions", "review"), ("first look", "review"), ("hands on", "review"),
    # generic content-type / maker words (last, so specific tags win the 5-cap)
    ("making", "build"), ("make", "build"), ("made", "build"), ("makes", "build"),
    ("project", "build"), ("custom", "build"),
    ("homemade", "diy"), ("handmade", "diy"),
    ("update", "update"), ("updates", "update"),
    ("vlog", "vlog"), ("vlogs", "vlog"),
    ("live", "live"), ("livestream", "live"),
]

def norm(s):
    """Lowercase, keep alphanumerics and '+', collapse to single spaces."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9+]+", " ", s.lower())).strip()

MAX_SLUG_LEN = 60

def slugify(title):
    """SEO slug from a video title. Must match the TypeScript slugify in the
    Worker and slugs.py exactly: NFKD, drop non-ASCII, lowercase, runs of
    non [a-z0-9] -> '-', truncate to 60 chars at a hyphen boundary."""
    t = unicodedata.normalize("NFKD", title or "")
    t = t.encode("ascii", "ignore").decode("ascii").lower()
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    if len(t) > MAX_SLUG_LEN:
        cut = t[:MAX_SLUG_LEN].rsplit("-", 1)[0]
        t = cut if cut else t[:MAX_SLUG_LEN].rstrip("-")
        t = t.strip("-")
    return t

# Batch 3: after measuring pass 2 — remaining high-frequency tokens in
# general-only titles (brand names, country names, specific nouns).
KEYWORDS_EXTRA2 = [
    ("sodium", "chemistry"), ("plasma", "physics"),
    ("teeth", "biology"), ("tooth", "biology"),
    ("sun", "space"),
    ("dagger", "sword"), ("daggers", "sword"), ("damascus", "metalwork"),
    ("armor", "war"), ("armour", "war"), ("navy", "war"), ("gunpowder", "weapons"), ("uss", "war"),
    ("king", "history"), ("queen", "history"), ("emperor", "history"), ("empire", "history"),
    ("rainbow", "light"), ("meteor", "space"), ("meteors", "space"),
    ("atari", "gaming"), ("nintendo", "gaming"), ("sega", "gaming"),
    ("playstation", "gaming"), ("xbox", "gaming"),
    ("papers", "ai"),
    ("technology", "tech"), ("technologies", "tech"),
    ("engineering", "engineering"), ("engineer", "engineering"), ("engineers", "engineering"),
    ("design", "design"), ("designs", "design"), ("designer", "design"),
    ("rescue", "car"),
    ("nhrl", "combat"),
    ("ford", "car"), ("toyota", "car"), ("honda", "car"), ("bmw", "car"),
    ("mercedes", "car"), ("ferrari", "car"), ("porsche", "car"), ("lamborghini", "car"),
    ("audi", "car"), ("volkswagen", "car"), ("vw", "car"), ("chevy", "car"),
    ("chevrolet", "car"), ("nissan", "car"), ("subaru", "car"), ("mazda", "car"),
    ("hyundai", "car"), ("kia", "car"),
    ("china", "geography"), ("japan", "geography"), ("germany", "geography"),
    ("france", "geography"), ("britain", "geography"), ("england", "geography"),
    ("america", "geography"), ("usa", "geography"), ("russia", "geography"),
    ("india", "geography"), ("australia", "geography"), ("canada", "geography"),
    ("europe", "geography"), ("africa", "geography"), ("asia", "geography"),
]

KW_NORM = [(norm(k), t) for k, t in KEYWORDS + KEYWORDS_EXTRA + KEYWORDS_EXTRA2]

def tags_for_title(title):
    nt = " " + norm(title) + " "
    tags = []
    for kw, tag in KW_NORM:
        if " " + kw + " " in nt and tag not in tags:
            tags.append(tag)
            if len(tags) == 5:
                break
    return tags or ["general"]

# ---------------------------------------------------------------- load
with open(SRC) as f:
    data = json.load(f)
channels = data["channels"]
videos = data["videos"]
assert len(channels) == 156 and len(videos) == 47339, (len(channels), len(videos))
assert set(CHANNEL_CATEGORY) == set(range(156)), "category mapping must cover 0..155"
assert set(s for s, _ in CATEGORIES) == set(CHANNEL_CATEGORY.values())

# ---------------------------------------------------------------- enrich
tag_set = set()
enriched_videos = []
video_tags_rows = []  # (video_id, tag)
per_cat = Counter()
for vid, title, dur, views, ch_idx in videos:
    cat = CHANNEL_CATEGORY[ch_idx]
    per_cat[cat] += 1
    tags = tags_for_title(title)
    tag_set.update(tags)
    for t in tags:
        video_tags_rows.append((vid, t))
    enriched_videos.append({
        "id": vid, "title": title, "slug": slugify(title),
        "duration_s": dur, "views": views,
        "channel": ch_idx, "category": cat, "tags": tags,
    })
tag_set.add("general")
tag_list = sorted(tag_set)
TAG_ID = {t: i + 1 for i, t in enumerate(tag_list)}

enriched_channels = []
for i, c in enumerate(channels):
    ec = dict(c)
    ec["category"] = CHANNEL_CATEGORY[i]
    enriched_channels.append(ec)

# ---------------------------------------------------------------- helpers
def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("\r", " ").replace("\n", " ").replace("'", "''") + "'"

def sql_str_or_null(v):
    # empty strings become NULL in the DB (cleaner than '')
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return "NULL"
    return sql_str(v)

def chunked_insert(path, header, rows, chunk=500):
    with open(path, "w") as f:
        for i in range(0, len(rows), chunk):
            part = rows[i:i + chunk]
            f.write(header + ",\n".join(part) + ";\n")

# ---------------------------------------------------------------- outputs
# 1. channel_categories.json
with open(os.path.join(OUT, "channel_categories.json"), "w") as f:
    json.dump({str(i): CHANNEL_CATEGORY[i] for i in range(156)}, f, indent=2)

# 2. schema.sql
SCHEMA = """CREATE TABLE categories (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, tier TEXT NOT NULL, tag TEXT, blurb TEXT, featured TEXT, n INTEGER NOT NULL, category_id INTEGER);
CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT, duration_s INTEGER, views INTEGER, channel_id INTEGER NOT NULL REFERENCES channels(id), category_id INTEGER NOT NULL REFERENCES categories(id), published_at TEXT);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE video_tags (video_id TEXT NOT NULL REFERENCES videos(id), tag_id INTEGER NOT NULL REFERENCES tags(id), PRIMARY KEY (video_id, tag_id));
CREATE INDEX idx_videos_channel ON videos(channel_id);
CREATE INDEX idx_videos_category ON videos(category_id);
CREATE INDEX idx_videos_views ON videos(views DESC);
CREATE INDEX idx_video_tags_tag ON video_tags(tag_id);
CREATE INDEX idx_videos_published ON videos(published_at);

-- v3: public playlists (no login; the creator holds an edit token).
CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  slug TEXT,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edit_token TEXT NOT NULL
);

CREATE TABLE playlist_videos (
  playlist_id TEXT NOT NULL REFERENCES playlists(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);

CREATE INDEX idx_playlist_videos_playlist ON playlist_videos(playlist_id, position);
CREATE INDEX idx_playlists_created ON playlists(created_at DESC);
"""
with open(os.path.join(OUT, "schema.sql"), "w") as f:
    f.write(SCHEMA)

# 3. seed_categories.sql
rows = [f"({i + 1}, {sql_str(slug)}, {sql_str(name)})" for i, (slug, name) in enumerate(CATEGORIES)]
chunked_insert(os.path.join(OUT, "seed_categories.sql"),
               "INSERT INTO categories (id, slug, name) VALUES\n", rows)

# 4. seed_channels.sql
rows = []
for i, c in enumerate(channels):
    rows.append(f"({i}, {sql_str(c['name'])}, {sql_str(c['url'])}, {sql_str(c['tier'])}, "
                f"{sql_str_or_null(c.get('tag'))}, {sql_str_or_null(c.get('blurb'))}, "
                f"{sql_str_or_null(c.get('featured'))}, {c['n']}, {CAT_ID[CHANNEL_CATEGORY[i]]})")
chunked_insert(os.path.join(OUT, "seed_channels.sql"),
               "INSERT INTO channels (id, name, url, tier, tag, blurb, featured, n, category_id) VALUES\n", rows)

# 5. seed_videos.sql
rows = []
for v in enriched_videos:
    dur = "NULL" if v["duration_s"] is None else str(v["duration_s"])
    vw = "NULL" if v["views"] is None else str(v["views"])
    rows.append(f"({sql_str(v['id'])}, {sql_str(v['title'])}, {sql_str(v['slug'])}, {dur}, {vw}, "
                f"{v['channel']}, {CAT_ID[v['category']]})")
chunked_insert(os.path.join(OUT, "seed_videos.sql"),
               "INSERT INTO videos (id, title, slug, duration_s, views, channel_id, category_id) VALUES\n", rows)

# 6. seed_tags.sql
rows = [f"({TAG_ID[t]}, {sql_str(t)})" for t in tag_list]
chunked_insert(os.path.join(OUT, "seed_tags.sql"),
               "INSERT INTO tags (id, name) VALUES\n", rows)

# 7. seed_video_tags.sql
rows = [f"({sql_str(vid)}, {TAG_ID[t]})" for vid, t in video_tags_rows]
chunked_insert(os.path.join(OUT, "seed_video_tags.sql"),
               "INSERT INTO video_tags (video_id, tag_id) VALUES\n", rows)

# 8. enriched.json
with open(os.path.join(OUT, "enriched.json"), "w") as f:
    json.dump({"channels": enriched_channels, "videos": enriched_videos}, f)

# ---------------------------------------------------------------- validate
print("=== validation (in-memory) ===")
print(f"channels: {len(channels)} | videos: {len(videos)}")
print(f"distinct tags: {len(tag_list)} | video_tags rows: {len(video_tags_rows)}")
print(f"videos with 0 tags: {sum(1 for v in enriched_videos if not v['tags'])}")
print(f"videos with 'general' only: {sum(1 for v in enriched_videos if v['tags'] == ['general'])}")
print(f"videos missing category: {sum(1 for v in enriched_videos if not v.get('category'))}")
print("videos per category:")
for slug, _ in CATEGORIES:
    print(f"  {slug:14s} {per_cat[slug]:>6}")
print("tag counts (top 25):")
tc = Counter(t for _, t in video_tags_rows)
for t, n in tc.most_common(25):
    print(f"  {t:15s} {n:>6}")
print("tag counts (bottom 10):")
for t, n in tc.most_common()[-10:]:
    print(f"  {t:15s} {n:>6}")
# declared n vs actual rows
actual = Counter(v[4] for v in videos)
mismatch = [(i, channels[i]['n'], actual[i]) for i in range(156) if channels[i]['n'] != actual[i]]
print(f"declared 'n' mismatches: {len(mismatch)} {mismatch[:5]}")
print(f"channels with empty blurb: {sum(1 for c in channels if not (c.get('blurb') or '').strip())}")
print(f"null views: {sum(1 for v in videos if v[3] is None)} | null duration: {sum(1 for v in videos if v[2] is None)}")
random.seed(42)
print("=== spot-check 10 random videos ===")
for v in random.sample(enriched_videos, 10):
    ch = channels[v['channel']]['name']
    print(f"  [{v['category']}] {v['title'][:90]} | {ch} | tags={','.join(v['tags'])}")
print("=== files ===")
for fn in sorted(os.listdir(OUT)):
    print(f"  {fn}: {os.path.getsize(os.path.join(OUT, fn)):,} bytes")
