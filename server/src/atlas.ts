// Atlas server half: the per-session index (~/.airoom/atlas.json), the
// auto-sort worker (raybase's chat-session-finalize, run on demand through the
// user's own `claude`), and "pick up" — reopen a session in a terminal as a
// compacted branch. Archived == airoom's existing "let go" list, so the two
// views never disagree.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { deriveSessionState, type AtlasPayload, type AtlasSessionItem } from '../../shared/atlas';
import type { Robot } from '../../shared/types';
import { claudeBin } from './agent/claudeBin';
import type { LocalClaudeDataSource } from './datasource/LocalClaudeDataSource';

interface AtlasMeta {
  region?: string;
  /** Set by hand — auto-sort must not overwrite it. */
  regionManual?: boolean;
  conclusion?: string;
  pinned?: boolean;
  openLoop?: boolean;
}

const STORE = path.join(os.homedir(), '.airoom', 'atlas.json');
const SESSION_RE = /^[A-Za-z0-9._-]{6,100}$/;
let meta: Record<string, AtlasMeta> | null = null;
let sorting: { done: number; total: number } | null = null;

async function load(): Promise<Record<string, AtlasMeta>> {
  if (meta) return meta;
  try {
    meta = JSON.parse(await fs.readFile(STORE, 'utf8')) as Record<string, AtlasMeta>;
  } catch {
    meta = {};
  }
  return meta;
}

async function save() {
  await fs.mkdir(path.dirname(STORE), { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(meta ?? {}, null, 2));
}

async function payload(source: LocalClaudeDataSource): Promise<AtlasPayload> {
  const [m, robots, archived] = await Promise.all([load(), source.allSessions(), source.hiddenSessions()]);
  const gone = new Set(archived);
  const now = Date.now();
  const sessions: AtlasSessionItem[] = robots.map((r) => ({
    id: r.sessionId,
    title: r.title,
    conclusion: m[r.sessionId]?.conclusion ?? null,
    region: m[r.sessionId]?.region ?? null,
    directory: r.roomId,
    messageCount: r.messageCount,
    pinned: m[r.sessionId]?.pinned ?? false,
    openLoop: m[r.sessionId]?.openLoop ?? false,
    updatedAt: r.lastActivity,
    state: deriveSessionState(gone.has(r.sessionId), r.lastActivity, now),
  }));
  return { sessions, sorting };
}

// ── auto-sort ───────────────────────────────────────────────────────────────

const SORT_SYSTEM = `You index a coding-agent session for a session map. Return JSON:
- "conclusion": ONE sentence, max 140 characters, stating what the session CONCLUDED or produced — the answer, not the question. Plain English, no meta ("the user asked...").
- "region": assign the session to one of the EXISTING REGIONS listed in the prompt unless clearly none fits; only then coin a new Title Case region name of 2-4 words. Regions are broad subject areas or projects, not per-session topics.
- "openLoop": true if the session ended with unfinished work or a question waiting on the human.`;
const SORT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { conclusion: { type: 'string' }, region: { type: 'string' }, openLoop: { type: 'boolean' } },
  required: ['conclusion', 'region', 'openLoop'],
});

/** Head + tail of the conversation: the framing and the conclusion. */
async function condense(source: LocalClaudeDataSource, id: string): Promise<string> {
  const { steps } = await source.getTranscript(id, 400);
  const text = steps
    .filter((s) => s.kind === 'user' || s.kind === 'assistant_text')
    .map((s) => `${s.kind === 'user' ? 'USER' : 'ASSISTANT'}: ${(s.detail ?? s.label).slice(0, 600)}`)
    .join('\n');
  return text.length <= 14000 ? text : `${text.slice(0, 5000)}\n[…]\n${text.slice(-9000)}`;
}

function conclude(prompt: string): Promise<AtlasMeta | null> {
  return new Promise((resolve) => {
    // No tools, no settings, no MCP, no transcript: a ~1k-token call that
    // leaves nothing behind in ~/.claude/projects (so it never becomes a desk).
    // prettier-ignore
    const p = spawn(claudeBin() ?? 'claude', [
      '-p', '--model', 'sonnet', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands',
      '--setting-sources', '', '--tools', '', '--output-format', 'json',
      '--system-prompt', SORT_SYSTEM, '--json-schema', SORT_SCHEMA,
    ], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      try {
        const o = JSON.parse(out).structured_output;
        resolve({
          conclusion: String(o.conclusion).slice(0, 140),
          region: String(o.region).trim().slice(0, 80),
          openLoop: o.openLoop === true,
        });
      } catch {
        resolve(null);
      }
    });
    p.stdin.end(prompt);
  });
}

/** Conclude + assign a region to the most recent sessions that have none.
 *  ponytail: sequential and capped per click; batch/parallelise if 900
 *  sessions at ~3s each ever needs to be faster. */
