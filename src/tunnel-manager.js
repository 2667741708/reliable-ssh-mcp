import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";

function routeArgs(config) {
  const args = [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
  ];
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

function getFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForPort(host, port, process, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (process.exitCode !== null) {
        reject(
          new Error(
            `SSH tunnel exited before listening (code ${process.exitCode})`,
          ),
        );
        return;
      }
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline)
          reject(new Error(`Timed out waiting for tunnel ${host}:${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

export class TunnelManager {
  constructor() {
    this.tunnels = new Map();
  }

  async start(server, specification) {
    const id = randomUUID();
    const bindHost = specification.bindHost ?? "127.0.0.1";
    const localPort = specification.localPort || (await getFreePort(bindHost));
    const args = routeArgs(server);
    if (specification.type === "socks") {
      args.push("-D", `${bindHost}:${localPort}`);
    } else {
      args.push(
        "-L",
        `${bindHost}:${localPort}:${specification.remoteHost}:${specification.remotePort}`,
      );
    }
    args.push(server.sshTarget);
    const child = spawn(server.sshCommand, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const record = {
      id,
      server: server.name,
      type: specification.type,
      bind_host: bindHost,
      local_port: localPort,
      remote_host: specification.remoteHost,
      remote_port: specification.remotePort,
      created_at: new Date().toISOString(),
      status: "starting",
      pid: child.pid,
      specification: { ...specification, localPort },
      process: child,
      stderr: "",
    };
    this.tunnels.set(id, record);
    child.stderr.on("data", (chunk) => {
      record.stderr = `${record.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("close", (code, signal) => {
      record.status = record.status === "closing" ? "closed" : "failed";
      record.exit_code = code;
      record.signal = signal;
      record.closed_at = new Date().toISOString();
    });
    await waitForPort(
      bindHost,
      localPort,
      child,
      server.connectTimeoutSec * 1000,
    );
    record.status = "running";
    return this.#public(record);
  }

  #public(record) {
    const {
      process: _process,
      specification: _specification,
      ...visible
    } = record;
    return visible;
  }

  list(serverName) {
    return [...this.tunnels.values()]
      .filter((record) => !serverName || record.server === serverName)
      .map((record) => this.#public(record));
  }

  get(id) {
    const record = this.tunnels.get(id);
    if (!record) throw new Error(`Unknown tunnel ${id}`);
    return this.#public(record);
  }

  close(id) {
    const record = this.tunnels.get(id);
    if (!record) throw new Error(`Unknown tunnel ${id}`);
    if (record.status === "running" || record.status === "starting") {
      record.status = "closing";
      record.process.kill("SIGTERM");
    }
    return this.#public(record);
  }

  async restart(id, resolveServer) {
    const record = this.tunnels.get(id);
    if (!record) throw new Error(`Unknown tunnel ${id}`);
    const specification = { ...record.specification };
    const server = resolveServer(record.server);
    this.close(id);
    return this.start(server, specification);
  }

  closeAll() {
    for (const record of this.tunnels.values()) {
      if (record.status === "running" || record.status === "starting") {
        record.status = "closing";
        record.process.kill("SIGTERM");
      }
    }
  }
}
