# pixel-office

A pixel-art visual office where your AI coding agents — **Claude Code**, **Codex CLI**,
and **Hermes Agent** — show up as animated characters that walk to their desks, type
when editing files, read when searching, and flag you when they're stuck waiting for
input. Built on top of [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)
(MIT), extended here with two new provider integrations (Hermes, Codex) and multi-provider
support in the runtime so all three can run in the same office at once.

See [`UPSTREAM_README.md`](./UPSTREAM_README.md) for the original project's own
documentation (VS Code extension, layout editor, asset system, etc.) — this file covers
what's specific to this fork: the Hermes and Codex integrations, the `pixel-office`
launcher, and how the pieces fit together.

## Architecture

```
                      ┌─────────────────────┐
                      │   Pixel Office UI   │   http://127.0.0.1:4173
                      │ (browser, WebSocket) │
                      └──────────▲──────────┘
                                 │
                        normalized AgentEvent
                                 │
                POST /api/hooks/:providerId (one Fastify server, one AgentStateStore)
                                 │
                ┌────────────────┼─────────────────┐
                │                │                 │
            claude            hermes             codex
                │                │                 │
        official Claude    pixel-agents-bridge   in-process
        Code hooks API     plugin (Python,       JSONL tailer
        (unmodified)       ~/.hermes/plugins/)   (~/.codex/sessions/**/*.jsonl)
```

One server process, one `AgentStateStore`, one office — every provider's agents render
side by side, each tagged with which CLI they came from. This required a small patch to
the upstream `AgentRuntime`/`HookEventHandler` (previously hardcoded to exactly one
provider) so it now runs one `HookEventHandler` per registered provider, routed by the
`providerId` the wire protocol already carried. See `server/src/agentRuntime.ts`.

## What works with each provider

### Claude Code — unmodified, official integration

Uses the upstream `claudeProvider` exactly as shipped: installs Claude Code's real Hooks
API into `~/.claude/settings.json` on startup, receives `SessionStart/Stop/PreToolUse/
PostToolUse/SubagentStart/SubagentStop/...` events live over HTTP. Nothing about Claude
support was changed by this fork (verified — see Testing below).

### Codex CLI — structured JSONL, in-process tailer

Codex CLI (0.144.1 as tested) has no hooks/plugin API. It does write a structured,
append-only JSONL rollout per session to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
(`session_meta`, `response_item` with `function_call`/`function_call_output`,
`event_msg` with `task_complete`). `server/src/providers/hook/codex/codexTailer.ts`
polls that directory (1.5s interval, byte-offset tracked per file, partial-line safe),
parses new lines, and re-emits them through the exact same `POST /api/hooks/codex`
ingress a real hook script would use. This is reading Codex's own structured session
format, not scraping terminal output.

Limitation: Codex's rollout format never writes an explicit "session ended" record, so
the tailer heuristically closes a session after 10 minutes of no new lines. A real
session end (Ctrl+C, `codex exec` returning) is picked up as soon as it happens if Codex
itself is still writing to the file up to that point; the 10-minute timer only covers the
case where it doesn't.

### Hermes Agent — plugin hooks, future sessions only

Hermes Agent (v0.20.0 as tested) actually has **three separate hook systems** — this
matters, because two of them looked promising and don't work for this use case:

- **Gateway hooks** (`~/.hermes/hooks/`) — fire only for messaging-platform sessions
  (Telegram/Discord/Slack/WhatsApp/Teams). **Do not fire for CLI sessions at all.**
- **Shell hooks** (`hooks:` block in `config.yaml`) — CLI + gateway, but a small fixed
  set of directive events, invoked as external shell scripts.
- **Plugin hooks** (`ctx.register_hook()` in `~/.hermes/plugins/<name>/`) — CLI +
  gateway, the full documented catalog (`pre_tool_call`, `post_tool_call`,
  `on_session_start`, `on_session_end`, `on_session_finalize`, `subagent_start`,
  `subagent_stop`, ...). **This is the one that actually covers CLI sessions.**

