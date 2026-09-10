import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";
import { persistentCommandArgs, ConnectionPool, PooledSession, transportError } from "../src/connection-pool.js";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { buildRemoteDaemon } from "../src/remote-runner.js";


test("persistent Plink command uses the pinned key and Windows Python", () => {
  const config = parseConfig(
    [
      "--ssh-target",
      "administrator@192.0.2.20",
      "--ssh-flavor",
      "plink",
      "--ssh-command",
      "plink.exe",
      "--remote-python",
      "python",
      "--password-file",
      "secrets/password.txt",
      "--host-key",
      "ssh-ed25519 AAAA",
      "--pool-size",
      "1",
      "--keepalive-interval",
      "30",
      "--heartbeat-interval",
      "60",
    ],
    "win32",
  );
  const args = persistentCommandArgs(
    config,
    'python -u -c "import base64;exec(base64.b64decode(\'QQ==\'))"',
  );

  assert.equal(args.includes("-batch"), true);
  assert.equal(args.includes("-hostkey"), true);
  assert.equal(args.includes("ssh-ed25519 AAAA"), true);
  assert.equal(args.includes("-pwfile"), true);
  assert.equal(args.at(-2), "administrator@192.0.2.20");
  assert.match(args.at(-1), /^python -u -c/u);
});

test("persistent OpenSSH command configures protocol keepalive", () => {
  const config = parseConfig([
    "--ssh-target",
    "server",
    "--keepalive-interval",
    "20",
  ]);
  const args = persistentCommandArgs(config, "python3 -u daemon.py");
  assert.equal(args.includes("ServerAliveInterval=20"), true);
  assert.equal(args.includes("ServerAliveCountMax=3"), true);
  assert.equal(args.includes("TCPKeepAlive=yes"), true);
});

test("persistent OpenSSH command pins dynamic onboarded host keys", () => {
  const config = {
    ...parseConfig(["--ssh-target", "research@192.0.2.3"]),
    proxyJump: "bastion",
    hostKeyAlias: "reliable-lab-node-01",
    knownHostsFile: "C:/temp/reliable-known-hosts",
  };
  const args = persistentCommandArgs(config, "python3 -u daemon.py");
  assert.equal(args.includes("bastion"), true);
  assert.equal(args.includes("HostKeyAlias=reliable-lab-node-01"), true);
  assert.equal(
    args.includes("UserKnownHostsFile=C:/temp/reliable-known-hosts"),
    true,
  );
  assert.equal(args.includes("StrictHostKeyChecking=yes"), true);
});

