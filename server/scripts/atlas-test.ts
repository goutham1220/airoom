import assert from 'node:assert/strict';
import { deriveSessionState, groupAtlas, LIVE_WINDOW_MS, UNSORTED_REGION, type AtlasSessionItem } from '../../shared/atlas';
import { pickupCommand } from '../src/atlas';

const now = Date.parse('2026-01-10T12:00:00Z');
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
assert.equal(deriveSessionState(false, iso(1000), now), 'live');
assert.equal(deriveSessionState(false, iso(LIVE_WINDOW_MS + 1), now), 'closed');
assert.equal(deriveSessionState(true, iso(1000), now), 'archived');
assert.equal(deriveSessionState(false, null, now), 'closed');

const s = (id: string, region: string | null, directory: string, msAgo: number, pinned = false): AtlasSessionItem => ({
  id, title: id, conclusion: null, region, directory, messageCount: 3, pinned, openLoop: false,
  updatedAt: iso(msAgo), state: deriveSessionState(false, iso(msAgo), now),
});
const rows = [s('a', 'Audiobooks', '/u/misc', 5000), s('b', null, '/u', 1000), s('c', 'Audiobooks', '/u', 9000, true), s('d', 'BAPS', '/u', 3000)];
const byRegion = groupAtlas(rows, 'region');
assert.deepEqual(byRegion.map((g) => g.key), ['BAPS', 'Audiobooks', UNSORTED_REGION]); // recency, Unsorted last
assert.deepEqual(byRegion[1].sessions.map((x) => x.id), ['c', 'a']); // pinned first
const byDir = groupAtlas(rows, 'directory');
assert.deepEqual(byDir.map((g) => [g.key, g.rollup.count]), [['/u', 3], ['/u/misc', 1]]);

assert.equal(pickupCommand('claude', "/a/it's", 'abc123', null), `cd '/a/it'\\''s' && 'claude' --resume 'abc123'`);
assert.ok(pickupCommand('claude', '/a', 'abc123', 'new-id').endsWith(`--fork-session --session-id 'new-id' '/compact'`));
console.log('atlas-test ok');