`hermesProvider.installHooks()` drops a small Python plugin at
`~/.hermes/plugins/pixel-agents-bridge/` (source:
`server/src/providers/hook/hermes/pixel_agents_bridge_plugin.py`) and runs
`hermes plugins enable pixel-agents-bridge` (the documented, idempotent CLI for Hermes's
opt-in plugin allow-list — nothing hand-edits `config.yaml` directly). The plugin uses
only Python's stdlib (`urllib`), so it adds no dependency to Hermes's venv. It reads
`~/.hermes/plugins/pixel-agents-bridge/`, connects to the pixel-office server registry
under `~/.pixel-agents/servers/*.json`, and POSTs normalized events — it never reads
Hermes session content, prompts, or config beyond what the plugin-hook payload itself
hands it.

**Important limitation, by design of Hermes itself**: `HookRegistry.discover_and_load()`
scans `~/.hermes/plugins/` once, at process start. A Hermes session that was already
running before the plugin was installed cannot retroactively receive plugin-hook events
— there is no live-reload. New `hermes` sessions started after installation are hooked
automatically; anything already running when you first ran `pixel-office start` is not,
and won't be until you restart it yourself (this repo will never restart a Hermes session
for you).

**Fallback for an already-running session**: `scripts/fallback/watch-live-hermes.mjs` is
a read-only, opt-in script for that gap. It watches `/proc/<pid>/stat` CPU-time deltas
for a specific Hermes PID (a real, kernel-reported, read-only signal for "is this process
doing work right now") and reports coarse busy/idle transitions to the office, labeled
explicitly as `"Observed process activity (read-only)"` — never a fabricated tool name,
file, or command, because this script has no access to any of that. It never reads
`~/.hermes/sessions/`, `config.yaml`, or any Hermes state; the only file it touches is
the pixel-office server registry, read-only.

```bash
node scripts/fallback/watch-live-hermes.mjs --pid <PID> [--session-id my-label] [--cwd /path]
# Ctrl+C sends a clean SessionEnd before exiting.
```

## Multi-agent behavior

Each character is labeled with its provider (Claude Code / Codex CLI / Hermes Agent) so
you can tell them apart at a glance. Simultaneous sessions from different providers, or
multiple sessions from the same provider, render as separate characters sharing one
office — same store, same layout, independently tracked lifecycles. Stopping one agent
(session end) never affects any other agent's state; each provider's `HookEventHandler`
instance is independent (see `server/src/agentRuntime.ts`).

No hidden reasoning/chain-of-thought is ever displayed — only tool names, file paths
(basenames), and coarse status (active/waiting/done), the same discipline the upstream
Claude provider already follows.

## Reliability notes

- **No API credentials ever reach the visualizer.** The only cross-process secret is a
  locally-generated bearer token (`~/.pixel-agents/servers/*.json`) authenticating hook
  POSTs to `127.0.0.1` — never sent anywhere else, never a model/provider API key.
- **Binds to 127.0.0.1 by default.** No public exposure unless you explicitly change
  `--host`.
- **Graceful degradation**: if one provider's install fails (e.g. `hermes` isn't on
  `PATH`), the other two still start normally — see `installAllHooks()` in
  `server/src/cli.ts`.
- **No duplicate agents on reconnect/restart**: session routing is keyed by
  `providerId` + the CLI's own session id, not by connection.
- **Codex tailer is debounced and offset-tracked** — it never re-reads a file from byte
  zero on every poll, and skips historical rollouts older than the stale window on first
  scan, so it doesn't chew CPU walking years of `~/.codex/sessions/`.
- **Malformed/truncated JSONL lines are skipped, never crash the tailer** (partial last
  line is buffered and retried next poll, exactly like the upstream Claude file-watcher).