test("persistent remote daemon supports safe zip extraction", () => {
  const daemon = buildRemoteDaemon();
  assert.match(daemon, /zipfile\.is_zipfile/u);
  assert.match(daemon, /Archive member escapes destination/u);
  assert.match(daemon, /format": "zip/u);
  assert.match(daemon, /start_tmux_session/u);
  assert.match(daemon, /scan_host_keys/u);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const poolConfig = { connectTimeoutSec: 1, commandTimeoutSec: 1, probeRetryDelayMs: 0 };
function fakeSession(index, options = {}) {
  return {
    index, closed: false, load: 0, lastSuccessAt: Date.now(), calls: [],
    async start() { if (options.startError) throw options.startError; return this; },
    async request(payload) {
      this.calls.push(payload.operation);
      if (options.requestError) { this.closed = true; throw options.requestError; }
      this.lastSuccessAt = Date.now();
      return { ok: true };
    },
    close() { this.closed = true; },
    status() { return { index, in_flight: this.load, alive: !this.closed }; },
  };
}

test("healthy first connection serves requests despite failed spare creation", async () => {
  const made = [];
  const pool = new ConnectionPool(poolConfig, 2, (_c, i) => {
    const s = fakeSession(i, i ? { startError: transportError('banner timeout', 'SSH_CONNECT_TIMEOUT') } : {});
    made.push(s); return s;
  });
  try {
    assert.deepEqual(await pool.invoke({ operation: 'probe_identity' }), { ok: true });
    await turn();
    assert.equal(made[1].closed, true);
    assert.deepEqual(await pool.invoke({ operation: 'read_file' }), { ok: true });
    assert.equal(pool.sessionsStarted, 1);
  } finally { pool.close(); }
});

test("cold pool serves first request without waiting for slow spare", async () => {
  let release;
  const pool = new ConnectionPool(poolConfig, 2, (_c, i) => {
    const s = fakeSession(i);
    if (i) s.start = () => new Promise(resolve => { release = () => resolve(s); });
    return s;
  });
  await pool.invoke({ operation: 'read_file' });
  assert.equal(typeof release, 'function');
  assert.equal(pool.sessionsStarted, 1);
  pool.close();
  release();
  await turn();
  assert.equal(pool.sessions.length, 0); // no resurrection after close
});

test("only built-in probes replay once after a transport failure", async () => {
  for (const operation of ['probe_identity', 'ping', 'process', 'write_file', 'start_tmux_session', 'read_file']) {
    const made = [];
    const pool = new ConnectionPool(poolConfig, 1, (_c, i) => {
      const s = fakeSession(i, i === 0 ? { requestError: transportError('reset') } : {});
      made.push(s); return s;
    });
    try {
      if (['probe_identity', 'ping'].includes(operation)) {
        await pool.invoke({ operation });
        assert.equal(made.length, 2);
      } else {
        await assert.rejects(pool.invoke({ operation }), /reset/);
        assert.equal(made.length, 1);
      }
    } finally { pool.close(); }
  }
});

test("probe retries are bounded and never retry identity mismatch", async () => {
  let count = 0;
  const pool = new ConnectionPool(poolConfig, 1, (_c, i) => {
    count++; return fakeSession(i, { startError: transportError('banner', 'SSH_CONNECT_TIMEOUT') });
  });
  await assert.rejects(pool.invoke({ operation: 'probe_identity' }));
  assert.equal(count, 2);
  pool.close();
  count = 0;
  const mismatch = new ConnectionPool(poolConfig, 1, (_c, i) => {
    count++; return fakeSession(i, { startError: new Error('Remote identity verification failed') });
  });
  await assert.rejects(mismatch.invoke({ operation: 'probe_identity' }));
  assert.equal(count, 1);
  mismatch.close();
});

test("stale idle connection is pinged before submitting a user operation", async () => {
  const s = fakeSession(0);
  s.lastSuccessAt = 0;
  const pool = new ConnectionPool(poolConfig, 1);
  pool.sessions.push(s);
  await pool.invoke({ operation: 'process' });
  assert.deepEqual(s.calls, ['ping', 'process']);
  pool.close();
});

test("controller close during probe retry delay cannot reopen the pool", async () => {
  let starts = 0;
  const pool = new ConnectionPool({ ...poolConfig, probeRetryDelayMs: 40 }, 1, (_c, i) => {
    starts++;
    return fakeSession(i, { startError: transportError('reset') });
  });
  const pending = pool.invoke({ operation: 'probe_identity' });
  const rejection = assert.rejects(pending, /SSH_CANCELLED/);
  await turn();
  pool.close();
  await rejection;
  assert.equal(starts, 1);
});

function daemonProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.pid = 123;
  child.operations = [];
  let bootstrap = true;
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    if (bootstrap) { bootstrap = false; callback(); return; }
    const frame = JSON.parse(chunk.toString());
    child.operations.push(frame.payload.operation);
    if (!child.hang) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: frame.id, ok: true,
      result: frame.payload.operation === 'ping' ? { pong: true } :
        { hostname: 'expected', ip_addresses: [], gpus: [] } }) + '\n'));
    callback();
  }});
  child.kill = () => { child.exitCode = 0; child.emit('close', 0); };
  return child;
}

test("idle heartbeat is lightweight and closing rejects all pending requests", async () => {
  const child = daemonProcess();
  const session = new PooledSession({ ...poolConfig, expectedHostname: 'expected',
    sshCommand: 'fake', remotePython: 'python3', heartbeatIntervalSec: .01 }, 0, () => child);
  try {
    await session.start();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(child.operations.filter(x => x === 'probe_identity').length, 1);
    assert.ok(child.operations.includes('ping'));
    child.hang = true;
    const pending = session.request({ operation: 'process' });
    const rejection = assert.rejects(pending, /SSH_CANCELLED/);
    session.close();
    await rejection;
    assert.equal(session.load, 0);
  } finally { session.close(); }
});

test("heartbeat skips busy connections and new connections verify identity", async () => {
  const child = daemonProcess();
  const session = new PooledSession({ ...poolConfig, expectedHostname: 'wrong',
    sshCommand: 'fake', remotePython: 'python3', heartbeatIntervalSec: .01 }, 0, () => child);
  await assert.rejects(session.start(), /identity verification failed/);
  session.close();
  const child2 = daemonProcess();
  const busy = new PooledSession({ ...poolConfig, expectedHostname: 'expected',
    sshCommand: 'fake', remotePython: 'python3', heartbeatIntervalSec: .01 }, 1, () => child2);
  await busy.start();
  child2.hang = true;
  const pending = busy.request({ operation: 'process' });
  const rejection = assert.rejects(pending, /SSH_CANCELLED/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(child2.operations, ['probe_identity', 'process']);
  busy.close();
  await rejection;
});
