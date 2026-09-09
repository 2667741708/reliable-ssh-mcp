import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";
import { persistentCommandArgs } from "../src/connection-pool.js";
import { buildRemoteDaemon } from "../src/remote-runner.js";


test("persistent Plink command uses the pinned key and Windows Python", () => {
  const config = parseConfig(
    [
      "--ssh-target",
      "administrator@192.0.2.20",
      "--ssh-flavor",
      "plink",
      "--ssh-command",
      "plink.exe",
      "--remote-python",
      "python",
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
  const args = persistentCommandArgs(
    config,
    'python -u -c "import base64;exec(base64.b64decode(\'QQ==\'))"',
  );

  assert.equal(args.includes("-batch"), true);
  assert.equal(args.includes("-hostkey"), true);
  assert.equal(args.includes("ssh-ed25519 AAAA"), true);
  assert.equal(args.includes("-pwfile"), true);
  assert.equal(args.at(-2), "administrator@192.0.2.20");
  assert.match(args.at(-1), /^python -u -c/u);
});

test("persistent OpenSSH command configures protocol keepalive", () => {
  const config = parseConfig([
    "--ssh-target",
    "server",
    "--keepalive-interval",
    "20",
  ]);
  const args = persistentCommandArgs(config, "python3 -u daemon.py");
  assert.equal(args.includes("ServerAliveInterval=20"), true);
  assert.equal(args.includes("ServerAliveCountMax=3"), true);
  assert.equal(args.includes("TCPKeepAlive=yes"), true);
});

test("persistent OpenSSH command pins dynamic onboarded host keys", () => {
  const config = {
    ...parseConfig(["--ssh-target", "research@192.0.2.3"]),
    proxyJump: "bastion",
    hostKeyAlias: "reliable-lab-node-01",
    knownHostsFile: "C:/temp/reliable-known-hosts",
  };
  const args = persistentCommandArgs(config, "python3 -u daemon.py");
  assert.equal(args.includes("bastion"), true);
  assert.equal(args.includes("HostKeyAlias=reliable-lab-node-01"), true);
  assert.equal(
    args.includes("UserKnownHostsFile=C:/temp/reliable-known-hosts"),
    true,
  );
  assert.equal(args.includes("StrictHostKeyChecking=yes"), true);
});

test("persistent remote daemon supports safe zip extraction", () => {
  const daemon = buildRemoteDaemon();
  assert.match(daemon, /zipfile\.is_zipfile/u);
  assert.match(daemon, /Archive member escapes destination/u);
  assert.match(daemon, /format": "zip/u);
  assert.match(daemon, /start_tmux_session/u);
  assert.match(daemon, /scan_host_keys/u);
});
