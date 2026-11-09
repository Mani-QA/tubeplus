#!/usr/bin/env python3
"""Shared YouTube helpers for the TubePlus ingest pipeline (ingest.py).

slugify(), norm(), KEYWORDS (+EXTRA/+EXTRA2), KW_NORM and tags_for_title()
are copied VERBATIM from build.py (same lines) so videos ingested from RSS
get slugs and tags identical to the seeded catalogue. If build.py's keyword
lists change, re-run the extraction (see the note at the bottom) and
regenerate the TypeScript copy with gen_ts_tags.py.

video_tags_for() mirrors pass2.py: keyword tags from the title, falling back
to the channel's curated topic tag(s) when the title would otherwise be
"general"-only.
"""
import re
import unicodedata

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

# ---------------------------------------------------------------- topic tags
# pass2.py has a __main__ guard, so importing it is safe (no pipeline run).
from pass2 import CHANNEL_TOPIC_TAGS


def topic_tags_for_channel(channel_idx):
    """Curated topic tag(s) for a channel index, or [] if none were defined."""
    return list(CHANNEL_TOPIC_TAGS.get(channel_idx, []))


def video_tags_for(title, channel_idx):
    """Tags for a video: keyword tags from the title, with the channel topic
    tag(s) as fallback when the title would otherwise be 'general'-only
    (exactly the pass-2 rule)."""
    tags = tags_for_title(title)
    if tags == ["general"]:
        topic = topic_tags_for_channel(channel_idx)
        if topic:
            tags = topic
    return tags
