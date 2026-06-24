#!/usr/bin/env node
'use strict';

/*
 * claude-memory-editor
 * A tiny, zero-dependency local web app to browse and edit Claude Code memory files:
 *   - CLAUDE.md / CLAUDE.local.md across your projects
 *   - the global ~/.claude/CLAUDE.md
 *   - auto-memory files under ~/.claude/projects/<slug>/memory/*.md
 *
 * Run:   npx claude-memory-editor [roots...] [options]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PKG = require('./package.json');
const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, '.claude');

// Directories never descended into during discovery.
const DEFAULT_IGNORES = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.angular', '.cache', 'coverage', 'tmp', '.tmp',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.svn', '.hg',
  // big / duplicate trees that are full repo copies
  '.worktrees', 'worktrees', '.environments',
  // claude internal dirs that never hold editable memory
  'sessions', 'shell-snapshots', 'image-cache', 'paste-cache',
  'file-history', 'session-env', 'downloads', 'debug', 'backups', 'plugins',
]);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    PKG.name + ' v' + PKG.version + '\n\n' +
    'Browse and edit every Claude Code memory file in a small web UI.\n\n' +
    'Usage:\n' +
    '  npx ' + PKG.name + ' [roots...] [options]\n\n' +
    'Arguments:\n' +
    '  roots                 One or more directories to scan for memory files.\n' +
    '                        Default: ~/.claude and the current directory.\n' +
    '                        (~/.claude is always included unless --no-claude-home.)\n\n' +
    'Options:\n' +
    '  -p, --port <n>        Port to listen on (default 4321, or $PORT).\n' +
    '      --host <addr>     Host to bind (default 127.0.0.1).\n' +
    '      --root <dir>      Add a scan root (repeatable).\n' +
    '      --no-claude-home  Do not auto-include ~/.claude.\n' +
    '      --no-backup       Do not write a backup before each save.\n' +
    '      --no-open         Do not open the browser automatically.\n' +
    '  -h, --help            Show this help.\n' +
    '  -v, --version         Show version.\n\n' +
    'Env:\n' +
    '  CLAUDE_MEMORY_ROOTS   Extra roots, separated by "' + path.delimiter + '".\n\n' +
    'Examples:\n' +
    '  npx ' + PKG.name + '                 # ~/.claude + current dir\n' +
    '  npx ' + PKG.name + ' ~/dev           # scan all projects under ~/dev\n' +
    '  npx ' + PKG.name + ' ~ --port 8080   # scan your whole home dir\n'
  );
}

function parseArgs(argv) {
  const opts = {
    roots: [],
    port: Number(process.env.PORT) || 4321,
    host: '127.0.0.1',
    open: true,
    backup: true,
    claudeHome: true,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--root') opts.roots.push(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--no-backup') opts.backup = false;
    else if (a === '--no-claude-home') opts.claudeHome = false;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--version' || a === '-v') { process.stdout.write(PKG.version + '\n'); process.exit(0); }
    else if (a.startsWith('-')) { process.stderr.write('Unknown option: ' + a + '\n'); process.exit(1); }
    else positional.push(a);
  }
  opts.roots.push(...positional);
  if (process.env.CLAUDE_MEMORY_ROOTS) {
    opts.roots.push(...process.env.CLAUDE_MEMORY_ROOTS.split(path.delimiter).filter(Boolean));
  }
  if (opts.roots.length === 0) opts.roots.push(process.cwd());
  if (opts.claudeHome) opts.roots.push(CLAUDE_HOME);

  // Resolve, expand ~, keep existing dirs, dedupe by realpath.
  const seen = new Set();
  const resolved = [];
  for (let r of opts.roots) {
    if (r === '~') r = HOME;
    else if (r.startsWith('~' + path.sep)) r = path.join(HOME, r.slice(2));
    const abs = path.resolve(r);
    let real;
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
      real = fs.realpathSync(abs);
    } catch (e) { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    resolved.push(abs);
  }
  opts.roots = resolved;
  return opts;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function categorize(abs, name) {
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') return 'project';
  if (name.endsWith('.md')) {
    const segs = abs.split(path.sep);
    if (segs.includes('memory') && abs.includes(path.sep + '.claude' + path.sep)) return 'memory';
  }
  return null;
}

function ownerRoot(abs, roots) {
  let best = null;
  for (const r of roots) {
    if (abs === r || abs.startsWith(r + path.sep)) {
      if (!best || r.length > best.length) best = r;
    }
  }
  return best;
}

function prettySlug(slug) {
  const cleaned = slug.replace(/^-+/, '').replace(/-/g, '/');
  return cleaned || slug;
}

function groupFor(abs, cat, roots) {
  if (abs === path.join(CLAUDE_HOME, 'CLAUDE.md')) {
    return { key: '00-global', label: 'Global memory' };
  }
  if (cat === 'memory') {
    const segs = abs.split(path.sep);
    const pi = segs.indexOf('projects');
    const slug = pi >= 0 && segs[pi + 1] ? segs[pi + 1] : 'memory';
    return { key: '01-mem-' + slug, label: 'Memory · ' + prettySlug(slug) };
  }
  const root = ownerRoot(abs, roots);
  if (root) {
    const rel = path.relative(root, abs);
    const seg = rel.split(path.sep)[0];
    const top = (seg && seg.indexOf('CLAUDE') !== 0) ? seg : path.basename(root);
    return { key: '10-' + top + '|' + root, label: top };
  }
  return { key: '99', label: 'Other' };
}

function fileInfo(abs, roots) {
  const name = path.basename(abs);
  const cat = categorize(abs, name);
  if (!cat) return null;
  let st;
  try { st = fs.statSync(abs); } catch (e) { return null; }
  const g = groupFor(abs, cat, roots);
  const root = ownerRoot(abs, roots);
  return {
    path: abs,
    name: name,
    rel: root ? path.relative(root, abs) : abs,
    category: cat,
    group: g.label,
    groupKey: g.key,
    size: st.size,
    mtime: st.mtimeMs,
  };
}

function sortFiles(files) {
  files.sort((a, b) => {
    if (a.groupKey !== b.groupKey) return a.groupKey < b.groupKey ? -1 : 1;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
  return files;
}

function scan(roots) {
  const found = [];
  const visited = new Set();

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (err) { continue; }
      }
      if (isDir) {
        if (DEFAULT_IGNORES.has(e.name) || /-worktrees$/.test(e.name)) continue;
        let real;
        try { real = fs.realpathSync(full); } catch (err) { continue; }
        if (visited.has(real)) continue;
        visited.add(real);
        walk(full);
      } else if (isFile) {
        const info = fileInfo(full, roots);
        if (info) found.push(info);
      }
    }
  }

  for (const r of roots) walk(r);
  sortFiles(found);

  const allow = new Set(found.map((f) => f.path));
  return { files: found, allow };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

const BACKUP_DIR = path.join(HOME, '.claude-memory-editor', 'backups');

function backupExisting(abs) {
  if (!fs.existsSync(abs)) return null;
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = abs.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+/, '');
  const dest = path.join(BACKUP_DIR, safe + '.' + stamp + '.bak');
  try {
    fs.copyFileSync(abs, dest);
    return dest;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function makeServer(opts) {
  let cache = null;
  const trash = new Map(); // path -> { content, backup } for undo of deletes
  function ensure(rescan) {
    if (!cache || rescan) cache = scan(opts.roots);
    return cache;
  }

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); return; }
        data += c;
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  return http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
    catch (e) { return json(res, 400, { error: 'bad url' }); }

    try {
      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }

      if (req.method === 'GET' && u.pathname === '/api/files') {
        const c = ensure(u.searchParams.get('rescan') === '1');
        return json(res, 200, {
          roots: opts.roots,
          count: c.files.length,
          backup: opts.backup,
          files: c.files,
        });
      }

      if (req.method === 'GET' && u.pathname === '/api/file') {
        const p = u.searchParams.get('path') || '';
        const c = ensure(false);
        if (!c.allow.has(p)) return json(res, 403, { error: 'not an editable memory file' });
        let content, st;
        try { content = fs.readFileSync(p, 'utf8'); st = fs.statSync(p); }
        catch (e) { return json(res, 500, { error: String(e.message || e) }); }
        return json(res, 200, { path: p, content, size: st.size, mtime: st.mtimeMs });
      }

      if (req.method === 'POST' && u.pathname === '/api/file') {
        const raw = await readBody(req);
        let payload;
        try { payload = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'invalid json' }); }
        const p = payload && payload.path;
        const content = payload && typeof payload.content === 'string' ? payload.content : null;
        if (!p || content === null) return json(res, 400, { error: 'path and content required' });
        const c = ensure(false);
        if (!c.allow.has(p)) return json(res, 403, { error: 'not an editable memory file' });
        let backup = null;
        if (opts.backup) backup = backupExisting(p);
        try { fs.writeFileSync(p, content, 'utf8'); }
        catch (e) { return json(res, 500, { error: String(e.message || e) }); }
        const st = fs.statSync(p);
        // refresh size/mtime in cache
        const entry = c.files.find((f) => f.path === p);
        if (entry) { entry.size = st.size; entry.mtime = st.mtimeMs; }
        return json(res, 200, { ok: true, size: st.size, mtime: st.mtimeMs, backup });
      }

      if (req.method === 'POST' && u.pathname === '/api/delete') {
        const raw = await readBody(req);
        let payload;
        try { payload = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'invalid json' }); }
        const p = payload && payload.path;
        if (!p) return json(res, 400, { error: 'path required' });
        const c = ensure(false);
        if (!c.allow.has(p)) return json(res, 403, { error: 'not an editable memory file' });
        let content;
        try { content = fs.readFileSync(p, 'utf8'); }
        catch (e) { return json(res, 500, { error: String(e.message || e) }); }
        const backup = backupExisting(p); // always back up deletes, even with --no-backup
        try { fs.unlinkSync(p); }
        catch (e) { return json(res, 500, { error: String(e.message || e) }); }
        trash.set(p, { content, backup });
        c.allow.delete(p);
        const idx = c.files.findIndex((f) => f.path === p);
        if (idx >= 0) c.files.splice(idx, 1);
        return json(res, 200, { ok: true, path: p, backup });
      }

      if (req.method === 'POST' && u.pathname === '/api/restore') {
        const raw = await readBody(req);
        let payload;
        try { payload = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'invalid json' }); }
        const p = payload && payload.path;
        if (!p || !trash.has(p)) return json(res, 404, { error: 'nothing to restore for that path' });
        const entry = trash.get(p);
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, entry.content, 'utf8');
        } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
        trash.delete(p);
        const c = ensure(false);
        c.allow.add(p);
        const info = fileInfo(p, opts.roots);
        if (info && !c.files.some((f) => f.path === p)) {
          c.files.push(info);
          sortFiles(c.files);
        }
        return json(res, 200, { ok: true, path: p });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: String((err && err.message) || err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.roots.length === 0) {
    process.stderr.write('No existing scan roots. Pass a directory, e.g. `npx ' + PKG.name + ' ~/dev`.\n');
    process.exit(1);
  }
  const server = makeServer(opts);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write('Port ' + opts.port + ' is in use. Try --port <n>.\n');
      process.exit(1);
    }
    throw e;
  });
  server.listen(opts.port, opts.host, () => {
    const url = 'http://' + (opts.host === '0.0.0.0' ? 'localhost' : opts.host) + ':' + opts.port + '/';
    const initial = scan(opts.roots);
    process.stdout.write('\n  ' + PKG.name + ' v' + PKG.version + '\n');
    process.stdout.write('  Scanning roots:\n');
    for (const r of opts.roots) process.stdout.write('    - ' + r + '\n');
    process.stdout.write('  Found ' + initial.files.length + ' memory file(s).\n');
    process.stdout.write('  Backups: ' + (opts.backup ? BACKUP_DIR : 'disabled') + '\n\n');
    process.stdout.write('  ▶ ' + url + '\n\n  Press Ctrl+C to stop.\n\n');
    if (opts.open) openBrowser(url);
  });
}

// ---------------------------------------------------------------------------
// Embedded single-page UI
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Memory Editor</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1d212b; --border: #2a2f3a;
    --text: #e6e8ec; --muted: #8b93a3; --accent: #c98a4b; --accent2: #6ea8fe;
    --green: #4cc38a; --danger: #e5645a; --shadow: 0 1px 0 rgba(255,255,255,.03);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--text); background: var(--bg); display: flex; flex-direction: column; height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 14px; padding: 10px 16px;
    background: var(--panel); border-bottom: 1px solid var(--border);
  }
  header .brand { font-weight: 650; letter-spacing: .2px; }
  header .brand b { color: var(--accent); }
  header .count { color: var(--muted); font-size: 12px; }
  header .spacer { flex: 1; }
  button {
    font: inherit; color: var(--text); background: var(--panel2);
    border: 1px solid var(--border); border-radius: 7px; padding: 6px 12px;
    cursor: pointer;
  }
  button:hover { border-color: #3a4150; }
  button.primary { background: var(--accent); color: #1a1206; border-color: var(--accent); font-weight: 600; }
  button.primary:disabled { opacity: .45; cursor: default; }
  button.ghost { background: transparent; }
  main { flex: 1; display: flex; min-height: 0; }
  aside {
    width: 340px; min-width: 240px; max-width: 50%; background: var(--panel);
    border-right: 1px solid var(--border); display: flex; flex-direction: column;
  }
  .search { padding: 10px; border-bottom: 1px solid var(--border); }
  .search input {
    width: 100%; padding: 8px 10px; font: inherit; color: var(--text);
    background: var(--bg); border: 1px solid var(--border); border-radius: 7px; outline: none;
  }
  .search input:focus { border-color: var(--accent2); }
  .list { overflow: auto; flex: 1; padding: 6px 0 20px; }
  .grp { display: flex; align-items: center; gap: 7px; padding: 11px 12px 5px;
    color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .6px;
    position: sticky; top: 0; background: var(--panel); cursor: pointer; user-select: none; }
  .grp:hover { color: var(--text); }
  .grp .chev { font-size: 9px; line-height: 1; transition: transform .12s ease; transform: rotate(90deg); }
  .grp.collapsed .chev { transform: rotate(0deg); }
  .grp .gname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grp .gcount { font-size: 10px; opacity: .7; }
  .srow { display: flex; gap: 6px; margin-top: 8px; }
  .mini { font-size: 11px; padding: 3px 8px; border-radius: 6px; background: transparent; color: var(--muted); }
  .mini:hover { color: var(--text); border-color: #3a4150; }
  .item {
    display: flex; align-items: center; gap: 8px; padding: 7px 14px; cursor: pointer;
    border-left: 2px solid transparent;
  }
  .item:hover { background: var(--panel2); }
  .item.active { background: var(--panel2); border-left-color: var(--accent); }
  .item .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .nm small { color: var(--muted); }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); }
  .badge.memory { color: var(--accent2); border-color: #2c3a55; }
  .badge.project { color: var(--green); border-color: #234634; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; visibility: hidden; }
  .item.dirty .dot { visibility: visible; }
  section.editor { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .ed-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid var(--border); background: var(--panel); }
  .ed-head .pathwrap { min-width: 0; flex: 1; }
  .ed-head .pth { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ed-head .meta { color: var(--muted); font-size: 11px; }
  .ed-body { flex: 1; display: flex; min-height: 0; }
  textarea {
    flex: 1; resize: none; border: 0; outline: none; padding: 16px 18px;
    background: var(--bg); color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.65;
    tab-size: 2;
  }
  .preview { flex: 1; overflow: auto; padding: 16px 22px; background: var(--bg); border-left: 1px solid var(--border); }
  .preview h1,.preview h2,.preview h3 { line-height: 1.25; }
  .preview h1 { font-size: 22px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .preview h2 { font-size: 18px; }
  .preview h3 { font-size: 15px; }
  .preview code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  .preview pre { background: var(--panel2); padding: 12px 14px; border-radius: 8px; overflow: auto; }
  .preview pre code { background: none; padding: 0; }
  .preview a { color: var(--accent2); }
  .preview blockquote { border-left: 3px solid var(--border); margin: 8px 0; padding: 2px 12px; color: var(--muted); }
  .preview table { border-collapse: collapse; }
  .preview td, .preview th { border: 1px solid var(--border); padding: 4px 10px; }
  .empty { flex: 1; display: grid; place-items: center; color: var(--muted); text-align: center; padding: 20px; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    background: var(--panel2); border: 1px solid var(--border); padding: 9px 16px; border-radius: 9px;
    opacity: 0; transition: opacity .2s, transform .2s; pointer-events: none; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(-2px); }
  .toast.ok { border-color: #234634; }
  .toast.err { border-color: #5a2a26; color: #f0b3ad; }
  button.ghost.danger { color: var(--danger); }
  button.ghost.danger:hover { border-color: #5a2a26; }
  .snackbar { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%) translateY(8px);
    display: none; align-items: center; gap: 14px; background: var(--panel2);
    border: 1px solid var(--border); padding: 9px 10px 9px 16px; border-radius: 10px;
    box-shadow: 0 10px 34px rgba(0,0,0,.45); opacity: 0;
    transition: opacity .15s, transform .15s; z-index: 50; }
  .snackbar.show { display: flex; opacity: 1; transform: translateX(-50%) translateY(0); }
  .snackbar .smsg { font-size: 13px; }
  .snackbar .smsg b { color: var(--text); }
  .snackbar button { padding: 4px 12px; }
  .snackbar .undo { background: var(--accent); color: #1a1206; border-color: var(--accent); font-weight: 600; }
  .snackbar .sx { background: transparent; border: 0; color: var(--muted); padding: 4px 8px; font-size: 14px; }
  .kbd { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted);
    border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
  @media (max-width: 720px) { aside { width: 44%; } .preview { display: none; } }
</style>
</head>
<body>
<header>
  <div class="brand">Claude <b>Memory</b> Editor</div>
  <div class="count" id="count"></div>
  <div class="spacer"></div>
  <button class="ghost" id="previewToggle" title="Toggle markdown preview">Preview</button>
  <button class="ghost" id="rescan" title="Re-scan files">Rescan</button>
  <button class="primary" id="save" disabled>Save <span class="kbd">⌘S</span></button>
</header>
<main>
  <aside>
    <div class="search">
      <input id="filter" placeholder="Filter files…  (/ to focus)" autocomplete="off">
      <div class="srow">
        <button class="mini" id="collapseAll" title="Collapse all groups">Collapse all</button>
        <button class="mini" id="expandAll" title="Expand all groups">Expand all</button>
      </div>
    </div>
    <div class="list" id="list"></div>
  </aside>
  <section class="editor">
    <div class="ed-head" id="edhead" style="display:none">
      <div class="pathwrap">
        <div class="pth" id="curpath"></div>
        <div class="meta" id="curmeta"></div>
      </div>
      <button class="ghost" id="revert" title="Discard unsaved changes">Revert</button>
      <button class="ghost danger" id="delete" title="Delete this file (undo available)">Delete</button>
    </div>
    <div class="ed-body" id="edbody">
      <div class="empty" id="empty">Select a memory file on the left to edit it.</div>
    </div>
  </section>
</main>
<div class="toast" id="toast"></div>
<div class="snackbar" id="snack">
  <span class="smsg" id="snackMsg"></span>
  <button class="undo" id="snackUndo">Undo</button>
  <button class="sx" id="snackClose" title="Dismiss">✕</button>
</div>

<script>
(function () {
  "use strict";
  var files = [];
  var current = null;       // file object
  var savedContent = "";    // last-known-on-disk content
  var dirty = false;
  var showPreview = false;
  var collapsed = loadCollapsedState();

  function loadCollapsedState() {
    try { return new Set(JSON.parse(localStorage.getItem("cme.collapsed") || "[]")); }
    catch (e) { return new Set(); }
  }
  function saveCollapsed() {
    try { localStorage.setItem("cme.collapsed", JSON.stringify(Array.from(collapsed))); }
    catch (e) {}
  }

  var el = function (id) { return document.getElementById(id); };
  var listEl = el("list"), edBody = el("edbody"), edHead = el("edhead");

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function toast(msg, kind) {
    var t = el("toast");
    t.textContent = msg;
    t.className = "toast show " + (kind || "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "toast " + (kind || ""); }, 2600);
  }

  function fmtTime(ms) {
    try { return new Date(ms).toLocaleString(); } catch (e) { return ""; }
  }
  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function setDirty(d) {
    dirty = d;
    el("save").disabled = !d || !current;
    var active = listEl.querySelector(".item.active");
    if (active) active.classList.toggle("dirty", d);
  }

  function renderList() {
    var q = el("filter").value.trim().toLowerCase();
    var filtering = q.length > 0;
    var shown = files.filter(function (f) {
      if (!q) return true;
      return (f.rel + " " + f.path + " " + f.group).toLowerCase().indexOf(q) !== -1;
    });
    el("count").textContent = shown.length + " / " + files.length + " files";
    listEl.innerHTML = "";

    var order = [];
    var byGroup = {};
    shown.forEach(function (f) {
      if (!byGroup[f.group]) { byGroup[f.group] = []; order.push(f.group); }
      byGroup[f.group].push(f);
    });

    order.forEach(function (group) {
      var items = byGroup[group];
      var isCollapsed = !filtering && collapsed.has(group);
      var g = document.createElement("div");
      g.className = "grp" + (isCollapsed ? " collapsed" : "");
      g.innerHTML =
        '<span class="chev">▸</span>' +
        '<span class="gname"></span>' +
        '<span class="gcount">' + items.length + "</span>";
      g.querySelector(".gname").textContent = group;
      g.title = (isCollapsed ? "Expand " : "Collapse ") + group;
      g.addEventListener("click", function () {
        if (collapsed.has(group)) collapsed.delete(group);
        else collapsed.add(group);
        saveCollapsed();
        renderList();
      });
      listEl.appendChild(g);
      if (isCollapsed) return;

      items.forEach(function (f) {
        var item = document.createElement("div");
        item.className = "item";
        if (current && current.path === f.path) {
          item.classList.add("active");
          if (dirty) item.classList.add("dirty");
        }
        item.dataset.path = f.path;
        var label = f.category === "memory" ? f.name : f.rel;
        item.innerHTML =
          '<span class="dot"></span>' +
          '<span class="nm">' + escapeHtml(label) + "</span>" +
          '<span class="badge ' + f.category + '">' + (f.category === "memory" ? "mem" : "md") + "</span>";
        item.title = f.path;
        item.addEventListener("click", function () { selectFile(f); });
        listEl.appendChild(item);
      });
    });
  }

  function confirmDiscard() {
    if (!dirty) return true;
    return window.confirm("You have unsaved changes. Discard them?");
  }

  function selectFile(f) {
    if (current && current.path === f.path) return;
    if (!confirmDiscard()) return;
    fetch("/api/file?path=" + encodeURIComponent(f.path))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "err"); return; }
        current = f;
        savedContent = d.content;
        setDirty(false);
        renderEditor(d);
        renderList();
      })
      .catch(function (e) { toast(String(e), "err"); });
  }

  function renderEditor(d) {
    edHead.style.display = "flex";
    el("curpath").textContent = current.path;
    el("curmeta").textContent = current.group + "  ·  " + fmtSize(d.size) + "  ·  modified " + fmtTime(d.mtime);
    edBody.innerHTML = "";
    var ta = document.createElement("textarea");
    ta.id = "ta";
    ta.spellcheck = false;
    ta.value = d.content;
    ta.addEventListener("input", function () {
      setDirty(ta.value !== savedContent);
      if (showPreview) updatePreview();
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        var s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        setDirty(ta.value !== savedContent);
      }
    });
    edBody.appendChild(ta);
    if (showPreview) {
      var pv = document.createElement("div");
      pv.className = "preview";
      pv.id = "preview";
      edBody.appendChild(pv);
      updatePreview();
    }
    ta.focus();
  }

  function updatePreview() {
    var pv = el("preview");
    if (!pv) return;
    var ta = el("ta");
    pv.innerHTML = renderMarkdown(ta ? ta.value : "");
  }

  // Minimal, safe markdown renderer (escapes first).
  function renderMarkdown(src) {
    var lines = escapeHtml(src).split("\\n");
    var out = [], i = 0, inCode = false, listOpen = false;
    function closeList() { if (listOpen) { out.push("</ul>"); listOpen = false; } }
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^\\s*\`\`\`/.test(ln)) {
        if (!inCode) { closeList(); out.push("<pre><code>"); inCode = true; }
        else { out.push("</code></pre>"); inCode = false; }
        continue;
      }
      if (inCode) { out.push(ln + "\\n"); continue; }
      if (/^\\s*$/.test(ln)) { closeList(); continue; }
      var h = ln.match(/^(#{1,6})\\s+(.*)$/);
      if (h) { closeList(); out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); continue; }
      if (/^\\s*[-*+]\\s+/.test(ln)) {
        if (!listOpen) { out.push("<ul>"); listOpen = true; }
        out.push("<li>" + inline(ln.replace(/^\\s*[-*+]\\s+/, "")) + "</li>");
        continue;
      }
      if (/^\\s*&gt;\\s?/.test(ln)) { closeList(); out.push("<blockquote>" + inline(ln.replace(/^\\s*&gt;\\s?/, "")) + "</blockquote>"); continue; }
      if (/^\\s*(-{3,}|\\*{3,})\\s*$/.test(ln)) { closeList(); out.push("<hr>"); continue; }
      closeList();
      out.push("<p>" + inline(ln) + "</p>");
    }
    if (inCode) out.push("</code></pre>");
    closeList();
    return out.join("\\n");
  }
  function inline(s) {
    return s
      .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
      .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\\*([^*]+)\\*/g, "$1<em>$2</em>")
      .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function save() {
    if (!current || !dirty) return;
    var ta = el("ta");
    var content = ta.value;
    el("save").disabled = true;
    fetch("/api/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: current.path, content: content }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "err"); el("save").disabled = false; return; }
        savedContent = content;
        setDirty(false);
        el("curmeta").textContent = current.group + "  ·  " + fmtSize(d.size) + "  ·  saved " + fmtTime(d.mtime);
        toast("Saved" + (d.backup ? " (backup written)" : ""), "ok");
      })
      .catch(function (e) { toast(String(e), "err"); el("save").disabled = false; });
  }

  function revert() {
    if (!current) return;
    if (!confirmDiscard()) return;
    var ta = el("ta");
    ta.value = savedContent;
    setDirty(false);
    if (showPreview) updatePreview();
  }

  var undoTimer = null;
  function showUndo(name, path) {
    var m = el("snackMsg");
    m.textContent = "Deleted ";
    var b = document.createElement("b");
    b.textContent = name;
    m.appendChild(b);
    el("snack").classList.add("show");
    el("snackUndo").onclick = function () { hideUndo(); restore(path); };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 12000);
  }
  function hideUndo() {
    clearTimeout(undoTimer);
    el("snack").classList.remove("show");
  }

  function deleteCurrent() {
    if (!current) return;
    var f = current;
    var label = f.category === "memory" ? f.name : f.rel;
    el("delete").disabled = true;
    fetch("/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: f.path }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        el("delete").disabled = false;
        if (d.error) { toast(d.error, "err"); return; }
        current = null;
        savedContent = "";
        setDirty(false);
        edHead.style.display = "none";
        edBody.innerHTML = '<div class="empty">Select a memory file on the left to edit it.</div>';
        load(false);
        showUndo(label, f.path);
      })
      .catch(function (e) { el("delete").disabled = false; toast(String(e), "err"); });
  }

  function restore(path) {
    fetch("/api/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "err"); return; }
        load(false).then(function () {
          var f = files.filter(function (x) { return x.path === path; })[0];
          if (f) selectFile(f);
        });
        toast("Restored", "ok");
      })
      .catch(function (e) { toast(String(e), "err"); });
  }

  function load(rescan) {
    return fetch("/api/files" + (rescan ? "?rescan=1" : ""))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        files = d.files || [];
        renderList();
        if (current) {
          var still = files.filter(function (f) { return f.path === current.path; })[0];
          if (!still) { current = null; edHead.style.display = "none"; edBody.innerHTML = '<div class="empty">File no longer found. Pick another.</div>'; }
        }
        if (rescan) toast("Rescanned · " + files.length + " files", "ok");
      })
      .catch(function (e) { toast(String(e), "err"); });
  }

  // events
  el("save").addEventListener("click", save);
  el("revert").addEventListener("click", revert);
  el("delete").addEventListener("click", deleteCurrent);
  el("snackClose").addEventListener("click", hideUndo);
  el("rescan").addEventListener("click", function () { load(true); });
  el("filter").addEventListener("input", renderList);
  el("collapseAll").addEventListener("click", function () {
    files.forEach(function (f) { collapsed.add(f.group); });
    saveCollapsed();
    renderList();
  });
  el("expandAll").addEventListener("click", function () {
    collapsed.clear();
    saveCollapsed();
    renderList();
  });
  el("previewToggle").addEventListener("click", function () {
    showPreview = !showPreview;
    el("previewToggle").classList.toggle("primary", showPreview);
    if (current) { renderEditor({ content: el("ta") ? el("ta").value : savedContent, size: current.size, mtime: current.mtime }); }
  });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); save(); }
    if (e.key === "/" && document.activeElement.id !== "filter" && document.activeElement.id !== "ta") {
      e.preventDefault(); el("filter").focus();
    }
  });
  window.addEventListener("beforeunload", function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  load(false);
})();
</script>
</body>
</html>`;

main();
