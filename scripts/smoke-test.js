import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../src/config.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverEntry = path.join(projectRoot, "src", "index.js");
const serverArgs = process.argv.slice(2);
if (serverArgs.length === 0) {
  console.error(
    "Pass the reliable-ssh-mcp server arguments after npm run smoke --",
  );
  process.exit(2);
}
const configuredRoots = parseConfig(serverArgs).localRoots;
const transferRootEntry = Object.entries(configuredRoots)[0];
const transferRootName = transferRootEntry?.[0];
const transferRootPath = transferRootEntry?.[1];

const child = spawn(process.execPath, [serverEntry, ...serverArgs], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let buffer = "";
let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = nextId;
  nextId += 1;
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
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
    if (waiter) {
      pending.delete(message.id);
      if (message.error)
        waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", (error) => {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
});

const timer = setTimeout(() => {
  child.kill("SIGKILL");
  console.error("MCP smoke test timed out.");
  process.exit(1);
}, 60000);

async function stopServer() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const closed = once(child, "close").then(() => true);
  const graceExpired = new Promise((resolve) =>
    setTimeout(() => resolve(false), 2000),
  );
  if (!(await Promise.race([closed, graceExpired]))) {
    child.kill("SIGKILL");
    await once(child, "close");
  }
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "reliable-ssh-smoke-test", version: "1.0.0" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );

  const listed = await request("tools/list", {});
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  assert.match(initialized.instructions, /Prefer exec_argv/u);
  const expectedTools = [
    "connection_status",
    "exec_argv",
    "list_local_roots",
    "list_remote_sessions",
    "probe_identity",
    "read_file",
    "read_remote_log",
    "read_remote_session",
    "remote_session_status",
    "run_bash_script",
    "send_remote_session_input",
    "start_remote_session",
    "stat_path",
    "stop_remote_session",
    "write_file",
  ];
  if (transferRootPath) expectedTools.push("download_file", "upload_file");
  assert.deepEqual(toolNames, expectedTools.sort());
  assert.equal(
    listed.tools.find((tool) => tool.name === "read_file").annotations
      .readOnlyHint,
    true,
  );
  assert.equal(
    listed.tools.find((tool) => tool.name === "write_file").annotations
      .destructiveHint,
    true,
  );

  const identityCall = await request("tools/call", {
    name: "probe_identity",
    arguments: { force: true },
  });
  assert.equal(identityCall.isError, undefined);
  const identity = JSON.parse(identityCall.content[0].text);

  const specialArgument = "spaces ' double\" $HOME ; | [brackets] 中文";
  const execCall = await request("tools/call", {
    name: "exec_argv",
    arguments: {
      program: "python3",
      args: [
        "-c",
        "import sys; print(sys.argv[1]); print('diagnostic on stderr', file=sys.stderr)",
        specialArgument,
      ],
    },
  });
  assert.equal(execCall.isError, undefined);
  const execution = JSON.parse(execCall.content[0].text);
  assert.equal(execution.exit_code, 0);
  assert.equal(execution.stdout.text.trim(), specialArgument);
  assert.equal(execution.stderr.text.trim(), "diagnostic on stderr");

  const remotePath = `/tmp/reliable-ssh-mcp-smoke-${process.pid}-${Date.now()}.txt`;
  const remoteContent = "reliable SSH MCP\n中文 and '$HOME'\n";
  let fileRoundTrip;
  try {
    const writeCall = await request("tools/call", {
      name: "write_file",
      arguments: { path: remotePath, content: remoteContent, mode: "0600" },
    });
    assert.equal(writeCall.isError, undefined);

    const statCall = await request("tools/call", {
      name: "stat_path",
      arguments: { path: remotePath },
    });
    assert.equal(statCall.isError, undefined);
    const stat = JSON.parse(statCall.content[0].text);
    assert.equal(stat.is_file, true);
    assert.equal(stat.mode, "0600");

    const readCall = await request("tools/call", {
      name: "read_file",
      arguments: { path: remotePath },
    });
    assert.equal(readCall.isError, undefined);
    const read = JSON.parse(readCall.content[0].text);
    assert.equal(read.content, remoteContent);

    const bashCall = await request("tools/call", {
      name: "run_bash_script",
      arguments: {
        script:
          "printf 'bash script via stdin: %s\\n' \"$RELIABLE_TEST_VALUE\"",
        env: { RELIABLE_TEST_VALUE: "中文 $HOME ; |" },
      },
    });
    assert.equal(bashCall.isError, undefined);
    const bash = JSON.parse(bashCall.content[0].text);
    assert.equal(bash.exit_code, 0);
    assert.equal(
      bash.stdout.text.trim(),
      "bash script via stdin: 中文 $HOME ; |",
    );

    fileRoundTrip = {
      write: JSON.parse(writeCall.content[0].text),
      stat,
      read,
      bash,
    };
  } finally {
    const cleanupCall = await request("tools/call", {
      name: "exec_argv",
      arguments: { program: "rm", args: ["--", remotePath] },
    });
    assert.equal(cleanupCall.isError, undefined);
  }

  let pathTransfer;
  if (transferRootPath) {
    const transferId = `${process.pid}-${Date.now()}`;
    const localSourceName = `.reliable-ssh-upload-${transferId}.txt`;
    const localDownloadName = `.reliable-ssh-download-${transferId}.txt`;
    const localSource = path.join(transferRootPath, localSourceName);
    const localDownload = path.join(transferRootPath, localDownloadName);
    const remoteTransferPath = `/tmp/reliable-ssh-transfer-${transferId}.txt`;
    const transferContent = "zero-context SCP transfer\n中文 '$HOME' ; |\n";
    try {
      await writeFile(localSource, transferContent, "utf8");
      const uploadCall = await request("tools/call", {
        name: "upload_file",
        arguments: {
          local_root: transferRootName,
          local_path: localSourceName,
          remote_path: remoteTransferPath,
        },
      });
      assert.equal(uploadCall.isError, undefined);
      const downloadCall = await request("tools/call", {
        name: "download_file",
        arguments: {
          remote_path: remoteTransferPath,
          local_root: transferRootName,
          local_path: localDownloadName,
        },
      });
      assert.equal(downloadCall.isError, undefined);
      assert.equal(await readFile(localDownload, "utf8"), transferContent);
      pathTransfer = {
        upload: JSON.parse(uploadCall.content[0].text),
        download: JSON.parse(downloadCall.content[0].text),
      };
    } finally {
      await request("tools/call", {
        name: "exec_argv",
        arguments: { program: "rm", args: ["-f", "--", remoteTransferPath] },
      });
      await rm(localSource, { force: true });
      await rm(localDownload, { force: true });
    }
  }

  console.log(
    JSON.stringify(
      {
        protocol_version: initialized.protocolVersion,
        tools: toolNames,
        identity,
        argv_round_trip: execution,
        file_and_bash_round_trip: fileRoundTrip,
        path_transfer_round_trip: pathTransfer,
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
  await stopServer();
}
