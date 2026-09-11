import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig } from "../src/config.js";
import { loadFleetConfig } from "../src/fleet-config.js";
import { createFleetServer } from "../src/fleet-server.js";
import { createReliableSshServer } from "../src/server.js";

test("single-server surface registers durable session and log tools", () => {
  const fakeClient = {
    invoke() {
      throw new Error("not called during registration");
    },
    transfer() {
      throw new Error("not called during registration");
    },
  };
  const server = createReliableSshServer(
    parseConfig(["--ssh-target", "example"]),
    fakeClient,
  );
  const names = Object.keys(server._registeredTools);
  for (const name of [
    "run_script",
    "start_remote_session",
    "list_remote_sessions",
    "remote_session_status",
    "read_remote_session",
    "read_remote_log",
    "send_remote_session_input",
    "stop_remote_session",
  ]) {
    assert.ok(names.includes(name), `Missing single-server tool ${name}`);
  }
});

test("fleet surface registers bastion discovery, onboarding, and session tools", async () => {
  const examplePath = fileURLToPath(
    new URL("../config/fleet.example.json", import.meta.url),
  );
  const fleet = await loadFleetConfig(examplePath);
  const runtime = createFleetServer(fleet);
  try {
    const names = Object.keys(runtime.server._registeredTools);
    assert.equal(names.length, 44);
    for (const name of [
      "run_script",
      "list_bastions",
      "reload_config",
      "get_execution_policy",
      "list_server_groups",
      "discover_lan_hosts",
      "inspect_lan_host_key",
      "onboard_discovered_host",
      "start_remote_session",
      "read_remote_session",
      "read_remote_log",
    ]) {
      assert.ok(names.includes(name), `Missing fleet tool ${name}`);
    }
  } finally {
    runtime.close();
  }
});

test("fixed readonly fleet exposes execution with readonly annotations and output schemas", async () => {
  const examplePath = fileURLToPath(
    new URL("../config/fleet.example.json", import.meta.url),
  );
  const fleet = await loadFleetConfig(examplePath);
  fleet.servers.example_gpu.mode = "readonly";
  fleet.servers.example_gpu.readOnlyPrograms = ["hostname", "nvidia-smi", "find"];
  fleet.servers.example_gpu.auditLog = undefined;
  const runtime = createFleetServer(fleet, { server: "example_gpu" });
  const client = new Client({ name: "registration-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    for (const name of ["exec_argv", "run_template"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `Missing fixed readonly tool ${name}`);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.outputSchema.type, "object");
    }
    const denied = await client.callTool({
      name: "exec_argv",
      arguments: { program: "find", args: ["/tmp", "-delete"] },
    });
    assert.equal(denied.isError, true);
    const deniedText = JSON.parse(denied.content[0].text);
    assert.equal(deniedText.code, "READONLY_PROFILE_UNAVAILABLE");
    assert.equal(denied.structuredContent.code, deniedText.code);
    assert.equal(denied.structuredContent.suggested_tool, undefined);
    assert.equal(denied.structuredContent.next_step, deniedText.next_step);
  } finally {
    await client.close();
    runtime.close();
  }
});
