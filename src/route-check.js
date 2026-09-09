import { isIP } from "node:net";
import { spawn } from "node:child_process";

export function parseEffectiveHostname(output) {
  const line = String(output)
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => /^hostname\s+/iu.test(item));
  return line ? line.split(/\s+/u)[1] : undefined;
}

export function validateEffectiveRoute(output, config) {
  const effectiveHostname = parseEffectiveHostname(output);
  const expectedRouteHost = config.expectedRouteHost ?? config.expectedIp;
  if (!effectiveHostname) {
    throw new Error(
      `Could not read the effective SSH HostName for ${config.sshTarget}`,
    );
  }
  if (
    expectedRouteHost &&
    isIP(effectiveHostname) &&
    effectiveHostname !== expectedRouteHost
  ) {
    throw new Error(
      `SSH route mismatch for ${config.sshTarget}: OpenSSH resolves to ${effectiveHostname}, but MCP expected route host is ${expectedRouteHost}. Update the MCP registration or SSH alias together.`,
    );
  }
  return effectiveHostname;
}

export function verifyConfiguredRoute(config) {
  if (config.sshFlavor && config.sshFlavor !== "openssh") return Promise.resolve();
  if (!config.expectedRouteHost && !config.expectedIp) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const child = spawn(config.sshCommand, ["-G", config.sshTarget], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out while checking the local SSH route for ${config.sshTarget}`,
        ),
      );
    }, Math.max(5000, (config.connectTimeoutSec ?? 15) * 1000));

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not inspect the local SSH route: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const details = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            `Could not inspect the local SSH route for ${config.sshTarget}${details ? `: ${details}` : ""}`,
          ),
        );
        return;
      }
      try {
        validateEffectiveRoute(Buffer.concat(stdout).toString("utf8"), config);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}
