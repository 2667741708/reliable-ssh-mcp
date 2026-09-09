import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { mergedRawLocalRoots, normalizeLocalRoots } from "./local-roots.js";
import { loadServerInfo } from "./server-info.js";
import { compileRegistry } from "./registry.js";

const VALID_MODES = new Set(["unrestricted", "readonly", "restricted"]);
const VALID_GROUPS = new Set([
  "core",
  "files",
  "transfer",
  "archives",
  "templates",
  "connections",
  "tunnels",
  "tasks",
  "discovery",
  "sessions",
]);

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/u;

function stringArray(value, label) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

export function validateServer(
  name,
  raw,
  defaults,
  configDirectory,
  rootBaseDirectory,
  environment,
  overrideLocalRoots,
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Server ${name} must be an object`);
  }
  const merged = { ...defaults, ...raw, name };
  // Hardware inventory belongs to a specific host, never to fleet defaults.
  merged.serverInfo = loadServerInfo(raw, configDirectory);
  delete merged.serverInfoFile;
  if (!merged.sshTarget || /[\r\n\0]/u.test(merged.sshTarget)) {
    throw new Error(`Server ${name} requires a valid sshTarget`);
  }
  merged.mode = merged.mode ?? "restricted";
  if (!VALID_MODES.has(merged.mode))
    throw new Error(`Server ${name} has invalid mode ${merged.mode}`);
  merged.toolGroups = stringArray(
    merged.toolGroups ?? [...VALID_GROUPS],
    `Server ${name} toolGroups`,
  );
  for (const group of merged.toolGroups) {
    if (!VALID_GROUPS.has(group))
      throw new Error(`Server ${name} has unknown tool group ${group}`);
  }
  merged.allowPrograms = stringArray(
    merged.allowPrograms,
    `Server ${name} allowPrograms`,
  );
  merged.denyPrograms = stringArray(
    merged.denyPrograms,
    `Server ${name} denyPrograms`,
  );
  merged.allowProgramPaths = stringArray(
    merged.allowProgramPaths,
    `Server ${name} allowProgramPaths`,
  );
  for (const programPath of merged.allowProgramPaths) {
    if (!path.posix.isAbsolute(programPath) || /[\r\n\0]/u.test(programPath)) {
      throw new Error(`Server ${name} allowProgramPaths requires absolute paths`);
    }
  }
  if (merged.preferredPython !== undefined &&
      (typeof merged.preferredPython !== "string" ||
       !path.posix.isAbsolute(merged.preferredPython) || /[\r\n\0]/u.test(merged.preferredPython))) {
    throw new Error(`Server ${name} preferredPython requires an absolute path`);
  }
  merged.allowTemplates = stringArray(
    merged.allowTemplates,
    `Server ${name} allowTemplates`,
  );
  merged.allowScriptHashes = stringArray(
    merged.allowScriptHashes,
    `Server ${name} allowScriptHashes`,
  );
  merged.readOnlyPrograms = stringArray(
    merged.readOnlyPrograms,
    `Server ${name} readOnlyPrograms`,
  );
  merged.allowScripts = merged.allowScripts === true;
  merged.poolSize =
    Number.isInteger(merged.poolSize) &&
    merged.poolSize >= 1 &&
    merged.poolSize <= 8
      ? merged.poolSize
      : 2;
  merged.connectTimeoutSec = merged.connectTimeoutSec ?? 15;
  merged.commandTimeoutSec = merged.commandTimeoutSec ?? 90;
  merged.transferTimeoutSec = merged.transferTimeoutSec ?? 600;
  merged.maxOutputBytes = merged.maxOutputBytes ?? 1024 * 1024;
  merged.sshCommand =
    merged.sshCommand ?? (process.platform === "win32" ? "ssh.exe" : "ssh");
  merged.sshFlavor = merged.sshFlavor ?? "openssh";
  if (!["openssh", "plink"].includes(merged.sshFlavor)) throw new Error("Invalid sshFlavor for " + name);
  if (merged.sshFlavor === "plink" && !merged.hostKey) throw new Error("Plink requires a pinned hostKey for " + name);
  merged.remotePython = merged.remotePython ?? "python3";
  merged.scpCommand =
    merged.scpCommand ?? (process.platform === "win32" ? "scp.exe" : "scp");
  const rawLocalRoots =
    overrideLocalRoots ?? mergedRawLocalRoots(defaults, raw);
  merged.localRoots = normalizeLocalRoots(
    rawLocalRoots,
    rootBaseDirectory,
    environment,
  );
  delete merged.localRoot;
  if (merged.auditLog)
    merged.auditLog = path.resolve(configDirectory, merged.auditLog);
  if (merged.identityFile)
    merged.identityFile = path.resolve(configDirectory, merged.identityFile);
  if (merged.knownHostsFile)
    merged.knownHostsFile = path.resolve(configDirectory, merged.knownHostsFile);
  return merged;
}

function validateIpv4Cidr(value, label) {
  const [address, prefixText, ...extra] = String(value).split("/");
  const prefix = Number(prefixText);
  if (
    extra.length > 0 ||
    isIP(address) !== 4 ||
    !Number.isInteger(prefix) ||
    prefix < 16 ||
    prefix > 32
  ) {
    throw new Error(`${label} must be an IPv4 CIDR between /16 and /32`);
  }
  return `${address}/${prefix}`;
}

function validateBastions(rawBastions = {}, servers) {
  const bastions = {};
  for (const [name, raw] of Object.entries(rawBastions)) {
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid bastion name ${name}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`Bastion ${name} must be an object`);
    if (!servers[raw.server])
      throw new Error(`Bastion ${name} references unknown server ${raw.server}`);
    const allowedCidrs = stringArray(
      raw.allowedCidrs,
      `Bastion ${name} allowedCidrs`,
    ).map((value) => validateIpv4Cidr(value, `Bastion ${name} CIDR`));
    if (allowedCidrs.length === 0)
      throw new Error(`Bastion ${name} requires at least one allowed CIDR`);
    const allowedPorts = raw.allowedPorts ?? [22];
    if (
      !Array.isArray(allowedPorts) ||
      allowedPorts.length === 0 ||
      allowedPorts.some(
        (port) => !Number.isInteger(port) || port < 1 || port > 65535,
      )
    ) {
      throw new Error(`Bastion ${name} allowedPorts must contain TCP ports`);
    }
    const maxHosts = raw.maxHosts ?? 256;
    if (!Number.isInteger(maxHosts) || maxHosts < 1 || maxHosts > 256)
      throw new Error(`Bastion ${name} maxHosts must be between 1 and 256`);
    bastions[name] = {
      name,
      server: raw.server,
      allowedCidrs,
      allowedPorts: [...new Set(allowedPorts)],
      maxHosts,
      defaultUser: raw.defaultUser,
      onboardDefaults: raw.onboardDefaults ?? {},
    };
  }
  return bastions;
}

function validateServerGroups(rawGroups = {}, servers) {
  const groups = {};
  for (const [name, members] of Object.entries(rawGroups)) {
    if (!NAME_PATTERN.test(name))
      throw new Error(`Invalid server group name ${name}`);
    groups[name] = stringArray(members, `Server group ${name}`);
    for (const member of groups[name]) {
      if (!servers[member])
        throw new Error(`Server group ${name} references unknown server ${member}`);
    }
  }
  return groups;
}

function validateTemplates(rawTemplates = {}) {
  const templates = {};
  for (const [name, raw] of Object.entries(rawTemplates)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`Template ${name} must be an object`);
    if (!raw.program || typeof raw.program !== "string")
      throw new Error(`Template ${name} requires program`);
    templates[name] = {
      name,
      description: raw.description ?? `Run ${name}`,
      program: raw.program,
      args: stringArray(raw.args, `Template ${name} args`),
      cwd: raw.cwd,
      env: raw.env ?? {},
      parameters: stringArray(raw.parameters, `Template ${name} parameters`),
      timeoutSeconds: raw.timeoutSeconds,
    };
  }
  return templates;
}

export async function loadFleetConfig(configPath, overrides = {}) {
  const absolutePath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absolutePath, "utf8"));
  if (![1, 2].includes(raw.version))
    throw new Error("Fleet configuration version must be 1 or 2");
  if (!raw.servers || typeof raw.servers !== "object")
    throw new Error("Fleet configuration requires servers");
  const configDirectory = path.dirname(absolutePath);
  const defaults = raw.defaults ?? {};
  const rootBaseDirectory = overrides.workingDirectory ?? process.cwd();
  const environment = overrides.environment ?? process.env;
  const registry = compileRegistry(raw, (name, server) => validateServer(
    name, server, defaults, configDirectory, rootBaseDirectory, environment, overrides.localRoots,
  ));
  const { servers } = registry;
  const bastions = validateBastions(raw.bastions, servers);
  const serverGroups = validateServerGroups(raw.serverGroups, servers);
  return {
    version: raw.version,
    path: absolutePath,
    reload: () => loadFleetConfig(absolutePath, overrides),
    ...registry,
    bastions,
    serverGroups,
    clientRootsMode: overrides.clientRootsMode ?? "fallback",
    templates: validateTemplates(raw.templates),
    namedForwards: raw.namedForwards ?? {},
    createServer(name, server) {
      if (!NAME_PATTERN.test(name)) throw new Error(`Invalid server name ${name}`);
      return validateServer(
        name,
        server,
        defaults,
        configDirectory,
        rootBaseDirectory,
        environment,
        overrides.localRoots,
      );
    },
  };
}

export const TOOL_GROUPS = [...VALID_GROUPS];
