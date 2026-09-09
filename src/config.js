import path from "node:path";
import { loadServerInfo } from "./server-info.js";

import {
  localRootsFromEnvironment,
  parseLocalRootSpecs,
} from "./local-roots.js";

const INTEGER_OPTIONS = new Map([
  [
    "connect-timeout",
    { key: "connectTimeoutSec", min: 1, max: 120, fallback: 15 },
  ],
  [
    "command-timeout",
    { key: "commandTimeoutSec", min: 1, max: 3600, fallback: 60 },
  ],
  [
    "max-output-bytes",
    {
      key: "maxOutputBytes",
      min: 1024,
      max: 16 * 1024 * 1024,
      fallback: 1024 * 1024,
    },
  ],
  [
    "transfer-timeout",
    { key: "transferTimeoutSec", min: 1, max: 86400, fallback: 600 },
  ],
  [
    "pool-size",
    { key: "poolSize", min: 0, max: 8, fallback: 0 },
  ],
  [
    "keepalive-interval",
    { key: "keepaliveIntervalSec", min: 0, max: 300, fallback: 0 },
  ],
  [
    "heartbeat-interval",
    { key: "heartbeatIntervalSec", min: 0, max: 3600, fallback: 0 },
  ],
]);

const STRING_OPTIONS = new Map([
  ["ssh-target", "sshTarget"],
  ["server-info-file", "serverInfoFile"],
  ["ssh-flavor", "sshFlavor"],
  ["ssh-command", "sshCommand"],
  ["scp-command", "scpCommand"],
  ["remote-python", "remotePython"],
  ["password-file", "passwordFile"],
  ["proxy-command", "proxyCommand"],
  ["host-key", "hostKey"],
  ["expected-hostname", "expectedHostname"],
  ["expected-ip", "expectedIp"],
  ["expected-route-host", "expectedRouteHost"],
  ["expected-gpu", "expectedGpu"],
  ["audit-log", "auditLog"],
  ["mode", "mode"],
  ["fleet-config", "fleetConfig"],
  ["server", "selectedServer"],
  ["route", "selectedRoute"],
  ["client-roots", "clientRootsMode"],
]);

function readArguments(argv) {
  const values = new Map();
  const addValue = (name, value) => {
    if (name === "local-root") {
      values.set(name, [...(values.get(name) ?? []), value]);
      return;
    }
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    values.set(name, value);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const equalsAt = token.indexOf("=");
    if (equalsAt >= 0) {
      addValue(token.slice(2, equalsAt), token.slice(equalsAt + 1));
      continue;
    }

    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    addValue(name, value);
    index += 1;
  }
  return values;
}

function parseInteger(name, rawValue, rule) {
  const value = rawValue === undefined ? rule.fallback : Number(rawValue);
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
    throw new Error(
      `--${name} must be an integer between ${rule.min} and ${rule.max}`,
    );
  }
  return value;
}

