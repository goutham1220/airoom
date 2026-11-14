// Atlas — the session map. Ported from raybase (knowledge-vault
// src/lib/chat/atlas.ts): every session, active or not, carries a `region`
// (semantic subject area), a one-line `conclusion`, and a derived state.
// Here a session also has a directory, so the map groups by either.
// Pure and shared so server and web agree and the grouping is testable.

export type AtlasSessionState = 'live' | 'closed' | 'archived';
export type AtlasGroupBy = 'region' | 'directory';

export interface AtlasSessionItem {
  id: string;
  title: string;
  /** What the session concluded (written by auto-sort); null until then. */
  conclusion: string | null;
  region: string | null;
  /** The session's working directory. */
  directory: string;
  messageCount: number;
  pinned: boolean;
  /** Ended with unfinished work or a question waiting on the human. */
  openLoop: boolean;
  updatedAt: string | null;
  state: AtlasSessionState;
}

export interface AtlasPayload {
  sessions: AtlasSessionItem[];
  /** Auto-sort progress, while one is running. */
  sorting: { done: number; total: number } | null;
}

export interface AtlasGroup {
  key: string;
  label: string;
  rollup: { count: number; live: number; lastActivity: string };
  sessions: AtlasSessionItem[];
}

export const UNSORTED_REGION = 'Unsorted';

/** "Live" while the last activity is inside this window (same as raybase). */
export const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

export function deriveSessionState(archived: boolean, updatedAt: string | null, now: number): AtlasSessionState {
  if (archived) return 'archived';
  if (updatedAt && now - Date.parse(updatedAt) < LIVE_WINDOW_MS) return 'live';
  return 'closed';
}

/** Within a group: pinned first, then most recent. Groups order by recency,
 *  Unsorted always last. */
export function groupAtlas(sessions: AtlasSessionItem[], by: AtlasGroupBy): AtlasGroup[] {
  const groups = new Map<string, AtlasGroup>();
  for (const s of sessions) {
    const key = by === 'region' ? s.region?.trim() || UNSORTED_REGION : s.directory;
    let g = groups.get(key);
    if (!g) {
      const label = by === 'region' ? key : key.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || key;
      g = { key, label, rollup: { count: 0, live: 0, lastActivity: '' }, sessions: [] };
      groups.set(key, g);
    }
    g.sessions.push(s);
    g.rollup.count++;
    if (s.state === 'live') g.rollup.live++;
    if ((s.updatedAt ?? '') > g.rollup.lastActivity) g.rollup.lastActivity = s.updatedAt ?? '';
  }
  for (const g of groups.values())
    g.sessions.sort((a, b) =>
      a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
  return [...groups.values()].sort((a, b) => {
    if (by === 'region' && a.key === UNSORTED_REGION) return 1;
    if (by === 'region' && b.key === UNSORTED_REGION) return -1;
    return b.rollup.lastActivity.localeCompare(a.rollup.lastActivity);
  });
}
