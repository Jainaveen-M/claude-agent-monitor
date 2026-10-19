#!/usr/bin/env node
// Claude Code agent monitor: a zero-dependency local dashboard.
//
// Data sources (all local, read-only):
//   ~/.claude/sessions/<pid>.json          live session registry (id, cwd, name, busy/idle)
//   ~/.claude/projects/<slug>/<id>.jsonl   session transcript (task, tools, tokens, log)
//   ps / lsof                              CPU and memory for each agent's process tree

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || '127.0.0.1';
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TICK_MS = 2000;
const HISTORY_SAMPLES = 90;              // 3 minutes at 2s
const LOG_RING = 500;                    // events kept per transcript
const MAX_INITIAL_READ = 32 * 1024 * 1024;
const EXITED_VISIBLE_MS = 6 * 60 * 60 * 1000;
const MAX_PROCS_PER_AGENT = 40;
const FLOW_RECENT = 25;                 // events per agent sent for the flow view

// ---------------------------------------------------------------- processes

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parseLstart(dow, mon, day, hms, year) {
  const [h, m, s] = hms.split(':').map(Number);
  return new Date(Number(year), MONTHS[mon], Number(day), h, m, s).getTime();
}

// "0:32.11", "12:03:04", "1-02:03:04" -> seconds
function parseCpuTime(t) {
  let days = 0;
  if (t.includes('-')) { const [d, rest] = t.split('-'); days = Number(d); t = rest; }
  const parts = t.split(':').map(Number);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return days * 86400 + secs;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

const prevCpu = new Map(); // `${pid}:${start}` -> { cpuSecs, at }

async function sampleProcesses() {
  const out = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,time=,lstart=,command=']);
  const now = Date.now();
  const procs = new Map();
  const children = new Map();
  const seen = new Set();
  for (const line of out.split('\n')) {
    const tok = line.trim().split(/\s+/);
    if (tok.length < 11) continue;
    const [pid, ppid, pcpu, rss, time, dow, mon, day, hms, year] = tok;
    const command = tok.slice(10).join(' ');
    const start = parseLstart(dow, mon, day, hms, year);
    const cpuSecs = parseCpuTime(time);
    const key = `${pid}:${start}`;
    seen.add(key);
    const prev = prevCpu.get(key);
    // Instantaneous CPU from cumulative CPU time; fall back to ps's decaying average.
    const cpu = prev && now > prev.at ? Math.max(0, ((cpuSecs - prev.cpuSecs) / ((now - prev.at) / 1000)) * 100) : Number(pcpu);
    prevCpu.set(key, { cpuSecs, at: now });
    const p = { pid: Number(pid), ppid: Number(ppid), cpu, rss: Number(rss) * 1024, start, command };
    procs.set(p.pid, p);
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  for (const k of prevCpu.keys()) if (!seen.has(k)) prevCpu.delete(k);
  for (const k of cwdCache.keys()) if (!seen.has(k)) cwdCache.delete(k);
  return { procs, children };
}

function processTree(rootPid, procs, children) {
  const list = [];
  const walk = (pid, depth) => {
    const p = procs.get(pid);
    if (!p) return;
    list.push({ ...p, depth });
    for (const c of children.get(pid) || []) walk(c, depth + 1);
  };
  walk(rootPid, 0);
  return list;
}

function isClaudeCommand(command) {
  const first = command.split(' ')[0];
  if (/--claude-in-chrome-mcp|\bmcp serve\b/.test(command)) return false;
  return path.basename(first) === 'claude' || /@anthropic-ai\/claude-code\/cli(\.m?js)?\b/.test(command);
}

function shortCommand(command) {
  const [first, ...rest] = command.split(' ');
  const s = [path.basename(first), ...rest].join(' ');
  return s.length > 180 ? s.slice(0, 177) + '…' : s;
}

const cwdCache = new Map();
async function cwdOf(pid, start) {
  const key = `${pid}:${start}`;
  if (cwdCache.has(key)) return cwdCache.get(key);
  let cwd = null;
  if (process.platform === 'linux') {
    try { cwd = await fsp.readlink(`/proc/${pid}/cwd`); } catch {}
  } else {
    const out = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = out.split('\n').find((l) => l.startsWith('n'));
    cwd = line ? line.slice(1) : null;
  }
  cwdCache.set(key, cwd);
  return cwd;
}

// ---------------------------------------------------------------- transcripts

const NOISE_TAGS = /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-caveat)>[\s\S]*?<\/\1>/g;

function cleanUserText(s) {
  return s.replace(NOISE_TAGS, '').replace(/<\/?[a-z][a-z0-9_-]*>/g, '').trim();
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

function clip(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function toolSummary(name, input = {}) {
  const firstLine = (s) => String(s).split('\n')[0];
  const label =
    input.description ||
    input.file_path || input.notebook_path || input.path ||
    input.pattern || input.url || input.query || input.skill ||
    (input.prompt && firstLine(input.prompt)) ||
    (input.command && firstLine(input.command)) ||
    (input.todos && `${input.todos.length} todos`) || '';
  const detail = input.command && input.command !== label ? input.command : '';
  return { label: clip(label, 200), detail: clip(detail, 600) };
}

class Transcript {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.leftover = Buffer.alloc(0);
    this.seq = 0;
    this.events = [];
    this.title = null;
    this.firstPrompt = null;
    this.lastPrompt = null;
    this.model = null;
    this.outputTokens = 0;
    this.contextTokens = 0;
    this.msgTokens = new Map();
    this.toolNames = new Map();
    this.pending = new Map();
    this.lastToolUse = null;
    this.lastEventAt = null;
    this.mtime = 0;
    this.errors = 0;
    this.toolCounts = new Map();
  }

  async update() {
    let st;
    try { st = await fsp.stat(this.file); } catch { return; }
    this.mtime = st.mtimeMs;
    if (st.size < this.offset) Object.assign(this, new Transcript(this.file));
    if (st.size === this.offset) return;
    let start = this.offset;
    let skipFirst = false;
    if (start === 0 && st.size > MAX_INITIAL_READ) { start = st.size - MAX_INITIAL_READ; skipFirst = true; }
    const fh = await fsp.open(this.file, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      this.offset = st.size;
      let data = Buffer.concat([this.leftover, buf]);
      let nl;
      let first = true;
      while ((nl = data.indexOf(0x0a)) !== -1) {
        const line = data.subarray(0, nl);
        data = data.subarray(nl + 1);
        if (first && skipFirst) { first = false; continue; }
        first = false;
        if (line.length) this.ingest(line.toString('utf8'));
      }
      this.leftover = Buffer.from(data);
    } finally {
      await fh.close();
    }
  }

  push(ev) {
    ev.seq = ++this.seq;
    this.events.push(ev);
    if (this.events.length > LOG_RING) this.events.shift();
  }

  ingest(line) {
    let d;
    try { d = JSON.parse(line); } catch { return; }
    const ts = d.timestamp ? Date.parse(d.timestamp) : null;
    if (ts) this.lastEventAt = ts;
    const side = d.isSidechain ? true : undefined;
    switch (d.type) {
      case 'ai-title': if (d.aiTitle) this.title = d.aiTitle; break;
      case 'custom-title': if (d.customTitle) this.title = d.customTitle; break;
      case 'summary': if (d.summary && !this.title) this.title = d.summary; break;
      case 'last-prompt': if (d.lastPrompt) this.lastPrompt = d.lastPrompt; break;
      case 'system': {
        const text = clip(cleanUserText(typeof d.content === 'string' ? d.content : d.subtype || ''), 600);
        if (text) this.push({ kind: 'system', ts, text, level: d.level, side });
        break;
      }
      case 'user': {
        if (d.isMeta) break;
        const c = d.message && d.message.content;
        if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'tool_result') {
              const name = this.toolNames.get(b.tool_use_id) || 'tool';
              this.pending.delete(b.tool_use_id);
              if (b.is_error) this.errors++;
              this.push({ kind: 'result', ts, id: b.tool_use_id, tool: name, error: !!b.is_error, text: clip(blockText(b.content), 800), side });
            }
          }
        }
        const text = cleanUserText(blockText(c));
        if (text && !(Array.isArray(c) && c.some((b) => b.type === 'tool_result'))) {
          if (!this.firstPrompt) this.firstPrompt = clip(text, 300);
          if (!side) {
            this.lastPrompt = clip(text, 300);
            // A new turn: tools left without a result were interrupted.
            this.pending.clear();
          }
          this.push({ kind: 'prompt', ts, text: clip(text, 2000), side });
        }
        break;
      }
      case 'assistant': {
        const m = d.message || {};
        if (m.model && m.model !== '<synthetic>') this.model = m.model;
        const u = m.usage;
        if (u && m.id) {
          const prev = this.msgTokens.get(m.id) || 0;
          const outTok = u.output_tokens || 0;
          if (outTok > prev) { this.outputTokens += outTok - prev; this.msgTokens.set(m.id, outTok); }
          if (!side) this.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === 'text' && b.text && b.text.trim()) {
            this.push({ kind: 'text', ts, text: clip(b.text.trim(), 4000), side });
          } else if (b.type === 'tool_use') {
            const { label, detail } = toolSummary(b.name, b.input);
            this.toolNames.set(b.id, b.name);
            this.toolCounts.set(b.name, (this.toolCounts.get(b.name) || 0) + 1);
            const t = { name: b.name, label, detail, ts };
            this.pending.set(b.id, t);
            if (!side) this.lastToolUse = t;
            this.push({ kind: 'tool', ts, id: b.id, tool: b.name, text: label, detail, side });
          }
        }
        break;
      }
    }
  }

  eventsAfter(seq) {
    return this.events.filter((e) => e.seq > seq);
  }

  // Compact activity feed for the flow view.
  flow(now) {
    return {
      recent: this.events.slice(-FLOW_RECENT).map((e) => ({
        seq: e.seq, kind: e.kind, ts: e.ts, tool: e.tool, error: e.error, side: e.side,
        label: e.kind === 'tool' ? clip(e.text, 80) : undefined,
      })),
      rate: this.events.filter((e) => e.ts && now - e.ts < 60000 && e.kind !== 'system').length,
      toolCounts: Object.fromEntries(this.toolCounts),
      pendingTools: [...this.pending.values()].map((p) => p.name),
    };
  }
}

