import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { buildRemoteDaemon } from "./remote-runner.js";
import { remoteExecutable } from "./remote-command.js";
import { plinkArgs } from "./plink-args.js";

function opensshRouteArgs(config) {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${config.connectTimeoutSec}`,
  ];
  if (config.keepaliveIntervalSec > 0) {
    args.push("-o", `ServerAliveInterval=${config.keepaliveIntervalSec}`);
    args.push("-o", "ServerAliveCountMax=3");
    args.push("-o", "TCPKeepAlive=yes");
  }
  if (config.proxyJump) args.push("-J", config.proxyJump);
  if (config.proxyCommand)
    args.push("-o", `ProxyCommand=${config.proxyCommand}`);
  if (config.identityFile) args.push("-i", config.identityFile);
  if (config.hostKeyAlias)
    args.push("-o", `HostKeyAlias=${config.hostKeyAlias}`);
  if (config.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${config.knownHostsFile}`);
    args.push("-o", "StrictHostKeyChecking=yes");
  }
  return args;
}

export function persistentCommandArgs(config, remoteCommand) {
  if (config.sshFlavor !== "plink") {
    return [
      ...opensshRouteArgs(config),
      config.sshTarget,
      remoteCommand,
    ];
  }
  return plinkArgs(config, [remoteCommand]);
}

export function persistentBootstrap(config, source = buildRemoteDaemon()) {
  const body = Buffer.from(source, "utf8");
  // Windows cmd.exe limits command lines to 8191 characters. Keep the
  // bootstrap small and consume exactly the source bytes before JSON frames.
  const command = `${remoteExecutable(config)} -u -X utf8 -c "import sys;exec(compile(sys.stdin.buffer.read(${body.length}),'<reliable-ssh>','exec'))"`;
  return { command, body };
}

class PooledSession {
  constructor(config, index) {
    this.config = config;
    this.index = index;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.lastUsedAt = null;
    this.process = null;
    this.createdAt = null;
    this.handshakeDurationMs = null;
    this.requestsSent = 0;
    this.requestsCompleted = 0;
    this.heartbeatCount = 0;
    this.lastRequestDurationMs = null;
    this.heartbeatTimer = null;
  }

