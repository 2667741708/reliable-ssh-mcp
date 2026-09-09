import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadServerInfo } from "../src/server-info.js";
import { parseConfig } from "../src/config.js";
import { loadFleetConfig } from "../src/fleet-config.js";
import { createFleetServer } from "../src/fleet-server.js";
import { createReliableSshServer } from "../src/server.js";

const info = {
  description: "GPU server 中文 " + "long description ".repeat(80).trim(),
  memoryGb: 64, storageTb: 4,
  gpus: [{model: "RTX 4090", count: 1, memoryGbPerGpu: 48}],
  usageGuidance: "Use file only after verifying the data disk mount.",
  verifiedAt: "2026-09-07T12:00:00Z",
};

test("inventory rejects malformed data without accepting connection secrets", () => {
  for (const serverInfo of [
    {memoryGb: -1}, {storageTb: "4"}, {gpus: [{model: "GPU", count: 0}]},
    {verifiedAt: "yesterday"}, {password: "secret"}, {usageGuidance: 10}, null,
  ]) assert.throws(() => loadServerInfo({serverInfo}));
  assert.throws(() => loadServerInfo({serverInfo: info, serverInfoFile: "both.json"}));
  assert.equal(loadServerInfo({}), undefined);
});

test("CLI and fleet resolve inventory paths and reject invalid JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ssh-info-"));
  try {
    await writeFile(path.join(directory, "info.json"), "\uFEFF" + JSON.stringify(info));
    const config = parseConfig(["--ssh-target", "offline", "--server-info-file", "info.json"], process.platform, {}, directory);
    assert.deepEqual(config.serverInfo, info);
    await writeFile(path.join(directory, "fleet.json"), JSON.stringify({
      version: 1,
      defaults: {serverInfo: {description: "Must not leak between hosts"}},
      servers: {one: {sshTarget: "offline", serverInfoFile: "info.json"}, two: {sshTarget: "other"}},
    }));
    const fleet = await loadFleetConfig(path.join(directory, "fleet.json"));
    assert.deepEqual(fleet.servers.one.serverInfo, info);
    assert.equal(fleet.servers.two.serverInfo, undefined);
    await writeFile(path.join(directory, "info.json"), "{broken");
    assert.throws(() => parseConfig(["--ssh-target", "offline", "--server-info-file", "info.json"], process.platform, {}, directory));
    await assert.rejects(loadFleetConfig(path.join(directory, "fleet.json")));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

async function withClient(server, action) {
  const client = new Client({name: "inventory-test", version: "1"});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await action(client);
  } finally { await client.close(); await server.close(); }
}

test("single-server MCP exposes full inventory and guidance without SSH", async () => {
  const config = {...parseConfig(["--ssh-target", "offline"]), serverInfo: info};
  const server = createReliableSshServer(config, {
    invoke() { throw new Error("Inventory must not invoke SSH"); },
    transfer() { throw new Error("Inventory must not transfer files"); },
  });
  await withClient(server, async (client) => {
    assert.ok(client.getInstructions().includes(info.usageGuidance));
    const result = await client.callTool({name: "get_server_info", arguments: {}});
    assert.ok(!result.isError);
    const saved = JSON.parse(result.content[0].text);
    assert.deepEqual(saved.server_info, info);
    assert.equal(saved.information_kind, "configured_inventory_not_live_status");
  });
});

test("fleet MCP lists per-host inventory, null for missing info, no secrets, and startup guidance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ssh-info-mcp-"));
  let runtime;
  try {
    await writeFile(path.join(directory, "fleet.json"), JSON.stringify({
      version: 1,
      servers: {
        one: {sshTarget: "offline", serverInfo: info, passwordFile: "SECRET_PATH", hostKey: "SECRET_KEY", toolGroups: ["core"]},
        two: {sshTarget: "another", toolGroups: ["core"], mode: "readonly"},
      },
    }));
    runtime = createFleetServer(await loadFleetConfig(path.join(directory, "fleet.json")));
    await withClient(runtime.server, async (client) => {
      assert.ok(client.getInstructions().includes(info.usageGuidance));
      const result = await client.callTool({name: "list_servers", arguments: {}});
      assert.ok(!result.isError);
      const rows = JSON.parse(result.content[0].text);
      assert.deepEqual(rows[0].server_info, info);
      assert.equal(rows[1].server_info, null);
      assert.ok(!result.content[0].text.includes("SECRET"));
      for (const name of ["one", "two"]) {
        const detail = await client.callTool({name: "get_server_info", arguments: {server: name}});
        assert.ok(!detail.isError);
        assert.deepEqual(JSON.parse(detail.content[0].text).server_info, name === "one" ? info : null);
        assert.ok(!detail.content[0].text.includes("SECRET"));
      }
      const missing = await client.callTool({name: "get_server_info", arguments: {server: "missing"}});
      assert.equal(missing.isError, true);
    });
  } finally { runtime?.close(); await rm(directory, {recursive: true, force: true}); }
});
