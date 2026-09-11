import { createHash } from "node:crypto";
import path from "node:path";

import { evaluateReadOnlyCommand } from "./readonly-policy.js";

const MUTATING_TOOLS = new Set([
  "exec_argv",
  "run_bash_script",
  "run_script",
  "write_file",
  "upload_file",
  "download_file",
  "upload_directory",
  "download_directory",
  "onboard_discovered_host",
  "start_remote_session",
  "send_remote_session_input",
  "stop_remote_session",
  "start_local_forward",
  "start_socks_proxy",
  "close_tunnel",
  "restart_tunnel",
]);

function normalizedProgram(program) {
  return path.posix
    .basename(String(program).replaceAll("\\", "/"))
    .toLowerCase();
}

function readOnlyProgramDeclared(programs, program) {
  const requested = String(program ?? "");
  const hasPath = /[\\/]/u.test(requested);
  return programs.some((declared) => {
    if (hasPath) return declared === requested;
    return !/[\\/]/u.test(declared) &&
      normalizedProgram(declared) === normalizedProgram(requested);
  });
}

export function evaluatePolicy(server, tool, args = {}) {
  if (server.mode === "readonly" && MUTATING_TOOLS.has(tool)) {
    if (
      tool === "exec_argv" &&
      readOnlyProgramDeclared(server.readOnlyPrograms, args.program)
    ) {
      return evaluateReadOnlyCommand(args);
    }
    return {
      allowed: false,
      reason: `${tool} is blocked because ${server.name} is readonly`,
    };
  }

  if (["run_bash_script", "run_script"].includes(tool) && server.mode === "restricted") {
    if (!server.allowScripts) {
      return {
        allowed: false,
        reason: `Scripts are not allowed on ${server.name}`,
      };
    }
    const scriptHash = createHash("sha256")
      .update(args.script ?? "")
      .digest("hex");
    if (!server.allowScriptHashes.includes(scriptHash)) {
      return {
        allowed: false,
        reason: `Script hash is not allowlisted on ${server.name}`,
      };
    }
  }

  if (tool === "exec_argv") {
    const program = normalizedProgram(args.program);
    if (server.denyPrograms.map(normalizedProgram).includes(program)) {
      return {
        allowed: false,
        reason: `Program ${program} is denied on ${server.name}`,
      };
    }
    if (
      server.mode === "restricted" &&
      !server.allowPrograms.map(normalizedProgram).includes(program) &&
      !(server.allowProgramPaths ?? []).includes(args.program)
    ) {
      return {
        allowed: false,
        reason: `Program ${program} is not in the allowlist for ${server.name}`,
      };
    }
  }

  if (
    tool === "run_template" &&
    server.allowTemplates.length > 0 &&
    !server.allowTemplates.includes(args.template)
  ) {
    return {
      allowed: false,
      reason: `Template ${args.template} is not allowed on ${server.name}`,
    };
  }

  return { allowed: true };
}

export function groupAllowed(server, group) {
  return server.toolGroups.includes(group);
}