  async start() {
    const startedAt = Date.now();
    const bootstrap = persistentBootstrap(this.config);
    const args = persistentCommandArgs(this.config, bootstrap.command);
    this.process = spawn(this.config.sshCommand, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    this.process.stdout.on("data", (chunk) => this.#onData(chunk));
    this.process.on("error", (error) =>
      this.#failAll(
        new Error(`SSH pool session failed to start: ${error.message}`),
      ),
    );
    this.process.on("close", (code, signal) => {
      this.closed = true;
      this.#failAll(
        new Error(
          `SSH pool session closed with code ${code}${signal ? ` (${signal})` : ""}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
        ),
      );
    });
    this.process.stdin.on("error", (error) => this.#failAll(error));
    await new Promise((resolve, reject) => {
      this.process.stdin.write(bootstrap.body, (error) => error ? reject(error) : resolve());
    });
    await this.request(
      { operation: "probe_identity" },
      this.config.connectTimeoutSec + 10,
    );
    this.createdAt = new Date().toISOString();
    this.handshakeDurationMs = Date.now() - startedAt;
    this.#startHeartbeat();
    return this;
  }

  #startHeartbeat() {
    if (!(this.config.heartbeatIntervalSec > 0)) return;
    this.heartbeatTimer = setInterval(async () => {
      if (this.closed || this.load > 0) return;
      try {
        await this.request(
          { operation: "probe_identity" },
          Math.max(this.config.connectTimeoutSec, 5),
          true,
        );
      } catch {
        this.close();
      }
    }, this.config.heartbeatIntervalSec * 1000);
    this.heartbeatTimer.unref?.();
  }

  #onData(chunk) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newlineAt = this.buffer.indexOf("\n");
      if (newlineAt < 0) return;
      const line = this.buffer.slice(0, newlineAt).trim();
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        this.#failAll(
          new Error(
            `Persistent runner returned invalid JSON: ${error.message}`,
          ),
        );
        this.close();
        return;
      }
      const waiter = this.pending.get(response.id);
      if (!waiter) continue;
      this.pending.delete(response.id);
      clearTimeout(waiter.timer);
      if (response.ok) waiter.resolve(response.result);
      else
        waiter.reject(
          new Error(
            `Remote ${response.error?.type ?? "error"}: ${response.error?.message ?? "unknown failure"}`,
          ),
        );
    }
  }

  #failAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  request(payload, timeoutSec = this.config.commandTimeoutSec, heartbeat = false) {
    if (this.closed || !this.process || this.process.exitCode !== null) {
      return Promise.reject(new Error("SSH pool session is closed"));
    }
    const id = randomUUID();
    const startedAt = Date.now();
    this.lastUsedAt = new Date().toISOString();
    this.requestsSent += 1;
    if (heartbeat) this.heartbeatCount += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error(`Persistent SSH request timed out after ${timeoutSec}s`),
          );
          this.close();
        },
        (timeoutSec + 5) * 1000,
      );
      this.pending.set(id, {
        resolve: (value) => {
          this.requestsCompleted += 1;
          this.lastRequestDurationMs = Date.now() - startedAt;
          resolve(value);
        },
        reject,
        timer,
      });
      this.process.stdin.write(
        `${JSON.stringify({ id, payload })}\n`,
        "utf8",
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(
              new Error(
                `Could not write to persistent SSH session: ${error.message}`,
              ),
            );
          }
        },
      );
    });
  }

  get load() {
    return this.pending.size;
  }

  status() {
    return {
      index: this.index,
      pid: this.process?.pid,
      alive: !this.closed && this.process?.exitCode === null,
      in_flight: this.pending.size,
      last_used_at: this.lastUsedAt,
      created_at: this.createdAt,
      handshake_duration_ms: this.handshakeDurationMs,
      requests_sent: this.requestsSent,
      requests_completed: this.requestsCompleted,
      heartbeat_count: this.heartbeatCount,
      last_request_duration_ms: this.lastRequestDurationMs,
      protocol_keepalive_interval_seconds: this.config.keepaliveIntervalSec,
      heartbeat_interval_seconds: this.config.heartbeatIntervalSec,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.process?.stdin.end();
    } catch {}
    this.process?.kill("SIGTERM");
  }
}

export class ConnectionPool {
  constructor(config, size = 2) {
    this.config = config;
    this.size = size;
    this.sessions = [];
    this.starting = null;
    this.sessionsStarted = 0;
  }

  async warm() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      while (
        this.sessions.filter((session) => !session.closed).length < this.size
      ) {
        const session = new PooledSession(this.config, this.sessionsStarted);
        await session.start();
        this.sessions.push(session);
        this.sessionsStarted += 1;
      }
      return this.status();
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async invoke(payload) {
    await this.warm();
    const live = this.sessions.filter((session) => !session.closed);
    live.sort((left, right) => left.load - right.load);
    if (live.length === 0) throw new Error("No live SSH pool sessions");
    try {
      return await live[0].request(
        payload,
        payload.timeout_seconds ?? this.config.commandTimeoutSec,
      );
    } catch (error) {
      this.sessions = this.sessions.filter((session) => !session.closed);
      throw error;
    }
  }

  status() {
    return {
      target: this.config.sshTarget,
      configured_size: this.size,
      sessions_started: this.sessionsStarted,
      reconnect_count: Math.max(0, this.sessionsStarted - this.size),
      automatic_replay: false,
      sessions: this.sessions.map((session) => session.status()),
    };
  }

  close() {
    for (const session of this.sessions) session.close();
    this.sessions = [];
  }
}
