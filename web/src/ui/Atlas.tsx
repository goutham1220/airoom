import { useCallback, useEffect, useMemo, useState } from 'react';
import { groupAtlas, type AtlasGroupBy, type AtlasPayload, type AtlasSessionItem, type AtlasSessionState } from '@shared/atlas';
import { API_BASE } from '../net/base';
import { useFocusTrap } from './useFocusTrap';

interface Props {
  /** Open the session's desk in airoom, when it has one. */
  onOpenDesk: (sessionId: string) => void;
  hasDesk: (sessionId: string) => boolean;
  onNotice: (text: string, isError?: boolean) => void;
  onClose: () => void;
}

const STATE_COLOR: Record<AtlasSessionState, string> = {
  live: 'var(--ok)',
  closed: 'var(--idle)',
  archived: 'transparent',
};
const FILTERS: { value: AtlasSessionState | 'all' | 'active'; label: string }[] = [
  { value: 'active', label: 'active' },
  { value: 'archived', label: 'inactive' },
  { value: 'all', label: 'all' },
];

function relTime(iso: string | null): string {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(m, 0)}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const dirLabel = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || p;

async function post(route: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const r = await fetch(`${API_BASE}/atlas/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok ? null : ((await r.json()) as { error?: string }).error ?? 'Request failed';
  } catch (e) {
    return String(e);
  }
}

/**
 * The session map: every session on disk, active or not, grouped by region
 * (what it is about) or by directory (where it ran). Deactivate one and it
 * leaves its desk but stays here; pick it up and it reopens in a terminal as
 * a compacted branch.
 */
export function Atlas({ onOpenDesk, hasDesk, onNotice, onClose }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  const [data, setData] = useState<AtlasPayload | null>(null);
  const [by, setBy] = useState<AtlasGroupBy>(() => (localStorage.getItem('airoom.atlasBy') === 'directory' ? 'directory' : 'region'));
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('active');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setData((await (await fetch(`${API_BASE}/atlas`)).json()) as AtlasPayload);
    } catch {
      /* server restarting — the next refresh gets it */
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  // Auto-sort runs server-side; poll only while it does.
  const sorting = data?.sorting ?? null;
  useEffect(() => {
    if (!sorting) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [sorting, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (editing) setEditing(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, onClose]);

  const act = async (route: string, body: Record<string, unknown>, done?: string) => {
    const err = await post(route, body);
    if (err) onNotice(err, true);
    else if (done) onNotice(done);
    void refresh();
  };

  const regions = useMemo(
    () => [...new Set((data?.sessions ?? []).map((s) => s.region).filter((r): r is string => !!r))].sort(),
    [data],
  );
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = (data?.sessions ?? []).filter(
      (s) =>
        (filter === 'all' || (filter === 'active' ? s.state !== 'archived' : s.state === 'archived')) &&
        (!needle || `${s.title} ${s.conclusion ?? ''} ${s.region ?? ''} ${s.directory}`.toLowerCase().includes(needle)),
    );
    return groupAtlas(rows, by);
  }, [data, by, filter, q]);
  const unsorted = (data?.sessions ?? []).filter((s) => !s.conclusion && s.messageCount >= 2).length;
  // Searching shows every match; otherwise the three most recent groups start open.
  const isOpen = (key: string, i: number) => !!q.trim() || open.has(key) !== i < 3;
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const row = (s: AtlasSessionItem) => (
    <div key={s.id} className="roster__rowWrap atlas__row">
      <button
        className="roster__row"
        onClick={() => (hasDesk(s.id) ? onOpenDesk(s.id) : onNotice('No desk — use “pick up” to reopen it in a terminal.'))}
        title={hasDesk(s.id) ? 'Open its desk' : s.conclusion ?? s.title}
      >
        <span className={`roster__led atlas__led--${s.state}`} style={{ background: STATE_COLOR[s.state] }} />
        <span className="roster__main">
          <span className="roster__title">
            {s.pinned ? '★ ' : ''}
            {s.title}
            {s.openLoop && s.state !== 'archived' ? <span className="atlas__loop">open loop</span> : null}
          </span>
          {s.conclusion && <span className="atlas__conclusion">{s.conclusion}</span>}
          <span className="roster__sub">
            {by === 'region' ? dirLabel(s.directory) : s.region ?? 'unsorted'} · {s.messageCount} turns · {relTime(s.updatedAt)}
          </span>
        </span>
      </button>
      {editing === s.id ? (
        <form
          className="atlas__edit"
          onSubmit={(e) => {
            e.preventDefault();
            const region = new FormData(e.currentTarget).get('region');
            setEditing(null);
            void act('session', { sessionId: s.id, region: String(region ?? '') });
          }}
        >
          <input name="region" list="atlas-regions" defaultValue={s.region ?? ''} placeholder="Region" aria-label="Region" autoFocus />
        </form>
      ) : (
        <span className="atlas__acts">
          <button className="roster__act" onClick={() => setEditing(s.id)} title="Move to another region">
            region
          </button>
          <button className="roster__act" onClick={() => void act('session', { sessionId: s.id, pinned: !s.pinned })} title={s.pinned ? 'Unpin' : 'Pin to the top of its group'} aria-label={s.pinned ? 'Unpin' : 'Pin'}>
            {s.pinned ? '★' : '☆'}
          </button>
          <button
            className="roster__back"
            onClick={() => void act('pickup', { sessionId: s.id, fork: true }, 'Opened a compacted branch in your terminal.')}
            title="Branch this session, compact it, and continue in a terminal. The original is untouched."
          >
            pick up
          </button>
          <button
            className="roster__act"
            onClick={() => void act('pickup', { sessionId: s.id, fork: false }, 'Resumed in your terminal.')}
            title="Resume this exact session in a terminal (no branch, no compact)"
          >
            resume
          </button>
          <button
            className="roster__act"
            onClick={() => void act('session', { sessionId: s.id, archived: s.state !== 'archived' })}
            title={s.state === 'archived' ? 'Make active again' : 'Deactivate — leaves its desk, stays on the map'}
          >
            {s.state === 'archived' ? 'activate' : 'deactivate'}
          </button>
        </span>
      )}
    </div>
  );

  return (
    <div className="connect roster atlas" ref={trapRef} role="dialog" aria-modal="true" aria-label="Atlas — all sessions">
      <div className="connect__head">
        <span className="connect__title">Atlas — {data ? `${data.sessions.length} sessions` : 'loading…'}</span>
        <button className="panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="atlas__bar">
        <input className="atlas__search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, conclusion, region, folder…" aria-label="Search sessions" autoFocus />
        <span className="atlas__seg" role="group" aria-label="Group by">
          {(['region', 'directory'] as const).map((v) => (
            <button
              key={v}
              className={by === v ? 'on' : ''}
              aria-pressed={by === v}
              onClick={() => {
                setBy(v);
                setOpen(new Set());
                localStorage.setItem('airoom.atlasBy', v);
              }}
            >
              {v}
            </button>
          ))}
        </span>
        <span className="atlas__seg" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.value} className={filter === f.value ? 'on' : ''} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </span>
        <button
          className="kbtn"
          disabled={!!sorting || unsorted === 0}
          onClick={() => void act('sort', { limit: 25 })}
          title="Read the 25 most recent unsorted sessions and give each a conclusion and a region (uses your Claude plan, ~1k tokens each)"
        >
          {sorting ? `sorting ${sorting.done}/${sorting.total}…` : `auto-sort (${unsorted} unsorted)`}
        </button>
      </div>
      <datalist id="atlas-regions">
        {regions.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="roster__body">
        {groups.map((g, i) => (
          <section key={g.key} className="atlas__group">
            <button className="atlas__groupHead" onClick={() => toggle(g.key)} aria-expanded={isOpen(g.key, i)} title={by === 'directory' ? g.key : undefined}>
              <span className="atlas__caret">{isOpen(g.key, i) ? '▾' : '▸'}</span>
              <span className="atlas__groupName">{g.label}</span>
              <span className="roster__sub">
                {g.rollup.count} session{g.rollup.count === 1 ? '' : 's'}
                {g.rollup.live ? ` · ${g.rollup.live} live` : ''} · {relTime(g.rollup.lastActivity || null)}
              </span>
            </button>
            {isOpen(g.key, i) && g.sessions.map(row)}
          </section>
        ))}
        {data && groups.length === 0 && <div className="atlas__empty">Nothing matches.</div>}
      </div>
    </div>
  );
}
