import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverEntry = path.join(projectRoot, "src", "index.js");
const configPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(projectRoot, "config", "fleet.json");
const child = spawn(
  process.execPath,
  [serverEntry, "--fleet-config", configPath, "--local-root", "project=.."],
  {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);
let buffer = "";
let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function call(name, arguments_) {
  const result = await request("tools/call", { name, arguments: arguments_ });
  if (result.isError)
    throw new Error(`${name} failed: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newlineAt = buffer.indexOf("\n");
    if (newlineAt < 0) break;
    const line = buffer.slice(0, newlineAt).trim();
    buffer = buffer.slice(newlineAt + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", (error) => {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
});

async function waitTask(server, id) {
  for (let count = 0; count < 180; count += 1) {
    const task = await call("task_status", { server, task_id: id });
    if (task.status === "completed") return task;
    if (task.status === "failed" || task.status === "cancelled")
      throw new Error(`Task ${id} ${task.status}: ${task.error}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Task ${id} timed out`);
}

async function stopServer() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  const closed = once(child, "close").then(() => true);
  if (
    !(await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]))
  ) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await once(child, "close");
  }
}

const timer = setTimeout(() => {
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
  });
  console.error("Fleet smoke test timed out.");
  process.exit(1);
}, 180000);

const localRoot = path.resolve(projectRoot, "..");
const runId = `${process.pid}-${Date.now()}`;
const sourceDir = path.join(localRoot, `.fleet-source-${runId}`);
const downloadDir = path.join(localRoot, `.fleet-download-${runId}`);
const remoteRoot = `/tmp/reliable-fleet-${runId}`;

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "reliable-fleet-smoke", version: "1.0.0" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );
  assert.match(initialized.instructions, /persistent pools/u);

  const listed = await request("tools/list", {});
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  for (const required of [
    "list_servers",
    "list_bastions",
    "list_server_groups",
    "list_local_roots",
    "list_remote_sessions",
    "start_remote_session",
    "read_remote_log",
    "exec_argv",
    "run_template",
    "upload_file",
    "upload_directory",
    "task_status",
    "warm_connections",
    "start_local_forward",
    "start_socks_proxy",
  ])
    assert.ok(toolNames.includes(required), `Missing tool ${required}`);

  const servers = await call("list_servers", {});
  assert.ok(servers.length > 0, "Fleet smoke test requires at least one server");

  const evidence = {};
  for (const selected of servers) {
    const server = selected.name;
    const identity = await call("probe_identity", { server, force: true });
    const pool = await call("warm_connections", { server });
    assert.equal(pool.sessions.length, 2);
    const special = "spaces ' double\" $HOME ; | [brackets] 中文";
    const execution = await call("exec_argv", {
      server,
      program: "python3",
      args: ["-c", "import sys; print(sys.argv[1])", special],
    });
    assert.equal(execution.stdout.text.trim(), special);
    const template = await call("run_template", {
      server,
      template: "gpu_inventory",
      parameters: {},
    });
    assert.equal(template.exit_code, 0);
    evidence[server] = { identity, pool, argv: execution, template };
  }

  const tunnelServer = servers[0].name;
  const forward = await call("start_local_forward", {
    server: tunnelServer,
    local_port: 0,
    remote_host: "127.0.0.1",
    remote_port: 22,
  });
  assert.equal(forward.status, "running");
  const socks = await call("start_socks_proxy", {
    server: tunnelServer,
    local_port: 0,
  });
  assert.equal(socks.status, "running");
  assert.ok((await call("list_tunnels", { server: tunnelServer })).length >= 2);
  await call("close_tunnel", { server: tunnelServer, tunnel_id: forward.id });
  await call("close_tunnel", { server: tunnelServer, tunnel_id: socks.id });

  await mkdir(path.join(sourceDir, "nested"), { recursive: true });
  const archiveContent = "archive round trip\n中文 '$HOME' ; |\n";
  await writeFile(
    path.join(sourceDir, "nested", "payload.txt"),
    archiveContent,
    "utf8",
  );
  const upload = await call("upload_directory", {
    server: tunnelServer,
    local_root: "project",
    local_path: path.basename(sourceDir),
    remote_directory: remoteRoot,
  });
  const uploadDone = await waitTask(tunnelServer, upload.id);
  assert.equal(uploadDone.progress, 100);
  const download = await call("download_directory", {
    server: tunnelServer,
    local_root: "project",
    remote_path: `${remoteRoot}/${path.basename(sourceDir)}`,
    local_directory: path.basename(downloadDir),
  });
  const downloadDone = await waitTask(tunnelServer, download.id);
  assert.equal(downloadDone.progress, 100);
  assert.equal(
    await readFile(
      path.join(downloadDir, path.basename(sourceDir), "nested", "payload.txt"),
      "utf8",
    ),
    archiveContent,
  );
  await call("exec_argv", {
    server: tunnelServer,
    program: "rm",
    args: ["-rf", "--", remoteRoot],
  });

  for (const selected of servers)
    await call("close_connections", { server: selected.name });
  console.log(
    JSON.stringify(
      {
        protocol_version: initialized.protocolVersion,
        tools: toolNames.length,
        servers,
        evidence,
        archive: { upload: uploadDone, download: downloadDone },
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
  await rm(sourceDir, { recursive: true, force: true });
  await rm(downloadDir, { recursive: true, force: true });
  await stopServer();
}
