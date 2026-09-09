import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverArgs = process.argv.slice(2);
if (serverArgs.length === 0) {
  console.error(
    "Pass the reliable-ssh-mcp server arguments after npm run smoke:windows --",
  );
  process.exit(2);
}

const child = spawn(process.execPath, [path.join(projectRoot, "src", "index.js"), ...serverArgs], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let buffer = "";
let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
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

async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "reliable-ssh-windows-smoke", version: "1.0.0" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );
  assert.match(initialized.instructions, /Prefer exec_argv/u);

  const listed = await request("tools/list", {});
  assert.ok(listed.tools.some((tool) => tool.name === "probe_identity"));
  const identityCall = await request("tools/call", {
    name: "probe_identity",
    arguments: { force: true },
  });
  assert.equal(identityCall.isError, undefined);
  const identity = JSON.parse(identityCall.content[0].text);
  assert.equal(typeof identity.hostname, "string");

  const execCall = await request("tools/call", {
    name: "exec_argv",
    arguments: {
      program: "python",
      args: ["-c", "print('reliable-ssh-windows-smoke')"],
    },
  });
  assert.equal(execCall.isError, undefined);
  const execution = JSON.parse(execCall.content[0].text);
  assert.equal(execution.exit_code, 0);
  assert.match(execution.stdout.text, /reliable-ssh-windows-smoke/u);
  console.log(JSON.stringify({ hostname: identity.hostname, tools: listed.tools.length }));
} finally {
  await stop();
}
