// Verify the TypeScript slugify in src/index.ts matches the Python slugify
// (~/workspace/tubeplus/data/build.py) over every video title in the seed.
// Input: /tmp/slugcheck.json — [{id, title, slug}] from seed_videos.sql.
// Run: python3 -c (build /tmp/slugcheck.json) && node scripts/check-slugify.mjs
import { readFileSync } from 'node:fs';
import { slugify } from '../src/index.ts';

const rows = JSON.parse(readFileSync('/tmp/slugcheck.json', 'utf8'));
const expected = {
  IvUU8joBb1Q: 'wintergatan-marble-machine-music-instrument-using-2000',
  DPZzrlFCD_I: 'world-s-largest-jello-pool-can-you-swim-in-jello',
  GuCdsyCWmt8: 'electron-microscope-slow-motion-video-of-vinyl-lp',
};
let bad = 0;
const shown = [];
for (const r of rows) {
  const got = slugify(r.title);
  if (got !== r.slug) {
    bad++;
    if (shown.length < 5) shown.push([r.id, r.title, r.slug, got]);
  }
}
console.log('titles checked:', rows.length, '| mismatches:', bad);
for (const s of shown) console.log('MISMATCH', JSON.stringify(s));
for (const [id, want] of Object.entries(expected)) {
  const row = rows.find((r) => r.id === id);
  const got = slugify(row.title);
  console.log(id, got === want ? 'OK' : 'FAIL', '|', got);
}
if (bad > 0) process.exit(1);
console.log('slugify: TS == Python on all', rows.length, 'titles');
