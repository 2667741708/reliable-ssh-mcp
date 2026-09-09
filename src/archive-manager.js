import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  commitDownloadedDirectory,
  discardTemporaryPath,
  prepareDownloadDirectory,
  resolveUploadDirectory,
} from "./local-path.js";

function runTar(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar.exe", args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) =>
      reject(new Error(`Could not start local tar: ${error.message}`)),
    );
    const abort = () => child.kill("SIGKILL");
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted)
        reject(signal.reason ?? new Error("Archive operation cancelled"));
      else if (code !== 0)
        reject(
          new Error(
            `Local tar exited with ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      else resolve();
    });
  });
}

async function bestEffortRemoteRemove(pool, remotePath) {
  try {
    await pool.invoke({
      operation: "process",
      program: "rm",
      args: ["-f", "--", remotePath],
      env: {},
      stdin_b64: "",
      timeout_seconds: 30,
      max_output_bytes: 4096,
    });
  } catch {}
}

export class ArchiveManager {
  constructor(server, pool, transferClient) {
    this.server = server;
    this.pool = pool;
    this.transferClient = transferClient;
  }

  async uploadDirectory({
    localPath,
    localRoot,
    remoteDirectory,
    lineEndings = "auto",
    signal,
    update,
  }) {
    const source = await resolveUploadDirectory(
      localRoot.path,
      localPath,
    );
    const id = randomUUID();
    const localArchive = path.join(
      os.tmpdir(),
      `reliable-ssh-upload-${id}.tar.gz`,
    );
    const remoteArchive = `/tmp/reliable-ssh-upload-${id}.tar.gz`;
    try {
      update({ stage: "packing", progress: 10 });
      await runTar(
        [
          "-czf",
          localArchive,
          "-C",
          path.dirname(source),
          path.basename(source),
        ],
        signal,
      );
      const archiveInfo = await stat(localArchive);
      update({
        stage: "uploading",
        progress: 35,
        archive_bytes: archiveInfo.size,
      });
      await this.transferClient.transfer(
        "upload",
        localArchive,
        remoteArchive,
        { signal },
      );
      update({ stage: "extracting", progress: 80 });
      const result = await this.pool.invoke({
        operation: "extract_archive",
        archive_path: remoteArchive,
        destination_path: remoteDirectory,
        line_endings: lineEndings,
      });
      return {
        ...result,
        local_root: localRoot.name,
        local_path: localPath,
        archive_bytes: archiveInfo.size,
      };
    } finally {
      await rm(localArchive, { force: true });
      await bestEffortRemoteRemove(this.pool, remoteArchive);
    }
  }

  async downloadDirectory({
    remotePath,
    localDirectory,
    localRoot,
    createParents,
    signal,
    update,
  }) {
    const local = await prepareDownloadDirectory(
      localRoot.path,
      localDirectory,
      createParents,
    );
    const id = randomUUID();
    const remoteArchive = `/tmp/reliable-ssh-download-${id}.tar.gz`;
    const localArchive = path.join(
      os.tmpdir(),
      `reliable-ssh-download-${id}.tar.gz`,
    );
    try {
      update({ stage: "packing_remote", progress: 10 });
      const packed = await this.pool.invoke({
        operation: "create_archive",
        source_path: remotePath,
        archive_path: remoteArchive,
      });
      update({
        stage: "downloading",
        progress: 35,
        archive_bytes: packed.size_bytes,
      });
      await this.transferClient.transfer(
        "download",
        localArchive,
        remoteArchive,
        { signal },
      );
      update({ stage: "extracting_local", progress: 80 });
      await runTar(["-xzf", localArchive, "-C", local.staging], signal);
      await commitDownloadedDirectory(local.staging, local.destination);
      return {
        source_path: remotePath,
        local_root: localRoot.name,
        local_directory: localDirectory,
        destination_path: local.destination,
        archive_bytes: packed.size_bytes,
      };
    } finally {
      await rm(localArchive, { force: true });
      await discardTemporaryPath(local.staging);
      await bestEffortRemoteRemove(this.pool, remoteArchive);
    }
  }
}
