// Builds scripts/seed-local.sql — a SMALL local-only seed for `wrangler dev --local`.
// Reads the Tristan Tube snapshot at ~/workspace/your_files/tristan-tube-videos.json
// (156 channels, 47,339 videos) and emits:
//   - schema matching the production D1 tables
//   - all 156 channels (id = array index, so video channel_index joins directly)
//   - the first 200 videos
//   - 13 categories (invented for local dev only; production categories come
//     from the real D1) assigned by title/channel keyword matching
//   - ~30 keyword tags + video_tags rows
// Run: node scripts/seed-local.mjs
// Then: npx wrangler d1 execute tubeplus-db --local --file=scripts/seed-local.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(process.env.HOME, 'workspace/your_files/tristan-tube-videos.json');
const OUT = path.join(ROOT, 'seed-local.sql');
const VIDEO_LIMIT = 200;

const CATEGORIES = [
  ['engineering', 'Engineering'],
  ['science', 'Science'],
  ['space', 'Space'],
  ['technology', 'Technology'],
  ['making', 'Making'],
  ['cooking', 'Cooking'],
  ['music', 'Music'],
  ['history', 'History'],
  ['mathematics', 'Mathematics'],
  ['art', 'Art'],
  ['machines', 'Machines'],
  ['nature', 'Nature'],
  ['gaming', 'Gaming'],
];

// First match wins; default is engineering (id 1).
const CATEGORY_RULES = [
  [3, ['space', 'nasa', 'rocket', 'mars', 'moon', 'astronaut', 'orbit', 'telescope', 'planet', 'cosmos', 'black hole']],
  [2, ['science', 'physics', 'chemistry', 'biology', 'quantum', 'dna', 'evolution', 'experiment', 'atom', 'molecule']],
  [9, ['math', 'number', 'geometry', 'calculus', 'prime', 'equation', 'algebra']],
  [8, ['history', 'war', 'ancient', 'roman', 'medieval', 'world war']],
  [7, ['music', 'song', 'piano', 'guitar', 'singing', 'band', 'album', 'concert']],
  [6, ['cook', 'recipe', 'food', 'kitchen', 'chef', 'baking', 'bread']],
  [13, ['game', 'gaming', 'minecraft', 'zelda', 'pokemon', 'playstation', 'xbox', 'speedrun']],
  [12, ['nature', 'animal', 'wildlife', 'ocean', 'forest', 'bird', 'shark', 'dog', 'cat']],
  [10, ['art', 'paint', 'draw', 'design', 'photograph', 'sculpture', 'architecture']],
  [4, ['tech', 'computer', 'software', 'artificial intelligence', 'robot', 'iphone', 'android', 'internet', 'code', 'programming']],
  [5, ['making', 'build', 'diy', 'woodwork', 'craft', 'workshop', '3d print', 'how to make']],
  [11, ['car', 'airplane', 'plane', 'train', 'ship', 'tank', 'engine', 'flight']],
];

const TAG_RULES = [
  ['explainer', ['explained', 'how ', 'why ', 'what is']],
  ['documentary', ['documentary', 'story of', 'the history of']],
  ['how it works', ['how it works', 'how does', 'inside the']],
  ['space', ['space', 'nasa', 'rocket', 'mars', 'moon']],
  ['science', ['science', 'physics', 'chemistry', 'quantum', 'experiment']],
  ['history', ['history', 'war', 'ancient', 'roman']],
  ['music', ['music', 'song', 'piano', 'guitar']],
  ['cooking', ['cook', 'recipe', 'food', 'kitchen']],
  ['gaming', ['game', 'minecraft', 'zelda', 'pokemon']],
  ['nature', ['nature', 'animal', 'wildlife', 'ocean', 'forest']],
  ['technology', ['tech', 'computer', 'software', 'ai', 'robot', 'internet']],
  ['engineering', ['engineer', 'bridge', 'machine', 'motor']],
  ['math', ['math', 'number', 'geometry', 'prime']],
  ['art', ['art', 'paint', 'draw', 'design']],
  ['interview', ['interview', 'talks to', 'conversation']],
  ['review', ['review', 'tested', 'i tried']],
  ['tutorial', ['tutorial', 'how to', 'learn']],
  ['experiment', ['experiment', 'test', 'what happens']],
  ['animation', ['animation', 'animated']],
  ['vlog', ['vlog', 'day in', 'my life']],
  ['challenge', ['challenge', '24 hours', '100 days']],
  ['speedrun', ['speedrun']],
  ['deep dive', ['deep dive', 'in depth']],
  ['funny', ['funny', 'comedy', 'meme']],
  ['educational', ['explained', 'learn', 'science', 'history']],
  ['beginner', ['beginner', 'basics', 'introduction']],
  ['advanced', ['advanced', 'expert']],
  ['timelapse', ['timelapse', 'time-lapse']],
];