async function autoSort(source: LocalClaudeDataSource, limit: number) {
  if (sorting) return;
  const m = await load();
  const todo = (await source.allSessions())
    .filter((r) => !m[r.sessionId]?.conclusion && r.messageCount >= 2)
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
    .slice(0, limit);
  sorting = { done: 0, total: todo.length };
  try {
    for (const r of todo) {
      const regions = [...new Set(Object.values(m).map((x) => x.region).filter(Boolean))];
      const result = await conclude(
        `EXISTING REGIONS: ${regions.join(' | ') || '(none yet)'}\nDIRECTORY: ${r.roomId}\nTITLE: ${r.title}\n\nTRANSCRIPT:\n${await condense(source, r.sessionId)}`,
      );
      if (result) {
        const cur = m[r.sessionId] ?? {};
        m[r.sessionId] = { ...cur, ...result, region: cur.regionManual ? cur.region : result.region };
        await save();
      }
      sorting.done++;
    }
  } finally {
    sorting = null;
  }
}

// ── pick up ─────────────────────────────────────────────────────────────────

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** The command a pick-up runs. `fork` branches the session under a known new
 *  id and compacts it as its first act; the original transcript is untouched. */
export function pickupCommand(bin: string, cwd: string, sessionId: string, forkId: string | null): string {
  const base = `cd ${shq(cwd)} && ${shq(bin)} --resume ${shq(sessionId)}`;
  return forkId ? `${base} --fork-session --session-id ${shq(forkId)} '/compact'` : base;
}

async function pickup(source: LocalClaudeDataSource, robot: Robot, fork: boolean): Promise<string | null> {
  if (process.platform !== 'darwin') return 'Pick up opens a macOS terminal; on this OS run the command yourself.';
  if (!existsSync(robot.roomId)) return `Folder is gone: ${robot.roomId}`;
  const forkId = fork ? randomUUID() : null;
  const cmd = pickupCommand(claudeBin() ?? 'claude', robot.roomId, robot.sessionId, forkId);
  const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = existsSync('/Applications/iTerm.app')
    ? `tell application "iTerm"\ncreate window with default profile\ntell current session of current window to write text "${esc}"\nactivate\nend tell`
    : `tell application "Terminal"\ndo script "${esc}"\nactivate\nend tell`;
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    p.on('error', () => resolve(-1));
    p.on('exit', resolve);
  });
  if (code !== 0) return `Could not open a terminal (osascript exited ${code}). Run: ${cmd}`;
  const m = await load();
  if (forkId) {
    // The branch inherits its place on the map; the original stays where it is.
    const { region, conclusion } = m[robot.sessionId] ?? {};
    if (region) m[forkId] = { region, regionManual: true, conclusion };
    await save();
  } else await source.setSessionHidden(robot.sessionId, false); // resumed in place → active again
  return null;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/** Routes under /atlas. Returns false when the request is not ours. */
export function handleAtlas(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  source: LocalClaudeDataSource,
  headers: Record<string, string>,
  localOrigin: boolean,
): boolean {
  if (!req.url?.startsWith('/atlas')) return false;
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };
  // These POSTs open terminals and spend tokens: a page on another origin
  // must not be able to fire them at loopback.
  if (!localOrigin) return reply(403, { error: 'forbidden' }), true;
  if (req.method === 'GET') {
    void payload(source).then((p) => reply(200, p), (e) => reply(500, { error: String(e) }));
    return true;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 4096) req.destroy();
  });
  req.on('end', () => {
    void (async () => {
      try {
        const b = JSON.parse(body || '{}') as Record<string, unknown>;
        if (req.url === '/atlas/sort') {
          void autoSort(source, Math.min(Number(b.limit) || 25, 200));
          return reply(202, { ok: true });
        }
        const id = String(b.sessionId ?? '');
        const robot = SESSION_RE.test(id) ? (await source.allSessions()).find((r) => r.sessionId === id) : undefined;
        if (!robot) return reply(404, { error: 'No such session.' });
        if (req.url === '/atlas/pickup') {
          const err = await pickup(source, robot, b.fork !== false);
          return reply(err ? 500 : 200, err ? { error: err } : { ok: true });
        }
        if (req.url === '/atlas/session') {
          const m = await load();
          const cur = (m[id] ??= {});
          if (typeof b.region === 'string') {
            cur.region = b.region.trim().slice(0, 80) || undefined;
            cur.regionManual = !!cur.region;
          }
          if (typeof b.pinned === 'boolean') cur.pinned = b.pinned;
          await save();
          if (typeof b.archived === 'boolean') await source.setSessionHidden(id, b.archived);
          return reply(200, { ok: true });
        }
        reply(404, { error: 'not found' });
      } catch (err) {
        reply(400, { error: String((err as Error).message ?? err) });
      }
    })();
  });
  return true;
}
