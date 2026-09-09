import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRemoteRunner,
  decodeCapturedStream,
  parseRemoteResponse,
} from "../src/remote-runner.js";

function runLocalRunner(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(`Local Python runner exited with ${code}: ${stderrText}`),
        );
        return;
      }
      try {
        resolve(parseRemoteResponse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(new Error(`${error.message}; stderr=${stderrText}`));
      }
    });
    child.stdin.end(buildRemoteRunner(payload), "utf8");
  });
}

test("process operation preserves argv and separates stderr from exit status", async () => {
  const specialArgument = "spaces ' double\" $HOME ; | [brackets] 中文";
  const result = await runLocalRunner({
    operation: "process",
    program: "python",
    args: [
      "-c",
      "import sys; print(sys.argv[1]); print('diagnostic', file=sys.stderr)",
      specialArgument,
    ],
    env: {},
    stdin_b64: "",
    timeout_seconds: 10,
    max_output_bytes: 1024 * 1024,
  });

  assert.equal(result.exit_code, 0);
  assert.equal(result.timed_out, false);
  assert.equal(
    decodeCapturedStream(result.stdout).text.trim(),
    specialArgument,
  );
  assert.equal(decodeCapturedStream(result.stderr).text.trim(), "diagnostic");
});

test("process operation kills a timed out process group", async () => {
  const result = await runLocalRunner({
    operation: "process",
    program: "python",
    args: ["-c", "import time; time.sleep(5)"],
    env: {},
    stdin_b64: "",
    timeout_seconds: 1,
    max_output_bytes: 1024,
  });

  assert.equal(result.timed_out, true);
  assert.notEqual(result.exit_code, 0);
  assert.ok(result.duration_ms < 4000);
});

test("write_file is atomic and read_file returns the same UTF-8 bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-mcp-"));
  const filePath = path.join(directory, "nested", "example.txt");
  const content = "alpha\n中文\nquotes: '$HOME'\n";

  try {
    const writeResult = await runLocalRunner({
      operation: "write_file",
      path: filePath,
      data_b64: Buffer.from(content, "utf8").toString("base64"),
      create_parents: true,
      atomic: true,
    });
    assert.equal(writeResult.bytes_written, Buffer.byteLength(content));
    assert.equal(await readFile(filePath, "utf8"), content);

    const readResult = await runLocalRunner({
      operation: "read_file",
      path: filePath,
      max_bytes: 1024,
    });
    assert.equal(
      Buffer.from(readResult.data_b64, "base64").toString("utf8"),
      content,
    );
    assert.equal(readResult.truncated, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("UTF-8 script writes normalize CRLF for the target platform", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-lines-"));
  const filePath = path.join(directory, "deploy.sh");
  const source = "#!/bin/sh\r\nprintf 'ok'\r\n";

  try {
    const result = await runLocalRunner({
      operation: "write_file",
      path: filePath,
      data_b64: Buffer.from(source, "utf8").toString("base64"),
      declared_text: true,
      line_endings: "auto",
      atomic: true,
    });
    const expected = process.platform === "win32"
      ? "#!/bin/sh\nprintf 'ok'\n"
      : "#!/bin/sh\nprintf 'ok'\n";
    assert.equal(await readFile(filePath, "utf8"), expected);
    assert.equal(result.line_endings, "lf");
    assert.equal(result.normalized, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic line-ending normalization preserves binary files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-binary-"));
  const filePath = path.join(directory, "payload.sh");
  const source = Buffer.from([0, 13, 10, 255]);

  try {
    await runLocalRunner({
      operation: "write_file",
      path: filePath,
      data_b64: source.toString("base64"),
      atomic: true,
    });
    const result = await runLocalRunner({
      operation: "normalize_text_file",
      path: filePath,
      line_endings: "auto",
    });
    assert.deepEqual(await readFile(filePath), source);
    assert.equal(result.normalized, false);
    assert.equal(result.reason, "not_confirmed_utf8_text");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("identity probe reports structured execution constraints", async () => {
  const identity = await runLocalRunner({ operation: "probe_identity" });
  assert.ok(["windows", "posix"].includes(identity.execution_context.platform));
  assert.ok(["lf", "crlf"].includes(identity.execution_context.native_line_endings));
  assert.equal(typeof identity.execution_context.python_executable, "string");
  assert.equal(identity.execution_context.transport, "structured_argv_and_stdin");
});

test("run_script selects an interpreter for the verified target", async () => {
  const identity = await runLocalRunner({ operation: "probe_identity" });
  const windows = identity.execution_context.platform === "windows";
  const result = await runLocalRunner({
    operation: "script",
    shell: "auto",
    script: windows ? "Write-Output 'hello'" : "printf 'hello\\n'",
    strict_mode: true,
    timeout_seconds: 10,
    max_output_bytes: 1024,
  });
  assert.equal(result.exit_code, 0);
  assert.equal(decodeCapturedStream(result.stdout).text.trim(), "hello");
  assert.ok(["bash", "sh", "pwsh", "powershell"].includes(result.shell));
  assert.ok(["lf", "crlf"].includes(result.script_line_endings));
});

test("directory extraction normalizes confirmed text members only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-tree-"));
  const source = path.join(directory, "source");
  const archive = path.join(directory, "source.tar.gz");
  const destination = path.join(directory, "destination");

  try {
    await runLocalRunner({
      operation: "write_file",
      path: path.join(source, "run.sh"),
      data_b64: Buffer.from("#!/bin/sh\r\necho ok\r\n", "utf8").toString("base64"),
      create_parents: true,
      atomic: true,
    });
    await runLocalRunner({
      operation: "create_archive",
      source_path: source,
      archive_path: archive,
    });
    const result = await runLocalRunner({
      operation: "extract_archive",
      archive_path: archive,
      destination_path: destination,
      line_endings: "auto",
    });
    assert.equal(
      await readFile(path.join(destination, "source", "run.sh"), "utf8"),
      "#!/bin/sh\necho ok\n",
    );
    assert.equal(result.normalized_text_files, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tail_file supports newest and incremental training log reads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reliable-ssh-mcp-"));
  const filePath = path.join(directory, "training.log");
  try {
    await runLocalRunner({
      operation: "write_file",
      path: filePath,
      data_b64: Buffer.from("epoch 1\nepoch 2\nepoch 3\n", "utf8").toString(
        "base64",
      ),
      create_parents: false,
      atomic: true,
    });
    const newest = await runLocalRunner({
      operation: "tail_file",
      path: filePath,
      max_bytes: 8,
    });
    assert.equal(
      Buffer.from(newest.data_b64, "base64").toString("utf8"),
      "epoch 3\n",
    );
    const incremental = await runLocalRunner({
      operation: "tail_file",
      path: filePath,
      offset_bytes: 8,
      max_bytes: 8,
    });
    assert.equal(incremental.offset_bytes, 8);
    assert.equal(incremental.next_offset_bytes, 16);
    assert.equal(incremental.has_more, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
