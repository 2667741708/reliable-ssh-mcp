import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { buildRemoteDaemon } from "./remote-runner.js";
import { remoteExecutable } from "./remote-command.js";
import { plinkArgs } from "./plink-args.js";
import { verifyIdentity } from "./identity.js";

export function transportError(message, code = "SSH_TRANSPORT_CLOSED") {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

const RETRYABLE = new Set(["SSH_TRANSPORT_CLOSED", "SSH_CONNECT_TIMEOUT", "SSH_REQUEST_TIMEOUT"]);
const SAFE_PROBES = new Set(["probe_identity", "ping"]);

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

export class PooledSession {
  constructor(config, index, spawnProcess = spawn) {
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
    this.spawnProcess = spawnProcess;
    this.lastSuccessAt = null;
    this.lastError = null;
  }

  async start() {
    const startedAt = Date.now();
    const bootstrap = persistentBootstrap(this.config);
    const args = persistentCommandArgs(this.config, bootstrap.command);
    this.process = this.spawnProcess(this.config.sshCommand, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    this.process.stdout.on("data", (chunk) => this.#onData(chunk));
    this.process.on("error", (error) => this.close(
      transportError(`SSH pool session failed to start: ${error.message}`),
    ));
    this.process.on("close", (code, signal) => {
      this.close(
        transportError(
          `SSH pool session closed with code ${code}${signal ? ` (${signal})` : ""}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
          /banner exchange|Connection timed out/i.test(this.stderr) ? "SSH_CONNECT_TIMEOUT" : "SSH_TRANSPORT_CLOSED",
        ),
      );
    });
    this.process.stdin.on("error", (error) => this.close(transportError(error.message)));
    await new Promise((resolve, reject) => {
      this.process.stdin.write(bootstrap.body, (error) => error ? reject(error) : resolve());
    });
    const identity = await this.request(
      { operation: "probe_identity" },
      this.config.connectTimeoutSec + 10,
    );
    // Every newly created connection is verified before any user operation.
    verifyIdentity(identity, this.config);
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
          { operation: "ping" },
          5,
          true,
        );
      } catch (error) {
        this.close(error);
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
        this.close(
          transportError(
            `Persistent runner returned invalid JSON: ${error.message}`,
            "SSH_PROTOCOL_ERROR",
          ),
        );
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
      return Promise.reject(transportError("SSH pool session is closed"));
    }
    const id = randomUUID();
    const startedAt = Date.now();
    this.lastUsedAt = new Date().toISOString();
    this.requestsSent += 1;
    if (heartbeat) this.heartbeatCount += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.close(transportError(`Persistent SSH request timed out (deadline ${timeoutSec + 5}s)`, "SSH_REQUEST_TIMEOUT"));
        },
        (timeoutSec + 5) * 1000,
      );
      this.pending.set(id, {
        resolve: (value) => {
          this.requestsCompleted += 1;
          this.lastSuccessAt = Date.now();
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
            this.close(transportError(`Could not write to persistent SSH session: ${error.message}`));
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
      last_success_at: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      health: this.closed ? "closed" : this.load > 0 ? "busy" :
        Date.now() - (this.lastSuccessAt ?? 0) <= (this.config.idleProbeAfterSec ?? 60) * 1000 ? "recently_verified" : "stale",
      last_error: this.lastError,
      protocol_keepalive_interval_seconds: this.config.keepaliveIntervalSec,
      heartbeat_interval_seconds: this.config.heartbeatIntervalSec,
    };
  }

  close(error = transportError("SSH session closed by controller", "SSH_CANCELLED")) {
    if (this.closed) return;
    this.closed = true;
    this.lastError = error.message;
    this.#failAll(error);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.process?.stdin.end();
    } catch {}
    this.process?.kill("SIGTERM");
  }
}

export class ConnectionPool {
  constructor(config, size = 2, sessionFactory = (c, i) => new PooledSession(c, i)) {
    this.config = config;
    this.size = size;
    this.sessions = [];
    this.starting = null;
    this.sessionsStarted = 0;
    this.sessionFactory = sessionFactory;
    this.generation = 0;
    this.closeEpoch = 0;
    this.nextIndex = 0;
    this.refillAfter = 0;
    this.lastConnectionError = null;
    this.probeRetries = 0;
    this.connecting = null;
  }

  async warm(minimum = 1) {
    if (this.sessions.filter(s => !s.closed).length >= minimum) return this.status();
    if (this.starting) return this.starting;
    const epoch = this.closeEpoch;
    this.starting = (async () => {
      while (
        this.sessions.filter((session) => !session.closed).length < Math.min(minimum, this.size)
      ) {
        const session = this.sessionFactory(this.config, this.nextIndex++);
        this.connecting = session;
        try {
          await session.start();
          if (epoch !== this.closeEpoch) throw transportError("Connection creation cancelled", "SSH_CANCELLED");
        } catch (error) {
          session.close(error);
          this.lastConnectionError = error.message;
          this.refillAfter = Date.now() + 5000;
          throw error;
        } finally {
          this.connecting = null;
        }
        this.sessions.push(session);
        this.sessionsStarted += 1;
        this.generation += 1;
        this.lastConnectionError = null;
      }
      return this.status();
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async invoke(payload) {
    const epoch = this.closeEpoch;
    for (let attempt = 0; ; attempt += 1) {
      if (epoch !== this.closeEpoch) throw transportError("Probe retry cancelled by controller", "SSH_CANCELLED");
      try {
        await this.warm(1);
        const live = this.sessions.filter(s => !s.closed);
        live.sort((a, b) => a.load - b.load);
        const session = live[0];
        if (!session) throw transportError("No live SSH pool sessions");
        if (session.load === 0 && Date.now() - (session.lastSuccessAt ?? 0) > (this.config.idleProbeAfterSec ?? 60) * 1000) {
          await session.request({ operation: "ping" }, 5, true);
        }
        const result = await session.request(payload, payload.timeout_seconds ?? this.config.commandTimeoutSec);
        // Spare capacity must never be on the critical path of a healthy request.
        if (epoch === this.closeEpoch && !this.starting && Date.now() >= this.refillAfter) {
          void this.warm(this.size).catch(() => {});
        }
        return result;
      } catch (error) {
        this.sessions = this.sessions.filter(s => !s.closed);
        if (attempt !== 0 || epoch !== this.closeEpoch || !SAFE_PROBES.has(payload.operation) || !RETRYABLE.has(error.code)) throw error;
        this.probeRetries += 1;
        // Only these two built-in read-only operations may be replayed once.
        await new Promise(resolve => setTimeout(resolve, this.config.probeRetryDelayMs ?? 250));
      }
    }
  }

  status() {
    return {
      target: this.config.sshTarget,
      configured_size: this.size,
      sessions_started: this.sessionsStarted,
      reconnect_count: Math.max(0, this.sessionsStarted - this.size),
      automatic_replay: false,
      readonly_probe_retry_limit: 1,
      readonly_probe_retries: this.probeRetries,
      connection_generation: this.generation,
      last_connection_error: this.lastConnectionError,
      connecting: Boolean(this.connecting),
      implementation: "health-pool-v2",
      sessions: this.sessions.map((session) => session.status()),
    };
  }

  close() {
    this.closeEpoch += 1;
    this.generation += 1;
    this.connecting?.close();
    for (const session of this.sessions) session.close();
    this.sessions = [];
  }

  isFresh(maxAgeMs = 60000) {
    return this.sessions.some(s => !s.closed && Date.now() - (s.lastSuccessAt ?? 0) <= maxAgeMs);
  }
}
