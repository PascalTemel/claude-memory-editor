# claude-memory-editor

A tiny, **zero-dependency** local web app to browse and edit all your
[Claude Code](https://claude.ai/code) memory files in one place:

- `CLAUDE.md` / `CLAUDE.local.md` across every project
- the global `~/.claude/CLAUDE.md`
- auto-memory files under `~/.claude/projects/<slug>/memory/*.md`

It scans your machine, lists every memory file grouped by project, and gives you
a clean editor with markdown preview, save-on-`⌘S`, and an automatic backup
before every write.

## Quick start

No install required — run it straight from GitHub:

```bash
npx github:PascalTemel/claude-memory-editor
```

This scans `~/.claude` (global + auto-memory) **and** the current directory, then
opens the editor in your browser.

Prefer a shorter command? Install it once, then call `claude-memory-editor` (or `cme`):

```bash
npm install -g github:PascalTemel/claude-memory-editor
```

Scan all your projects instead:

```bash
claude-memory-editor ~/dev
```

Or your whole home directory:

```bash
claude-memory-editor ~
```

## Options

```
claude-memory-editor [roots...] [options]

  roots                 Directories to scan. Default: ~/.claude + current dir.
                        (~/.claude is always added unless --no-claude-home.)

  -p, --port <n>        Port (default 4321, or $PORT).
      --host <addr>     Bind host (default 127.0.0.1, i.e. localhost only).
      --root <dir>      Add a scan root (repeatable).
      --no-claude-home  Don't auto-include ~/.claude.
      --no-backup       Don't write a backup before each save.
      --no-open         Don't open the browser automatically.
  -h, --help            Help.
  -v, --version         Version.

Env:
  CLAUDE_MEMORY_ROOTS   Extra roots, separated by your OS path delimiter.
```

## What it considers a "memory file"

| Type | Matched | Shown as |
|------|---------|----------|
| Project memory | files named `CLAUDE.md` or `CLAUDE.local.md` | `md` badge |
| Auto-memory | `*.md` under a `memory/` dir inside a `.claude/` path | `mem` badge |

Discovery skips noisy/duplicate trees by default: `node_modules`, `.git`,
`dist`, `build`, `vendor`, git-worktree pools (`.worktrees`, `worktrees`,
`*-worktrees`), `.environments`, and Claude-internal dirs like `sessions` and
`plugins`. Symlinks are followed safely (loops are de-duplicated by real path).
Edit the `DEFAULT_IGNORES` set at the top of `cli.js` to change this.

## Safety

- Binds to **localhost only** by default — not exposed to your network.
- Only files discovered by the scan can be read or written (no path traversal).
- Before every save it copies the current file to
  `~/.claude-memory-editor/backups/<sanitized-path>.<timestamp>.bak`
  (disable with `--no-backup`).

## License

MIT