export function parseConfig(
  argv,
  platform = process.platform,
  environment = process.env,
  workingDirectory = process.cwd(),
) {
  const values = readArguments(argv);
  const knownNames = new Set([
    ...STRING_OPTIONS.keys(),
    ...INTEGER_OPTIONS.keys(),
    "local-root",
  ]);
  for (const name of values.keys()) {
    if (!knownNames.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
  }

  const config = {
    sshCommand: platform === "win32" ? "ssh.exe" : "ssh",
    scpCommand: platform === "win32" ? "scp.exe" : "scp",
    remotePython: "python3",
    sshFlavor: "openssh",
    mode: "unrestricted",
    clientRootsMode: "fallback",
  };

  for (const [name, key] of STRING_OPTIONS) {
    const value = values.get(name);
    if (value !== undefined) {
      config[key] = value;
    }
  }

  for (const [name, rule] of INTEGER_OPTIONS) {
    config[rule.key] = parseInteger(name, values.get(name), rule);
  }

  const rootSpecs = values.get("local-root") ?? [];
  config.localRoots =
    rootSpecs.length > 0
      ? parseLocalRootSpecs(rootSpecs, workingDirectory, environment)
      : localRootsFromEnvironment(environment, workingDirectory);

  if (!config.sshTarget && !config.fleetConfig) {
    throw new Error("Missing required --ssh-target or --fleet-config");
  }
  if (config.fleetConfig) {
    const allowed = new Set(["fleet-config", "server", "route", "local-root", "client-roots"]);
    for (const name of values.keys()) {
      if (!allowed.has(name)) throw new Error("--" + name + " must be configured in the fleet registry, not the launcher");
    }
    if (config.selectedRoute && !config.selectedServer) throw new Error("--route requires --server");
  } else if (config.selectedServer || config.selectedRoute) {
    throw new Error("--server and --route require --fleet-config");
  }
  if (config.sshTarget && /[\r\n\0]/u.test(config.sshTarget)) {
    throw new Error("--ssh-target contains an invalid character");
  }
  if (!["openssh", "plink"].includes(config.sshFlavor)) {
    throw new Error("--ssh-flavor must be openssh or plink");
  }
  if (!["disabled", "fallback", "merge"].includes(config.clientRootsMode)) {
    throw new Error("--client-roots must be disabled, fallback, or merge");
  }
  for (const [key, option] of [
    ["remotePython", "--remote-python"],
    ["passwordFile", "--password-file"],
    ["hostKey", "--host-key"],
    ["proxyCommand", "--proxy-command"],
  ]) {
    if (config[key] && /[\r\n\0]/u.test(config[key])) {
      throw new Error(`${option} contains an invalid character`);
    }
  }
  config.sshCommand = path.normalize(config.sshCommand);
  config.scpCommand = path.normalize(config.scpCommand);
  if (config.passwordFile) config.passwordFile = path.resolve(config.passwordFile);
  if (config.sshFlavor === "plink" && !config.hostKey) {
    throw new Error("--host-key is required when --ssh-flavor is plink");
  }
  if (!new Set(["unrestricted", "readonly"]).has(config.mode)) {
    throw new Error("--mode must be unrestricted or readonly");
  }
  if (config.auditLog) config.auditLog = path.resolve(config.auditLog);
  if (config.fleetConfig) config.fleetConfig = path.resolve(config.fleetConfig);
  config.serverInfo = loadServerInfo(config, workingDirectory);
  return config;
}

export function usage() {
  return [
    "Usage: reliable-ssh-mcp --ssh-target <ssh-config-alias> [options]",
    "",
    "Options:",
    "  --server-info-file <path>    JSON hardware inventory visible in MCP instructions and get_server_info.",
    "  --ssh-flavor <name>          SSH transport: openssh or plink (default: openssh).",
    "  --expected-hostname <name>   Require an exact remote hostname.",
    "  --expected-ip <address>      Require this remote IP address.",
    "  --expected-route-host <host> Require the effective local SSH HostName; defaults to expected-ip.",
    "  --expected-gpu <substring>   Require a matching NVIDIA GPU name.",
    "  --connect-timeout <seconds>  SSH connection timeout (default: 15).",
    "  --command-timeout <seconds>  Remote command timeout (default: 60).",
    "  --transfer-timeout <seconds> File transfer timeout (default: 600).",
    "  --pool-size <count>          Persistent command sessions, 0 disables (default: 0).",
    "  --keepalive-interval <sec>   SSH protocol keepalive for OpenSSH, 0 disables (default: 0).",
    "  --heartbeat-interval <sec>   Idle read-only identity probe, 0 disables (default: 0).",
    "  --max-output-bytes <bytes>   Per-stream returned output cap (default: 1048576).",
    "  --ssh-command <path>         OpenSSH client path (default: ssh.exe on Windows).",
    "  --scp-command <path>         OpenSSH scp path (default: scp.exe on Windows).",
    "  --remote-python <command>    Remote Python command (default: python3).",
    "  --password-file <path>       Plink password file used for non-interactive login.",
    "  --proxy-command <command>    Explicit transport proxy command; Plink uses -proxycmd.",
    "  --host-key <key>             Plink host-key fingerprint or full public key.",
    "  --local-root [name=]<path>   Add an allowed local root; repeat for project/shared roots.",
    "  --client-roots <mode>         Client Roots: fallback (default), merge, or disabled.",
    "                               A bare path names the root project; relative paths use cwd.",
    "  RELIABLE_SSH_LOCAL_ROOTS     JSON name-to-path object used when no --local-root is given.",
    "  --audit-log <path>           Append redacted JSONL audit events to this file.",
    "  --mode <mode>                unrestricted or readonly (default: unrestricted).",
    "  --fleet-config <path>        Start from the shared versioned server registry.",
    "  --server <name>              Expose only this registry server in an independent process.",
    "  --route <name>               Pin that process to this connection route.",
  ].join("\n");
}
