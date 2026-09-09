import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAuditLogger, summarizeToolArguments } from "../src/audit.js";

test("audit summary redacts common secret argv values", () => {
  const summary = summarizeToolArguments("exec_argv", {
    program: "python3",
    args: [
      "--token",
      "secret-value",
      "--api-key=another-secret",
      "-c",
      "print('inline secret')",
      "visible",
    ],
    env: { PRIVATE_TOKEN: "not logged", SAFE: "also not logged" },
  });

  assert.equal(summary.args[0], "--token");
  assert.equal(summary.args[1], "***");
  assert.equal(summary.args[2], "--api-key=***");
  assert.equal(summary.args[3], "-c");
  assert.match(
    summary.args[4],
    /^<inline-code sha256=[a-f0-9]{64} bytes=22>$/u,
  );
  assert.match(summary.args[5], /^<arg sha256=[a-f0-9]{64} bytes=7>$/u);
  assert.deepEqual(summary.env_keys, ["PRIVATE_TOKEN", "SAFE"]);
  assert.equal(JSON.stringify(summary).includes("secret-value"), false);
  assert.equal(JSON.stringify(summary).includes("another-secret"), false);
  assert.equal(JSON.stringify(summary).includes("not logged"), false);
  assert.equal(JSON.stringify(summary).includes("inline secret"), false);
  assert.equal(JSON.stringify(summary).includes("visible"), false);
});

test("audit logger appends JSONL without stdout or file content", async () => {
  const auditPath = path.join(
    os.tmpdir(),
    `reliable-ssh-audit-${process.pid}-${Date.now()}.jsonl`,
  );
  const log = createAuditLogger({
    auditLog: auditPath,
    sshTarget: "test-host",
    mode: "unrestricted",
  });
  try {
    await log({
      tool: "write_file",
      args: { path: "/tmp/example", content: "private content" },
      allowed: true,
      result: {
        content: [
          { type: "text", text: JSON.stringify({ bytes_written: 15 }) },
        ],
      },
      startedAt: Date.now() - 5,
    });
    const line = (await readFile(auditPath, "utf8")).trim();
    const event = JSON.parse(line);
    assert.equal(event.tool, "write_file");
    assert.equal(event.success, true);
    assert.equal(line.includes("private content"), false);
    assert.match(event.arguments.content_sha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(auditPath, { force: true });
  }
});

test("managed session audit summaries do not expose commands or input", () => {
  const started = summarizeToolArguments("start_remote_session", {
    session_name: "training",
    program: "python3",
    args: ["train.py", "--token", "session-secret"],
    env: { API_TOKEN: "environment-secret" },
  });
  const input = summarizeToolArguments("send_remote_session_input", {
    session_name: "training",
    text: "interactive-secret",
  });
  assert.equal(JSON.stringify(started).includes("session-secret"), false);
  assert.equal(JSON.stringify(started).includes("environment-secret"), false);
  assert.equal(JSON.stringify(input).includes("interactive-secret"), false);
  assert.match(input.input_sha256, /^[a-f0-9]{64}$/u);
});
