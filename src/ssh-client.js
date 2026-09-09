import { spawn } from "node:child_process";

import { buildRemoteRunner, parseRemoteResponse } from "./remote-runner.js";
import { remoteExecutable } from "./remote-command.js";
import { plinkArgs } from "./plink-args.js";

const MAX_RUNNER_RESPONSE_BYTES = 48 * 1024 * 1024;

function routeArgs(config) {
  const args = [];
  if (config.proxyJump) args.push("-J", config.proxyJump);
  if (config.proxyCommand)
    args.push("-o", `ProxyCommand=${config.proxyCommand}`);
  if (config.identityFile) args.push("-i", config.identityFile);
  if (config.hostKeyAlias)
    args.push("-o", `HostKeyAlias=${config.hostKeyAlias}`);
  if (config.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${config.knownHostsFile}`);
    args.push("-o", "StrictHostKeyChecking=yes");
  }
  if (config.keepaliveIntervalSec > 0) {
    args.push("-o", `ServerAliveInterval=${config.keepaliveIntervalSec}`);
    args.push("-o", "ServerAliveCountMax=3");
    args.push("-o", "TCPKeepAlive=yes");
  }
  return args;
}

function commandArgs(config, command) {
  if (config.sshFlavor !== "plink") {
    return [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${config.connectTimeoutSec}`,
      ...routeArgs(config),
      config.sshTarget,
      ...command,
    ];
  }

  return plinkArgs(config, command);
}

export class ReliableSshClient {
  constructor(config) {
    this.config = config;
  }

  invoke(payload) {
    const runner = buildRemoteRunner(payload);
    const timeoutSec = payload.timeout_seconds ?? this.config.commandTimeoutSec;
    const localTimeoutMs =
      (timeoutSec + this.config.connectTimeoutSec + 10) * 1000;
    const args = commandArgs(this.config, [remoteExecutable(this.config), "-"]);

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.sshCommand, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let settled = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new Error(`SSH transport timed out after ${localTimeoutMs}ms`),
          ),
        );
      }, localTimeoutMs);

      child.on("error", (error) =>
        finish(() =>
          reject(new Error(`Could not start SSH: ${error.message}`)),
        ),
      );
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_RUNNER_RESPONSE_BYTES) {
          child.kill("SIGKILL");
          finish(() =>
            reject(
              new Error(
                "Remote runner response exceeded the local safety limit",
              ),
            ),
          );
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
      child.on("close", (code, signal) => {
        finish(() => {
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          if (code !== 0) {
            reject(
              new Error(
                `SSH exited with code ${code}${signal ? ` (${signal})` : ""}${stderr ? `: ${stderr}` : ""}`,
              ),
            );
            return;
          }
          try {
            resolve(parseRemoteResponse(stdout));
          } catch (error) {
            reject(
              new Error(
                `${error.message}${stderr ? `; SSH stderr: ${stderr}` : ""}`,
              ),
            );
          }
        });
      });

      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") {
          finish(() =>
            reject(
              new Error(`Could not send the remote runner: ${error.message}`),
            ),
          );
        }
      });
      child.stdin.end(runner, "utf8");
    });
  }

  transfer(direction, localPath, remotePath, options = {}) {
    if (/[\r\n\0]/u.test(remotePath)) {
      return Promise.reject(
        new Error("Remote path contains an invalid character"),
      );
    }
    const remoteSpec = `${this.config.sshTarget}:${remotePath}`;
    const source = direction === "upload" ? localPath : remoteSpec;
    const destination = direction === "upload" ? remoteSpec : localPath;
    const args = [
      "-q",
      "-p",
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${this.config.connectTimeoutSec}`,
      ...routeArgs(this.config),
      "--",
      source,
      destination,
    ];

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(this.config.scpCommand, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new Error(
              `SCP transfer timed out after ${this.config.transferTimeoutSec}s`,
            ),
          ),
        );
      }, this.config.transferTimeoutSec * 1000);

      const abort = () => {
        child.kill("SIGKILL");
        finish(() =>
          reject(options.signal?.reason ?? new Error("SCP transfer cancelled")),
        );
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });

      child.on("error", (error) =>
        finish(() =>
          reject(new Error(`Could not start SCP: ${error.message}`)),
        ),
      );
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("close", (code, signal) => {
        finish(() => {
          options.signal?.removeEventListener("abort", abort);
          const stderrText = Buffer.concat(stderr).toString("utf8").trim();
          if (code !== 0) {
            reject(
              new Error(
                `SCP exited with code ${code}${signal ? ` (${signal})` : ""}${stderrText ? `: ${stderrText}` : ""}`,
              ),
            );
            return;
          }
          resolve({
            direction,
            local_path: localPath,
            remote_path: remotePath,
            duration_ms: Date.now() - startedAt,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: stderrText,
          });
        });
      });
    });
  }
}