const esc = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const num = (n) => (n == null ? 'NULL' : String(n));

function categorize(title) {
  // Title only — the channel name would skew everything (e.g. every video
  // from "Applied Science" would land in Science).
  const hay = title.toLowerCase();
  for (const [catId, kws] of CATEGORY_RULES) {
    if (kws.some((k) => hay.includes(k))) return catId;
  }
  return 1; // engineering
}

function tagVideo(title, durationS) {
  const hay = title.toLowerCase();
  const tags = [];
  for (const [tag, kws] of TAG_RULES) {
    if (kws.some((k) => hay.includes(k))) tags.push(tag);
  }
  if (durationS != null && durationS <= 300) tags.push('short');
  if (durationS != null && durationS >= 1800) tags.push('long form');
  return [...new Set(tags)].slice(0, 5);
}

const data = JSON.parse(readFileSync(SRC, 'utf8'));
const channels = data.channels;
const videos = data.videos.slice(0, VIDEO_LIMIT);

// Channel index in the video tuples: 0-based if max == channels.length - 1,
// 1-based if max == channels.length. Normalize to 0-based.
const maxIdx = Math.max(...videos.map((v) => v[4]));
const idxOffset = maxIdx === channels.length ? 1 : 0;
if (maxIdx > channels.length || (idxOffset === 0 && maxIdx === channels.length)) {
  throw new Error(`channel_index ${maxIdx} out of range for ${channels.length} channels`);
}

const lines = [];
lines.push('-- TubePlus local seed — first 200 videos + all 156 channels.');
lines.push('-- Generated by scripts/seed-local.mjs. LOCAL ONLY: never run against the real D1.');
lines.push('PRAGMA foreign_keys=OFF;');
lines.push('BEGIN TRANSACTION;');
lines.push(`CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL);`);
lines.push(`CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT, tier TEXT, tag TEXT, blurb TEXT, featured TEXT, n INTEGER);`);
lines.push(`CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT, duration_s INTEGER, views INTEGER, channel_id INTEGER, category_id INTEGER, published_at TEXT);`);
lines.push(`CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);`);
lines.push(`CREATE TABLE IF NOT EXISTS video_tags (video_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (video_id, tag_id));`);
lines.push(`CREATE TABLE IF NOT EXISTS likes (video_id TEXT PRIMARY KEY, likes INTEGER NOT NULL DEFAULT 0);`);
lines.push(`CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, slug TEXT, title TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, edit_token TEXT NOT NULL);`);
lines.push(`CREATE TABLE IF NOT EXISTS playlist_videos (playlist_id TEXT NOT NULL, video_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (playlist_id, video_id));`);

for (const [i, [slug, name]] of CATEGORIES.entries()) {
  lines.push(`INSERT OR REPLACE INTO categories (id, slug, name) VALUES (${i + 1}, ${esc(slug)}, ${esc(name)});`);
}

channels.forEach((ch, i) => {
  lines.push(
    `INSERT OR REPLACE INTO channels (id, name, url, tier, tag, blurb, featured, n) VALUES (${i}, ${esc(ch.name)}, ${esc(ch.url)}, ${esc(ch.tier)}, ${esc(ch.tag)}, ${esc(ch.blurb)}, ${esc(ch.featured)}, ${num(ch.n)});`,
  );
});

const tagIds = new Map();
for (const [i, [tag]] of TAG_RULES.entries()) tagIds.set(tag, i + 1);
tagIds.set('short', TAG_RULES.length + 1);
tagIds.set('long form', TAG_RULES.length + 2);
for (const [tag, id] of tagIds) {
  lines.push(`INSERT OR REPLACE INTO tags (id, name) VALUES (${id}, ${esc(tag)});`);
}

let tagged = 0;
videos.forEach((v) => {
  const [id, title, dur, views, chIdx] = v;
  const channelId = chIdx - idxOffset;
  const catId = categorize(title);
  lines.push(
    `INSERT OR REPLACE INTO videos (id, title, duration_s, views, channel_id, category_id) VALUES (${esc(id)}, ${esc(title)}, ${num(dur)}, ${num(views)}, ${channelId}, ${catId});`,
  );
  for (const tag of tagVideo(title, dur)) {
    lines.push(`INSERT OR REPLACE INTO video_tags (video_id, tag_id) VALUES (${esc(id)}, ${tagIds.get(tag)});`);
    tagged++;
  }
});

lines.push('COMMIT;');
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${OUT}: ${channels.length} channels, ${videos.length} videos, ${CATEGORIES.length} categories, ${tagIds.size} tags, ${tagged} video_tags rows`);