const NO_FLOW = { recent: [], rate: 0, toolCounts: {}, pendingTools: [] };

const transcripts = new Map(); // file -> Transcript
const TRANSCRIPT_TTL_MS = 10 * 60 * 1000;
function transcriptFor(file) {
  if (!transcripts.has(file)) transcripts.set(file, new Transcript(file));
  const t = transcripts.get(file);
  t.lastUsed = Date.now();
  return t;
}

const transcriptPathCache = new Map(); // sessionId -> file
async function findTranscript(sessionId, cwd) {
  const cached = transcriptPathCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  const candidates = [];
  if (cwd) candidates.push(path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`));
  for (const c of candidates) if (fs.existsSync(c)) { transcriptPathCache.set(sessionId, c); return c; }
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch {}
  for (const dir of dirs) {
    const f = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) { transcriptPathCache.set(sessionId, f); return f; }
  }
  return null;
}

async function subagentsOf(transcriptFile) {
  const dir = path.join(transcriptFile.replace(/\.jsonl$/, ''), 'subagents');
  let files;
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const result = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const t = transcriptFor(full);
    await t.update();
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(full.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
    result.push({
      id: f.replace(/\.jsonl$/, ''),
      type: meta.agentType || meta.subagent_type || null,
      title: meta.description || t.title || t.firstPrompt || f,
      lastEventAt: t.lastEventAt || t.mtime,
      mtime: t.mtime,
      outputTokens: t.outputTokens,
      lastTool: t.lastToolUse,
      pendingTools: t.pending.size,
      logSeq: t.seq,
    });
  }
  return result.sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------- snapshot

const history = new Map(); // agent id -> [[t, cpu, rss], ...]
const agentIndex = new Map(); // agent id -> { transcript file }

function pushHistory(id, t, cpu, rss) {
  if (!history.has(id)) history.set(id, []);
  const h = history.get(id);
  h.push([t, Math.round(cpu * 10) / 10, rss]);
  if (h.length > HISTORY_SAMPLES) h.shift();
  return h;
}

function mapStatus(raw, alive) {
  if (!alive) return 'exited';
  if (!raw) return 'running';
  if (raw === 'busy') return 'working';
  if (raw === 'idle') return 'idle';
  if (/wait|permission|input|blocked/i.test(raw)) return 'waiting';
  return raw;
}

function activityFor(status, t) {
  if (status === 'exited') return { label: 'Process exited', tool: null };
  if (!t) return { label: status === 'idle' ? 'Waiting for input' : 'Running', tool: null };
  const pending = [...t.pending.values()].pop();
  if (status === 'working' && pending) return { label: pending.label || pending.name, detail: pending.detail, tool: pending.name, since: pending.ts };
  if (status === 'working') {
    const last = t.events[t.events.length - 1];
    return { label: last && last.kind === 'text' ? 'Responding' : 'Thinking', tool: null, since: last && last.ts };
  }
  if (status === 'waiting') return { label: 'Needs your input', tool: null };
  return { label: 'Waiting for input', tool: null };
}

let lastSnapshot = null;

async function buildSnapshot() {
  const now = Date.now();
  const { procs, children } = await sampleProcesses();

  let files = [];
  try { files = (await fsp.readdir(SESSIONS_DIR)).filter((f) => /^\d+\.json$/.test(f)); } catch {}

  const agents = [];
  const trackedPids = new Set();
  const liveIds = new Set();

  for (const f of files) {
    let s;
    try { s = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8')); } catch { continue; }
    if (!s.sessionId || !s.pid) continue;
    const proc = procs.get(s.pid);
    // Reject a recycled pid: the real process started before the session did.
    const alive = !!proc && (!s.startedAt || proc.start <= s.startedAt + 5000);
    if (!alive && now - (s.updatedAt || s.startedAt || 0) > EXITED_VISIBLE_MS) continue;
    if (alive) trackedPids.add(s.pid);

    const file = await findTranscript(s.sessionId, s.cwd);
    const t = file ? transcriptFor(file) : null;
    if (t) await t.update();
    const status = mapStatus(s.status, alive);

    const tree = alive ? processTree(s.pid, procs, children) : [];
    const cpu = tree.reduce((a, p) => a + p.cpu, 0);
    const rss = tree.reduce((a, p) => a + p.rss, 0);
    const id = s.sessionId;
    liveIds.add(id);
    agentIndex.set(id, { file });
    const hist = alive ? pushHistory(id, now, cpu, rss) : history.get(id) || [];

    agents.push({
      id,
      tracked: true,
      pid: s.pid,
      sessionId: s.sessionId,
      name: s.name || null,
      title: (t && t.title) || s.name || path.basename(s.cwd || '') || s.sessionId,
      cwd: s.cwd,
      kind: s.kind || null,
      entrypoint: s.entrypoint || null,
      version: s.version || null,
      status,
      rawStatus: s.status || null,
      startedAt: s.startedAt || (proc && proc.start) || null,
      statusSince: s.statusUpdatedAt || s.updatedAt || null,
      activity: activityFor(status, t),
      lastPrompt: t ? t.lastPrompt : null,
      model: t ? t.model : null,
      outputTokens: t ? t.outputTokens : 0,
      contextTokens: t ? t.contextTokens : 0,
      errors: t ? t.errors : 0,
      lastEventAt: t ? t.lastEventAt : null,
      logSeq: t ? t.seq : 0,
      hasTranscript: !!t,
      cpu,
      rss,
      processes: tree.slice(0, MAX_PROCS_PER_AGENT).map((p) => ({ pid: p.pid, depth: p.depth, cpu: Math.round(p.cpu * 10) / 10, rss: p.rss, command: shortCommand(p.command) })),
      processCount: tree.length,
      history: hist,
      subagents: file ? await subagentsOf(file) : [],
      ...(t ? t.flow(now) : NO_FLOW),
    });
  }

  // Claude processes with no session file (older versions, headless -p runs, etc.)
  const trackedTrees = new Set();
  for (const pid of trackedPids) for (const p of processTree(pid, procs, children)) trackedTrees.add(p.pid);
  for (const p of procs.values()) {
    if (trackedTrees.has(p.pid) || !isClaudeCommand(p.command)) continue;
    const parent = procs.get(p.ppid);
    if (parent && isClaudeCommand(parent.command)) continue;
    const id = `pid-${p.pid}-${p.start}`;
    const tree = processTree(p.pid, procs, children);
    const cpu = tree.reduce((a, x) => a + x.cpu, 0);
    const rss = tree.reduce((a, x) => a + x.rss, 0);
    const cwd = await cwdOf(p.pid, p.start);
    liveIds.add(id);
    agentIndex.set(id, { file: null });
    agents.push({
      id,
      tracked: false,
      pid: p.pid,
      sessionId: null,
      name: null,
      title: cwd ? path.basename(cwd) : `claude (pid ${p.pid})`,
      cwd,
      kind: /\s(-p|--print)\b/.test(p.command) ? 'headless' : null,
      entrypoint: null,
      version: null,
      status: 'running',
      rawStatus: null,
      startedAt: p.start,
      statusSince: null,
      activity: { label: 'No session file, so only process stats are available', tool: null },
      lastPrompt: null, model: null, outputTokens: 0, contextTokens: 0, errors: 0, lastEventAt: null, logSeq: 0,
      hasTranscript: false,
      cpu, rss,
      processes: tree.slice(0, MAX_PROCS_PER_AGENT).map((x) => ({ pid: x.pid, depth: x.depth, cpu: Math.round(x.cpu * 10) / 10, rss: x.rss, command: shortCommand(x.command) })),
      processCount: tree.length,
      history: pushHistory(id, now, cpu, rss),
      subagents: [],
      ...NO_FLOW,
    });
  }

  for (const id of history.keys()) if (!liveIds.has(id)) history.delete(id);
  for (const [file, t] of transcripts) if (now - t.lastUsed > TRANSCRIPT_TTL_MS) transcripts.delete(file);
  for (const id of agentIndex.keys()) if (!liveIds.has(id)) agentIndex.delete(id);

  const order = { waiting: 0, working: 1, running: 2, idle: 3, exited: 4 };
  agents.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || (b.startedAt || 0) - (a.startedAt || 0));

  const live = agents.filter((a) => a.status !== 'exited');
  return {
    now,
    host: os.hostname(),
    home: os.homedir(),
    historySamples: HISTORY_SAMPLES,
    platform: process.platform,
    cpus: os.cpus().length,
    totalMem: os.totalmem(),
    tickMs: TICK_MS,
    totals: {
      live: live.length,
      working: live.filter((a) => a.status === 'working').length,
      waiting: live.filter((a) => a.status === 'waiting').length,
      idle: live.filter((a) => a.status === 'idle').length,
      cpu: live.reduce((s, a) => s + a.cpu, 0),
      rss: live.reduce((s, a) => s + a.rss, 0),
      outputTokens: agents.reduce((s, a) => s + a.outputTokens, 0),
    },
    agents,
  };
}

// ---------------------------------------------------------------- http

const clients = new Set();
let inFlight = null;

// Overlapping callers share the tick already running.
function tick() {
  if (!inFlight) {
    inFlight = (async () => {
      try {
        lastSnapshot = await buildSnapshot();
        const payload = `event: snapshot\ndata: ${JSON.stringify(lastSnapshot)}\n\n`;
        for (const res of clients) res.write(payload);
      } catch (err) {
        console.error('tick failed:', err);
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  // Transcripts are sensitive: refuse foreign Host headers (DNS rebinding).
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) { res.writeHead(403); return res.end('forbidden'); }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }

  if (url.pathname === '/api/snapshot') {
    if (!lastSnapshot) await tick();
    return sendJson(res, 200, lastSnapshot);
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`retry: 3000\n\n`);
    if (lastSnapshot) res.write(`event: snapshot\ndata: ${JSON.stringify(lastSnapshot)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const m = url.pathname.match(/^\/api\/agents\/([^/]+)\/log$/);
  if (m) {
    const entry = agentIndex.get(decodeURIComponent(m[1]));
    if (!entry || !entry.file) return sendJson(res, 404, { error: 'no transcript for this agent' });
    let file = entry.file;
    const sub = url.searchParams.get('sub');
    if (sub) {
      if (!/^[\w.-]+$/.test(sub)) return sendJson(res, 400, { error: 'bad subagent id' });
      file = path.join(entry.file.replace(/\.jsonl$/, ''), 'subagents', `${sub}.jsonl`);
    }
    const t = transcriptFor(file);
    await t.update();
    const after = Number(url.searchParams.get('after')) || 0;
    // A reset transcript restarts its sequence; tell the client to start over.
    const reset = after > t.seq;
    return sendJson(res, 200, { seq: t.seq, reset, events: t.eventsAfter(reset ? 0 : after) });
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Agent monitor running at http://localhost:${PORT}`);
  console.log(`Reading ${SESSIONS_DIR} and ${PROJECTS_DIR}`);
});

tick();
setInterval(tick, TICK_MS);
