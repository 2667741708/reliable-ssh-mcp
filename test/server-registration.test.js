import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
