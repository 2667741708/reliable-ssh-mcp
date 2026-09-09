import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadFleetConfig } from "../src/fleet-config.js";

test("fleet config merges defaults and validates groups", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reliable-fleet-"));
  const configPath = path.join(directory, "fleet.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        defaults: {
          mode: "restricted",
          toolGroups: ["core"],
          allowPrograms: ["git"],
        },
        servers: { one: { sshTarget: "alias", expectedHostname: "host" } },
        templates: { status: { program: "git", args: ["status"] } },
      }),
      "utf8",
    );
    const fleet = await loadFleetConfig(configPath);
    assert.equal(fleet.servers.one.mode, "restricted");
    assert.deepEqual(fleet.servers.one.allowPrograms, ["git"]);
    assert.equal(fleet.servers.one.remotePython, "python3");
    assert.equal(fleet.templates.status.program, "git");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public fleet example is valid and contains no local fleet details", async () => {
  const examplePath = fileURLToPath(
    new URL("../config/fleet.example.json", import.meta.url),
  );
  const fleet = await loadFleetConfig(examplePath);
  assert.deepEqual(Object.keys(fleet.servers), [
    "example_bastion",
    "example_gpu",
  ]);
  assert.equal(fleet.servers.example_gpu.expectedIp, "192.0.2.10");
  assert.equal(fleet.servers.example_gpu.sshTarget, "example-gpu");
  assert.equal(fleet.servers.example_gpu.proxyJump, "example-bastion");
  assert.equal(fleet.servers.example_gpu.localRoots.project, process.cwd());
  assert.deepEqual(fleet.bastions.example_lan.allowedCidrs, [
    "192.0.2.0/28",
  ]);
  assert.deepEqual(fleet.serverGroups.gpu_nodes, ["example_gpu"]);
});

test("fleet exposes a validated factory for ephemeral discovered servers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reliable-fleet-"));
  const configPath = path.join(directory, "fleet.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        servers: { jump: { sshTarget: "jump" } },
        bastions: {
          lab: {
            server: "jump",
            allowedCidrs: ["192.0.2.0/28"],
            allowedPorts: [22],
          },
        },
        serverGroups: { discovered: [] },
      }),
      "utf8",
    );
    const fleet = await loadFleetConfig(configPath);
    const dynamic = fleet.createServer("node_01", {
      sshTarget: "research@192.0.2.3",
      proxyJump: "jump",
      expectedIp: "192.0.2.3",
    });
    assert.equal(dynamic.proxyJump, "jump");
    assert.equal(dynamic.mode, "restricted");
    assert.deepEqual(fleet.serverGroups.discovered, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fleet local roots merge by name and can be overridden for one project", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reliable-fleet-"));
  const configPath = path.join(directory, "fleet.json");
  const projectRoot = path.join(directory, "project");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        defaults: {
          localRoots: { project: "default-root", shared: "shared-root" },
        },
        servers: {
          inherited: { sshTarget: "inherited" },
          explicit: {
            sshTarget: "explicit",
            localRoots: { project: "server-root", scratch: "scratch-root" },
          },
        },
      }),
      "utf8",
    );
    const configured = await loadFleetConfig(configPath, {
      workingDirectory: directory,
    });
    assert.deepEqual(configured.servers.explicit.localRoots, {
      project: path.join(directory, "server-root"),
      shared: path.join(directory, "shared-root"),
      scratch: path.join(directory, "scratch-root"),
    });
    const fleet = await loadFleetConfig(configPath, {
      localRoots: { project: projectRoot },
    });
    assert.deepEqual(fleet.servers.inherited.localRoots, {
      project: projectRoot,
    });
    assert.deepEqual(fleet.servers.explicit.localRoots, {
      project: projectRoot,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
