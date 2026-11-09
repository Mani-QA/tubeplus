// Verify the v3 pure helpers in src/index.ts:
//  - parseRss against real YouTube RSS feeds (channel + playlist, saved by curl)
//  - tagsForTitle/videoTagsFor == the Python pipeline (data/ytutil.py) on all
//    47,339 seed titles + stored pass-2 tags
//  - parsePlaylistId / parseChannelUc on representative inputs
// Run: node scripts/check-v3.mjs
// Inputs: /tmp/rss_wintergatan.xml, /tmp/rss_playlist.xml (curl-saved RSS),
//         /tmp/tagcheck.json — [{id, title, channel, tags}] from enriched.json.
import { readFileSync } from 'node:fs';
import { parseRss, tagsForTitle, videoTagsFor, parsePlaylistId, parseChannelUc } from '../src/index.ts';

let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) { failures++; console.log('FAIL', label, extra ?? ''); }
  else console.log('ok  ', label, extra ?? '');
};

// --- RSS parsing (real feeds) ---
const chXml = readFileSync('/tmp/rss_wintergatan.xml', 'utf8');
const ch = parseRss(chXml);
check('channel RSS parses', !!ch && ch.entries.length >= 10, `entries=${ch?.entries.length}`);
check('channel RSS title', ch?.title === 'Wintergatan', ch?.title);
check('channel RSS first entry', ch?.entries[0]?.id === 'fM0cGOJVRxU' && !!ch?.entries[0]?.published && ch?.entries[0]?.views != null,
  `${ch?.entries[0]?.id} | ${ch?.entries[0]?.published} | views=${ch?.entries[0]?.views}`);
check('channel RSS entry has channelId', ch?.entries.every((e) => e.channelId.startsWith('UC')), '');

const plXml = readFileSync('/tmp/rss_playlist.xml', 'utf8');
const pl = parseRss(plXml);
check('playlist RSS parses', !!pl && pl.entries.length === 13, `entries=${pl?.entries.length}`);
check('playlist RSS title', pl?.title === 'Awesome creations from the Wintergatan Community', pl?.title);
check('playlist RSS first entry (other channel)', pl?.entries[0]?.id === 'DUrBEl_ezks' && pl?.entries[0]?.channelId === 'UCOP5c0_kxUJ8rhx0aXnzaQw' && pl?.entries[0]?.author === 'AmberLighting',
  `${pl?.entries[0]?.id} | ${pl?.entries[0]?.channelId} | ${pl?.entries[0]?.author}`);
check('playlist RSS entries have published', pl?.entries.every((e) => !!e.published), '');

// --- ID parsing ---
check('parsePlaylistId raw', parsePlaylistId('PLLLYkE3G1HEA87KHNFua6V4nntOG-Cogm') === 'PLLLYkE3G1HEA87KHNFua6V4nntOG-Cogm', '');
check('parsePlaylistId url', parsePlaylistId('https://www.youtube.com/playlist?list=PLLLYkE3G1HEA87KHNFua6V4nntOG-Cogm') === 'PLLLYkE3G1HEA87KHNFua6V4nntOG-Cogm', '');
check('parsePlaylistId bad', parsePlaylistId('not-a-playlist') === null, '');
check('parseChannelUc raw', parseChannelUc('UCcXhhVwCT6_WqjkEniejRJQ') === 'UCcXhhVwCT6_WqjkEniejRJQ', '');
check('parseChannelUc url', parseChannelUc('https://www.youtube.com/channel/UCcXhhVwCT6_WqjkEniejRJQ') === 'UCcXhhVwCT6_WqjkEniejRJQ', '');
check('parseChannelUc bad', parseChannelUc('not-a-channel!!!') === null, '');

// --- Tagger vs the Python pipeline (all 47,339 seed titles) ---
const rows = JSON.parse(readFileSync('/tmp/tagcheck.json', 'utf8'));
let tagBad = 0;
let slugBad = 0;
const shown = [];
for (const r of rows) {
  const got = videoTagsFor(r.title, r.channel);
  if (JSON.stringify(got) !== JSON.stringify(r.tags)) {
    tagBad++;
    if (shown.length < 5) shown.push([r.id, r.title, r.tags, got]);
  }
}
console.log('titles checked:', rows.length, '| tag mismatches (TS vs stored pass-2):', tagBad);
for (const s of shown) console.log('TAG MISMATCH', JSON.stringify(s));
check('tagsForTitle == Python on all titles', tagBad === 0, '');
check('tagsForTitle general-only fallback', JSON.stringify(videoTagsFor('Hello world', 10)) === JSON.stringify(['chemistry']), JSON.stringify(videoTagsFor('Hello world', 10)));
check('tagsForTitle keyword tags', JSON.stringify(tagsForTitle('Making gold from scratch')) === JSON.stringify(['metalwork', 'build']), JSON.stringify(tagsForTitle('Making gold from scratch')));

if (failures > 0) { console.log('FAILURES:', failures); process.exit(1); }
console.log('check-v3: all passed');
