#!/usr/bin/env node
/**
 * Read-only fallback watcher for a Hermes session that was already running
 * before the pixel-agents-bridge plugin was installed.
 *
 * Why this exists: Hermes only loads plugin hooks at process start
 * (HookRegistry.discover_and_load() runs once, on boot -- see the Hermes docs).
 * A session that was already running cannot retroactively receive hook events
 * no matter what gets installed later. That session either goes completely
 * unrepresented in the office, or gets a coarse, honestly-labeled substitute.
 * This script is the substitute.
 *
 * What it does: reads /proc/<pid>/stat for the given PID on an interval and
 * computes CPU-time deltas -- a real, read-only, kernel-reported signal for
 * "is this process doing work right now," with zero access to prompts, tool
 * arguments, file contents, or any Hermes session data. It NEVER reads
 * ~/.hermes/sessions/, config.yaml, or any Hermes state file. It never writes
 * anything under ~/.hermes/. The only file it touches is
 * ~/.pixel-agents/servers/*.json, read-only, to find where to POST.
 *
 * What it reports: busy/idle transitions as toolStart/toolEnd events with an
 * explicitly-labeled tool name ("Observed process activity (read-only)") --
 * never a specific tool, file, or command, because this script cannot see any
 * of that. This is intentionally coarse rather than fabricated: it never
 * claims Hermes is reading a file or running a command, because it doesn't
 * know that.
 *
 * Usage:
 *   node watch-live-hermes.mjs --pid 997336 --session-id live-997336 [--cwd /path]
 *
 * Stop with Ctrl+C -- sends a SessionEnd before exiting so the character
 * doesn't linger.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const HOOK_PATH = '/api/hooks/hermes';
const POLL_MS = 3000;
/** CPU-time delta (jiffies, usually 1/100s) above which the process counts as
 *  "busy" for this poll window. 5 jiffies over 3s is a conservative floor --
 *  well above idle-process background noise, well below requiring sustained
 *  100% CPU (LLM calls spend most wall time waiting on the network, not
 *  burning CPU, so this threshold is deliberately low). */
const BUSY_JIFFY_THRESHOLD = 5;

function parseArgs(argv) {
  const args = { pid: null, sessionId: null, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pid') args.pid = Number(argv[++i]);
    else if (argv[i] === '--session-id') args.sessionId = argv[++i];
    else if (argv[i] === '--cwd') args.cwd = argv[++i];
  }
  if (!args.pid || Number.isNaN(args.pid)) {
    console.error('Usage: watch-live-hermes.mjs --pid <PID> [--session-id <id>] [--cwd <dir>]');
    process.exit(1);
  }
  if (!args.sessionId) args.sessionId = `live-${args.pid}`;
  return args;
}

function readCpuJiffies(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  // Field 2 (comm) may contain spaces/parens; split after the closing paren.
  const afterComm = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  // utime = field 14, stime = field 15 overall -> indices 11, 12 after comm+pid+state removed.
  const utime = Number(afterComm[11]);
  const stime = Number(afterComm[12]);
  return utime + stime;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function liveServers() {
  const dir = path.join(os.homedir(), '.pixel-agents', 'servers');
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const servers = [];
  for (const file of entries) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (
        typeof data.port === 'number' &&
        typeof data.pid === 'number' &&
        typeof data.token === 'string'
      ) {
        if (isAlive(data.pid)) servers.push(data);
      }
    } catch {
      /* skip malformed/unreadable registry entries */
    }
  }
  return servers;
}

function post(server, body) {
  const json = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: HOOK_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
          Authorization: `Bearer ${server.token}`,
        },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve();
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(json);
  });
}

async function emit(fields) {
  const servers = liveServers();
  if (servers.length === 0) return;
  await Promise.all(servers.map((s) => post(s, fields)));
}

async function main() {
  const { pid, sessionId, cwd } = parseArgs(process.argv.slice(2));
  if (!isAlive(pid)) {
    console.error(`PID ${pid} is not running.`);
    process.exit(1);
  }

  console.log(`[watch-live-hermes] Watching PID ${pid} (read-only, CPU-activity heuristic only)`);
  console.log(
    '[watch-live-hermes] This is a coarse fallback, not real hook data. See file header.',
  );

  await emit({ hook_event_name: 'SessionStart', session_id: sessionId, cwd });

  let lastJiffies = readCpuJiffies(pid);
  let busy = false;
  const toolId = 'observed-activity';

  const timer = setInterval(async () => {
    if (!isAlive(pid)) {
      console.log(`[watch-live-hermes] PID ${pid} exited. Sending SessionEnd and stopping.`);
      await emit({
        hook_event_name: 'SessionEnd',
        session_id: sessionId,
        reason: 'process-exited',
      });
      clearInterval(timer);
      process.exit(0);
    }
    let jiffies;
    try {
      jiffies = readCpuJiffies(pid);
    } catch {
      return; // /proc read raced the process exiting; pick it up next tick
    }
    const delta = jiffies - lastJiffies;
    lastJiffies = jiffies;
    const nowBusy = delta >= BUSY_JIFFY_THRESHOLD;

    if (nowBusy && !busy) {
      busy = true;
      await emit({
        hook_event_name: 'ExecStart',
        session_id: sessionId,
        tool_id: toolId,
        tool_name: 'Observed process activity (read-only)',
        tool_input: {},
      });
    } else if (!nowBusy && busy) {
      busy = false;
      await emit({ hook_event_name: 'ExecEnd', session_id: sessionId, tool_id: toolId });
      await emit({ hook_event_name: 'TurnEnd', session_id: sessionId, awaiting_input: true });
    }
  }, POLL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    await emit({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'watcher-stopped' });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
