import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SECRET_NAME =
  /(password|passwd|passphrase|token|secret|api[_-]?key|credential)/iu;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function redactArgv(program, args = []) {
  let redactNext = false;
  let inlineCodeNext = false;
  const programName = String(program ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    .toLowerCase();
  const supportsInlineCode =
    /^(python\d*(\.exe)?|bash|sh|node(\.exe)?|pwsh(\.exe)?|powershell(\.exe)?)$/u.test(
      programName,
    );
  return args.map((value) => {
    if (redactNext) {
      redactNext = false;
      return "***";
    }
    if (inlineCodeNext) {
      inlineCodeNext = false;
      return `<inline-code sha256=${digest(value)} bytes=${Buffer.byteLength(value, "utf8")}>`;
    }
    const equalsAt = value.indexOf("=");
    if (equalsAt > 0 && SECRET_NAME.test(value.slice(0, equalsAt))) {
      return `${value.slice(0, equalsAt + 1)}***`;
    }
    if (SECRET_NAME.test(value) && value.startsWith("-")) {
      redactNext = true;
    }
    if (
      supportsInlineCode &&
      new Set(["-c", "-e", "--eval", "-command"]).has(value.toLowerCase())
    ) {
      inlineCodeNext = true;
    }
    if (value.startsWith("-") || value === "--") return value;
    return `<arg sha256=${digest(value)} bytes=${Buffer.byteLength(value, "utf8")}>`;
  });
}

export function summarizeToolArguments(tool, args) {
  switch (tool) {
    case "provide_connection_password":
    case "clear_connection_password":
      return { server: args.server, credential_action: tool, password: "***" };
    case "exec_argv":
      return {
        program: args.program,
        args: redactArgv(args.program, args.args),
        cwd: args.cwd,
        env_keys: Object.keys(args.env ?? {}).sort(),
        stdin_bytes: Buffer.byteLength(args.stdin ?? "", "utf8"),
      };
    case "run_bash_script":
    case "run_script":
      return {
        script_sha256: digest(args.script ?? ""),
        script_bytes: Buffer.byteLength(args.script ?? "", "utf8"),
        cwd: args.cwd,
        env_keys: Object.keys(args.env ?? {}).sort(),
        strict_mode: args.strict_mode ?? true,
        shell: args.shell ?? (tool === "run_script" ? "auto" : "bash"),
      };
    case "write_file":
      return {
        path: args.path,
        encoding: args.encoding ?? "utf8",
        content_sha256: digest(args.content ?? ""),
        content_chars: (args.content ?? "").length,
        atomic: args.atomic ?? true,
        mode: args.mode,
        line_endings: args.line_endings ?? (args.encoding === "base64" ? "preserve" : "auto"),
      };
    case "read_file":
      return {
        path: args.path,
        encoding: args.encoding ?? "utf8",
        max_bytes: args.max_bytes,
      };
    case "stat_path":
      return { path: args.path };
    case "read_remote_log":
      return {
        path: args.path,
        offset_bytes: args.offset_bytes,
        max_bytes: args.max_bytes,
      };
    case "start_remote_session":
      return {
        session_name: args.session_name,
        program: args.program,
        args: redactArgv(args.program, args.args),
        cwd: args.cwd,
        env_keys: Object.keys(args.env ?? {}).sort(),
        log_path: args.log_path,
      };
    case "send_remote_session_input":
      return {
        session_name: args.session_name,
        input_sha256: digest(args.text ?? ""),
        input_chars: (args.text ?? "").length,
        enter: args.enter ?? true,
      };
    case "remote_session_status":
    case "read_remote_session":
    case "stop_remote_session":
      return { session_name: args.session_name };
    case "discover_lan_hosts":
      return {
        bastion: args.bastion,
        cidr: args.cidr,
        port: args.port,
      };
    case "inspect_lan_host_key":
      return {
        bastion: args.bastion,
        discovery_id: args.discovery_id,
        host: args.host,
      };
    case "onboard_discovered_host":
      return {
        bastion: args.bastion,
        inspection_id: args.inspection_id,
        expected_fingerprint: args.expected_fingerprint,
        name: args.name,
        expected_hostname: args.expected_hostname,
        server_group: args.server_group,
      };
    case "upload_file":
    case "download_file":
      return {
        local_root: args.local_root ?? "project",
        local_path: args.local_path,
        remote_path: args.remote_path,
        line_endings: args.line_endings,
      };
    case "upload_directory":
      return {
        local_root: args.local_root ?? "project",
        local_path: args.local_path,
        remote_directory: args.remote_directory,
        line_endings: args.line_endings ?? "auto",
      };
    case "download_directory":
      return {
        local_root: args.local_root ?? "project",
        remote_path: args.remote_path,
        local_directory: args.local_directory,
      };
    case "run_template":
      return {
        template: args.template,
        parameter_names: Object.keys(args.parameters ?? {}).sort(),
      };
    case "start_local_forward":
      return {
        bind_host: args.bind_host,
        local_port: args.local_port,
        remote_host: args.remote_host,
        remote_port: args.remote_port,
      };
    case "start_socks_proxy":
      return { bind_host: args.bind_host, local_port: args.local_port };
    case "start_named_forward":
      return { forward: args.forward };
    case "task_status":
    case "cancel_task":
      return { task_id: args.task_id };
    case "close_tunnel":
    case "restart_tunnel":
      return { tunnel_id: args.tunnel_id };
    case "probe_identity":
      return { force: args.force ?? false };
    default:
      return {};
  }
}

function resultMetadata(result) {
  if (!result?.content?.[0]?.text) return {};
  try {
    const parsed = JSON.parse(result.content[0].text);
    return {
      exit_code: parsed.exit_code,
      timed_out: parsed.timed_out,
      duration_ms_remote: parsed.duration_ms,
      bytes_transferred: parsed.bytes_transferred,
      ...(parsed.error
        ? { result_error: String(parsed.error).slice(0, 500) }
        : {}),
    };
  } catch {
    return {};
  }
}

export function createAuditLogger(config) {
  return async function audit({
    tool,
    args,
    allowed,
    result,
    error,
    startedAt,
  }) {
    if (!config.auditLog) return;
    const entry = {
      timestamp: new Date().toISOString(),
      event_id: randomUUID(),
      target: config.sshTarget,
      tool,
      mode: config.mode,
      allowed,
      success: allowed && !error && !result?.isError,
      duration_ms_local: Date.now() - startedAt,
      arguments: summarizeToolArguments(tool, args),
      ...resultMetadata(result),
    };
    if (error) entry.error = String(error.message ?? error).slice(0, 500);
    await mkdir(path.dirname(config.auditLog), { recursive: true });
    await appendFile(config.auditLog, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
    });
  };
}
