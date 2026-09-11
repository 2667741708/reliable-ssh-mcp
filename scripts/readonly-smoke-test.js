import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { parseConfig } from "../src/config.js";
import { loadFleetConfig } from "../src/fleet-config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectRoot, "src", "index.js");
const serverArgs = process.argv.slice(2);

if (serverArgs.length === 0) {
  console.error("Pass server arguments after npm run smoke:readonly --");
  process.exit(2);
}

const launch = parseConfig(serverArgs);
let selectedServer;
if (launch.fleetConfig) {
  const fleet = await loadFleetConfig(launch.fleetConfig);
  selectedServer = launch.selectedServer
    ? fleet.servers[launch.selectedServer]
    : Object.values(fleet.servers).find((server) => server.mode === "readonly");
  if (!selectedServer) {
    throw new Error("Fleet read-only smoke requires --server <readonly-server> or at least one readonly server");
  }
  if (selectedServer.mode !== "readonly") {
    throw new Error(`Server ${selectedServer.name} is not configured readonly`);
  }
} else if (launch.mode !== "readonly") {
  throw new Error("Single-server read-only smoke requires --mode readonly");
}

const fixedFleet = Boolean(launch.fleetConfig && launch.selectedServer);
const target = launch.fleetConfig && !fixedFleet
  ? { server: selectedServer.name }
  : {};
const client = new Client({ name: "reliable-ssh-readonly-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, ...serverArgs],
  cwd: projectRoot,
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  for (const name of ["probe_identity", "stat_path"]) {
    assert.ok(listed.tools.some((tool) => tool.name === name), `Missing ${name}`);
  }
  for (const tool of listed.tools) {
    assert.equal(tool.outputSchema?.type, "object", `${tool.name} lacks outputSchema`);
  }

  const identity = await client.callTool({
    name: "probe_identity",
    arguments: { ...target, force: true },
  });
  assert.equal(identity.isError, undefined);
  assert.deepEqual(identity.structuredContent.data, JSON.parse(identity.content[0].text));

  const stat = await client.callTool({
    name: "stat_path",
    arguments: { ...target, path: "." },
  });
  assert.equal(stat.isError, undefined);
  assert.deepEqual(stat.structuredContent.data, JSON.parse(stat.content[0].text));

  let command;
  if (launch.fleetConfig) {
    const policy = await client.callTool({
      name: "get_execution_policy",
      arguments: target,
    });
    assert.equal(policy.isError, undefined);
    const configured = policy.structuredContent.data.read_only_programs;
    const program = ["hostname", "uptime", "uname", "whoami"]
      .find((candidate) => configured.includes(candidate));
    if (program) {
      const result = await client.callTool({
        name: "exec_argv",
        arguments: { ...target, program, args: [] },
      });
      assert.equal(result.isError, undefined);
      command = program;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    server: selectedServer?.name ?? launch.sshTarget,
    checks: ["initialize", "output_schema", "identity", "stat"],
    ...(command ? { readonly_command: command } : {}),
  }, null, 2));
} finally {
  await client.close();
}
