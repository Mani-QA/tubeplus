// Extract CLIENT_JS from src/index.ts and write it to /tmp for `node --check`.
// The client code lives in a String.raw template literal and contains no
// backticks, so the next backtick after the opening one ends the block.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(ROOT, '..', 'src', 'index.ts'), 'utf8');
const marker = 'const CLIENT_JS = String.raw`';
const start = src.indexOf(marker);
if (start < 0) throw new Error('CLIENT_JS not found');
const bodyStart = start + marker.length;
const end = src.indexOf('`', bodyStart);
if (end < 0) throw new Error('CLIENT_JS closing backtick not found');
const client = src.slice(bodyStart, end);
writeFileSync('/tmp/tubeplus-client.js', client);
console.log('wrote /tmp/tubeplus-client.js', client.length, 'chars');
