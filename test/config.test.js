import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config.js";

test("parseConfig accepts both separated and equals-style options", () => {
  const config = parseConfig(
    [
      "--ssh-target",
      "example-gpu",
      "--expected-hostname=a-MS-7E06",
      "--expected-route-host=192.0.2.10",
      "--command-timeout",
      "90",
    ],
    "win32",
  );

  assert.equal(config.sshTarget, "example-gpu");
  assert.equal(config.expectedHostname, "a-MS-7E06");
  assert.equal(config.expectedRouteHost, "192.0.2.10");
  assert.equal(config.commandTimeoutSec, 90);
  assert.equal(config.sshCommand, "ssh.exe");
});

test("parseConfig rejects unknown options", () => {
  assert.throws(
    () => parseConfig(["--ssh-target", "host", "--surprise", "value"]),
    /Unknown option/u,
  );
});

test("parseConfig requires a target", () => {
  assert.throws(() => parseConfig([]), /Missing required --ssh-target/u);
});

test("parseConfig accepts the plink password transport", () => {
  const config = parseConfig(
    [
      "--ssh-target",
      "administrator@192.0.2.20",
      "--ssh-flavor",
      "plink",
      "--ssh-command",
      "plink.exe",
      "--password-file",
      "secrets/password.txt",
      "--host-key",
      "ssh-ed25519 AAAA",
      "--pool-size",
      "1",
      "--keepalive-interval",
      "30",
      "--heartbeat-interval",
      "60",
    ],
    "win32",
  );

  assert.equal(config.sshFlavor, "plink");
  assert.equal(config.remotePython, "python3");
  assert.equal(config.passwordFile.endsWith("secrets\\password.txt"), true);
  assert.equal(config.hostKey, "ssh-ed25519 AAAA");
  assert.equal(config.poolSize, 1);
  assert.equal(config.keepaliveIntervalSec, 30);
  assert.equal(config.heartbeatIntervalSec, 60);
});

test("parseConfig keeps persistent pooling opt-in", () => {
  const config = parseConfig(["--ssh-target", "host"]);
  assert.equal(config.poolSize, 0);
  assert.equal(config.keepaliveIntervalSec, 0);
  assert.equal(config.heartbeatIntervalSec, 0);
  assert.equal(config.clientRootsMode, "fallback");
});

test("parseConfig validates the client Roots mode", () => {
  const config = parseConfig([
    "--ssh-target",
    "host",
    "--client-roots",
    "merge",
  ]);
  assert.equal(config.clientRootsMode, "merge");
  assert.throws(
    () =>
      parseConfig([
        "--ssh-target",
        "host",
        "--client-roots",
        "always",
      ]),
    /--client-roots must be disabled, fallback, or merge/u,
  );
});

test("parseConfig validates pool and keepalive ranges", () => {
  assert.throws(
    () => parseConfig(["--ssh-target", "host", "--pool-size", "9"]),
    /--pool-size must be an integer between 0 and 8/u,
  );
  assert.throws(
    () => parseConfig(["--ssh-target", "host", "--keepalive-interval", "301"]),
    /--keepalive-interval must be an integer between 0 and 300/u,
  );
  assert.throws(
    () => parseConfig(["--ssh-target", "host", "--heartbeat-interval", "3601"]),
    /--heartbeat-interval must be an integer between 0 and 3600/u,
  );
});

test("parseConfig accepts a Windows remote Python command", () => {
  const config = parseConfig([
    "--ssh-target",
    "host",
    "--remote-python",
    "python",
  ]);

  assert.equal(config.remotePython, "python");
});

test("parseConfig accepts multiple named local roots relative to cwd", () => {
  const workingDirectory = path.resolve("portable-project");
  const config = parseConfig(
    [
      "--ssh-target",
      "host",
      "--local-root",
      "project=.",
      "--local-root",
      "shared=../shared",
    ],
    process.platform,
    {},
    workingDirectory,
  );
  assert.deepEqual(config.localRoots, {
    project: workingDirectory,
    shared: path.resolve(workingDirectory, "../shared"),
  });
});

test("a bare local root path is the project root", () => {
  const workingDirectory = path.resolve("portable-project");
  const config = parseConfig(
    ["--ssh-target", "host", "--local-root", "."],
    process.platform,
    {},
    workingDirectory,
  );
  assert.deepEqual(config.localRoots, { project: workingDirectory });
});

test("parseConfig reads named local roots from the environment", () => {
  const workingDirectory = path.resolve("portable-project");
  const config = parseConfig(
    ["--ssh-target", "host"],
    process.platform,
    { RELIABLE_SSH_LOCAL_ROOTS: '{"project":".","shared":"${SHARED}"}', SHARED: "../shared" },
    workingDirectory,
  );
  assert.equal(config.localRoots.project, workingDirectory);
  assert.equal(config.localRoots.shared, path.resolve(workingDirectory, "../shared"));
});

test("parseConfig rejects duplicate local root names", () => {
  assert.throws(
    () =>
      parseConfig([
        "--ssh-target",
        "host",
        "--local-root",
        "project=.",
        "--local-root",
        "project=elsewhere",
      ]),
    /Duplicate local root name project/u,
  );
});

test("parseConfig requires a pinned key for plink", () => {
  assert.throws(
    () =>
      parseConfig([
        "--ssh-target",
        "administrator@192.0.2.20",
        "--ssh-flavor",
        "plink",
      ]),
    /--host-key is required/u,
  );
});