## Testing

```bash
npm install
npm run build            # esbuild (CLI + hooks + Hermes plugin copy) + webview
cd server && npx vitest run
```

419 tests pass (377 from upstream, unmodified — verifying this fork didn't regress
Claude support — plus 42 new tests for the multi-provider routing patch, the Codex
provider, and the Hermes provider). New coverage: `server/__tests__/codex.test.ts`,
`server/__tests__/hermes.test.ts`, `server/__tests__/agentRuntime.multiProvider.test.ts`
(simultaneous sessions from different providers, duplicate-event handling, malformed
events, unknown `providerId`, isolated tool state between concurrent agents, clean
`dispose()`).

## Installing and running

Requires Node.js >= 20.

```bash
git clone <this-repo-url> pixel-office
cd pixel-office
npm install
npm run build
```

Then use the launcher (works from anywhere once linked onto your `PATH`):

```bash
ln -s "$(pwd)/bin/pixel-office" ~/.local/bin/pixel-office   # one-time
pixel-office start     # builds if needed, starts the server, installs hooks for
                        # every provider that's actually present on the machine
pixel-office status     # is it running, on which port, health check
pixel-office doctor      # full toolchain check: node, claude/codex/hermes CLIs,
                          # dist build, plugin bundling, port availability
pixel-office logs         # tail the server's logs
pixel-office open          # print the URL
pixel-office stop           # stop it
```

`pixel-office start` prefers a `systemd --user` service (always-on, survives logout and
reboot) when available, and falls back to a background `nohup` process otherwise (with a
clear note that you'll need to restart it after a reboot in that case).

Open the printed URL (default `http://127.0.0.1:4173`) in a browser. That's the whole
interface — no separate "connect" step.

### If agents don't appear

Run `pixel-office doctor` first. Common causes:

- **Claude**: hooks install automatically; if nothing shows up, confirm you're running
  Claude Code from a directory the office is scanning, or enable "Watch All Sessions" in
  the UI settings.
- **Codex**: same "Watch All Sessions" gate applies — the tailer detects and forwards
  every session's events, but the runtime still only _adopts_ sessions from tracked
  project directories unless Watch All Sessions is on (same privacy-preserving gate
  Claude uses; verified in this fork's E2E pass — a Codex session in an untracked temp
  dir correctly logged "not adopted" while still proving the full parse → normalize →
  route pipeline worked).
- **Hermes**: confirm `hermes plugins list` shows `pixel-agents-bridge` as `enabled`,
  then **start a new Hermes CLI session** (existing ones won't retroactively pick up the
  plugin — see the Hermes section above).

## Files changed/added on top of upstream

```
server/src/agentRuntime.ts                        multi-provider routing patch
server/src/cli.ts                                  registers all 3 providers, install/uninstall orchestration
server/src/providers/index.ts                       exports codexProvider, hermesProvider
server/src/providers/hook/codex/                    new: codex.ts, codexTailer.ts, constants.ts
server/src/providers/hook/hermes/                    new: hermes.ts, hermesHookInstaller.ts, constants.ts,
                                                       pixel_agents_bridge_plugin.py
server/__tests__/codex.test.ts                       new
server/__tests__/hermes.test.ts                       new
server/__tests__/agentRuntime.multiProvider.test.ts    new
esbuild.js                                           copies the Hermes plugin into dist/hooks/
package.json                                          dist/hooks/pixel_agents_bridge_plugin.py in the files allowlist
bin/pixel-office                                      new: start/stop/status/doctor/logs/open launcher
scripts/fallback/watch-live-hermes.mjs                 new: read-only CPU-activity fallback for a Hermes
                                                        session that predates plugin installation
```

## License

MIT, same as upstream. See [`LICENSE`](./LICENSE). `UPSTREAM_README.md` is the original
project's README, kept for attribution and its own (still-accurate) documentation of
everything not covered here.
