# reliable-ssh-mcp

English | [简体中文](README.zh-CN.md)

Execution policy can now be inspected with `get_execution_policy` and reloaded
from disk with `reload_config`. See [exploration and training](docs/autonomous-training.md)
for interpreter selection, supported reload fields and the initial restart requirement.

`reliable-ssh-mcp` is a local STDIO MCP server for running structured commands and fleet operations on Linux/OpenSSH and Windows/OpenSSH or pinned-key Windows/Plink hosts. It avoids sending user-controlled command data through unnecessary shell quoting layers.

Version `0.9.0` adds a health-aware connection pool, bounded read-only probe recovery, parser-safe local code inspection and a fixed release-verification pipeline. It also supports fixed single-server instances and a unified fleet instance, including named local roots, controlled bastion discovery, fingerprint-pinned ephemeral onboarding, durable tmux-backed experiment sessions, and target-aware text line endings. See the [changelog](CHANGELOG.md).

Architecture decisions are documented in [docs/adr](docs/adr/0001-fleet-composition-and-structured-execution.md).

## Recommended reading order

This README keeps capability documentation grouped by topic so experienced
users can find a reference quickly. First-time users should read it in this
order instead of following the file strictly from top to bottom:

1. Read the introduction and **Use structured tools instead of shell strings**
   to understand the safety model.
2. Read **Start the server** and begin with one SSH alias.
3. Read **Client roots and publication safety** before uploading or downloading.
4. Read **Cross-platform scripts and line endings** before sending scripts.
5. Read **Run long experiments in managed tmux sessions** for durable jobs.
6. Read **Use the fleet server for multi-host operations**, then the bastion and
   unified-registry sections only when managing multiple machines.
7. Read password, inventory and Windows-persistence sections only when those
   deployment modes apply.
8. Contributors should finish with **Run the checks**, the
   [parser-safe inspection guide](docs/code-inspection.md), and the
   [changelog](CHANGELOG.md).

Version history is maintained in [CHANGELOG.md](CHANGELOG.md); the Chinese
version is [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## Use structured tools instead of shell strings

The server exposes structured execution, file, connection, and session tools:

- `probe_identity` verifies the hostname, IP addresses, operating system, and NVIDIA GPUs.
- `probe_identity.execution_context` reports the actual remote platform, shells, path separators, Python executable, and native line endings.
- `exec_argv` runs one program with an exact argument array and `shell=False`.
- `run_script` detects the verified target interpreter and executes a temporary Bash/Sh or PowerShell script with safe target encoding and line endings.
- `run_bash_script` sends a complete script through stdin and enables `set -Eeuo pipefail` by default.
- `stat_path` returns file metadata without parsing `ls` output.
- `read_file` reads UTF-8 or Base64 content without `cat` or heredocs.
- `write_file` writes UTF-8 or Base64 content atomically by default.
- `connection_status` reports persistent pool PIDs, handshakes, requests, heartbeats, and reconnects when pooling is enabled.
- `list_local_roots` reports the named local directories available to transfer tools.
- `start_remote_session` starts a detached tmux job with a durable combined stdout/stderr log.
- `list_remote_sessions`, `remote_session_status`, and `read_remote_session` observe running or completed jobs.
- `send_remote_session_input` and `stop_remote_session` control a managed session.
- `read_remote_log` reads the newest log bytes or continues from a returned offset.

It also exposes path-based transfer tools whose local side is restricted to named roots:

- `upload_file` copies a relative file from a selected root without putting its content in model context.
- `download_file` stages a remote file beside its destination, then publishes it atomically without overwriting an existing file.

Local tool parameters never accept absolute paths. Select `local_root: "project"`
or another name returned by `list_local_roots`, then pass a relative
`local_path`. A bare `--local-root .` is shorthand for
`--local-root project=.`. Repeat the option to allow more than one directory:

```powershell
node .\src\index.js `
  --ssh-target example-gpu `
  --local-root project=. `
  --local-root 'shared=${RELIABLE_SSH_SHARED_ROOT}'
```

Relative roots are resolved from the MCP process working directory. This lets a
project-scoped client launch the same published package in different projects
without changing the package or hard-coding a developer's drive path. When no
`--local-root` option is supplied, `RELIABLE_SSH_LOCAL_ROOTS` may contain a JSON
object such as
`{"project":".","shared":"${RELIABLE_SSH_SHARED_ROOT}"}`.

Each execution result separates `stdout`, `stderr`, `exit_code`, `timed_out`, `duration_ms`, and truncation metadata. Text written to stderr does not make a successful process fail when its exit code is zero.

## Cross-platform scripts and line endings

Agents should call `probe_identity` before nontrivial work and follow its
`execution_context` instead of guessing from the client machine. Structured
`exec_argv` never parses shell syntax, while script tools must match a shell
reported by the target. Prefer `run_script` for multiline shell work. The
legacy `run_bash_script` remains available for compatibility but is only valid
when `execution_context.shells.bash` is present.

UTF-8 `write_file`, `upload_file`, and fleet `upload_directory` use
`line_endings: "auto"` by default. Auto mode converts POSIX and shell scripts
to LF, Windows batch files to CRLF, and other confirmed UTF-8 text to the
target platform's native convention. Files containing NUL bytes, invalid UTF-8,
unknown binary-like extensions, or files larger than the normalization limit
are preserved. Base64 writes are always preserved.

Set `line_endings` explicitly when needed:

- `auto`: safe target-aware conversion, the default;
- `preserve`: byte-for-byte transfer;
- `lf`: force LF for confirmed text;
- `crlf`: force CRLF for confirmed text.

Downloads remain byte-preserving so retrieving a remote project never silently
rewrites its contents.

Use `--audit-log` to append redacted JSONL events. Audit records contain metadata and hashes, not stdout, stderr, stdin, script bodies, or file contents.

## Use the fleet server for multi-host operations

Create a local fleet configuration from the public example, then replace the documentation addresses and paths with your own values:

```powershell
Copy-Item -LiteralPath .\config\fleet.example.json -Destination .\config\fleet.json
```

The real `config/fleet.json` is intentionally ignored because it normally contains private hostnames, IP addresses, and local paths. Start the fleet server with:

```powershell
node .\src\index.js --fleet-config .\config\fleet.json
```

The fleet server adds:

- multiple named servers with explicit `ProxyJump`, host-key aliases, and identity gates;
- per-server tool groups and `readonly`, `restricted`, or `unrestricted` policy modes;
- argv program allowlists and parameterized command templates;
- persistent multi-connection pools backed by long-running OpenSSH/Python sessions;
- managed local port forwards, named forwards, and SOCKS5 proxies;
- zero-context SFTP file transfer;
- background tar.gz directory upload/download with stage progress and cancellation;
- separate redacted JSONL audit logs per server.
- allowlisted LAN discovery through named bastions and explicit CIDR/port boundaries;
- SSH host-key inspection plus fingerprint-confirmed ephemeral onboarding;
- named server groups;
- durable tmux sessions for training and other long-running programs.

The fleet exposes 44 tools. Use a fixed single-server registration when a task needs the smaller target-specific surface.

## Run long experiments in managed tmux sessions

`exec_argv` remains synchronous: it waits for the process, applies a timeout,
and kills the process group after a timeout. SSH keepalive and the persistent
connection pool keep transport sessions healthy, but they do not detach a
training process from SSH.

Use `start_remote_session` for long-running work. The tool safely quotes the
exact program argv, starts it inside a detached tmux session, captures combined
stdout/stderr in the pane, and appends the same output to a durable log under:

```text
~/.local/state/reliable-ssh-mcp/sessions/<session>/output.log
```

The job continues when the originating SSH or MCP connection closes. Use:

- `list_remote_sessions` after reconnecting or restarting MCP;
- `remote_session_status` for running/completed state, exit code, and log size;
- `read_remote_session` for recent pane output;
- `read_remote_log` with `next_offset_bytes` for incremental training-log polling;
- `send_remote_session_input` for literal interactive input;
- `stop_remote_session` for an explicit stop.

Linux targets must have `tmux`, `bash`, and `tee` installed. The MCP reports a
clear dependency error and does not fall back to an SSH-bound process when they
are missing.

## Discover and onboard LAN targets through a bastion

Discovery is disabled until a private fleet configuration declares a bastion.
The bastion references an already configured server, and every permitted CIDR,
TCP port, and scan-size limit is explicit:

```json
{
  "bastions": {
    "lab_lan": {
      "server": "jump_server",
      "allowedCidrs": ["192.168.10.0/24"],
      "allowedPorts": [22],
      "maxHosts": 256,
      "defaultUser": "research",
      "onboardDefaults": {
        "mode": "restricted",
        "allowPrograms": ["df", "hostname", "nvidia-smi", "python3"]
      }
    }
  },
  "serverGroups": {
    "gpu_nodes": []
  }
}
```

The controlled workflow is:

1. `list_bastions` shows the permitted boundaries.
2. `discover_lan_hosts` scans exactly one allowlisted CIDR and port, with at most 256 hosts.
3. `inspect_lan_host_key` collects the discovered SSH public keys and fingerprints.
4. Verify a fingerprint through an independent trusted channel.
5. `onboard_discovered_host` accepts that exact fingerprint, creates a strict temporary known-hosts file, and adds the target to the running fleet through `ProxyJump`.

Onboarded servers are intentionally ephemeral: they disappear when the MCP
process exits. Add a verified target to the private fleet JSON when it should
become permanent.

For project-scoped Codex registrations, set the MCP working directory to the
project and pass `--local-root project=.` together with `--fleet-config`.
Command-line roots override roots in every fleet server for that MCP process,
so one private fleet file can be reused without redirecting downloads to the
directory of another project.

The fleet JSON format also accepts named roots inside `defaults` or an
individual server object:

```json
{
  "defaults": {
    "localRoots": {
      "project": ".",
      "shared": "${RELIABLE_SSH_SHARED_ROOT}"
    }
  }
}
```

The checked-in example contains only `"project": "."`. Put real server
aliases, IP addresses, key paths, shared-directory paths, and audit locations
only in an ignored user configuration or environment variables.

Single-server instances can also reuse authenticated connections:

```powershell
node .\src\index.js --ssh-target server --pool-size 1 --keepalive-interval 30 --heartbeat-interval 60
```

OpenSSH receives protocol keepalive options. The persistent Python runner uses a separately configured idle `ping` heartbeat, without launching hostname or GPU subprocesses. Busy sessions skip application heartbeats. A 30-second protocol keepalive and 60-second application heartbeat are conservative starting values.

One verified connection is sufficient to serve a request; spare connections are filled in the background. Idle connections without a successful response for 60 seconds are pinged before use. Identity cache entries expire after five minutes and are invalidated when pool generation changes or no recently responsive connection remains. Every new connection verifies the configured identity before serving user operations.

Only built-in `probe_identity` and `ping` operations may retry once after a transport failure. User commands, file writes, and training launches are never automatically replayed; identity mismatch and explicit controller closure stop retries. No route is switched automatically. Connection status reports response freshness, classified errors, heartbeat counts, and `implementation: health-pool-v2`.

Source and transport-configuration changes require restarting/reconnecting the MCP server process. `reload_config` reloads execution policy only; closing SSH connections does not load new JavaScript or transport settings. Do not force-restart a shared MCP process with in-flight operations.

## Run the checks

Run the complete fixed verification pipeline before committing or publishing:

```powershell
npm run verify
```

For an individual check, run:

```powershell
npm test
npm run check
```

For parser-safe numbered source inspection:

```powershell
npm run inspect -- lines --file src/connection-pool.js --start 279 --end 340
```

Complex regular expressions belong in a project-relative JSON query file, not
in a PowerShell command. See the [code-inspection guide](docs/code-inspection.md).

Run an end-to-end check against one configured SSH alias:

```powershell
npm run smoke -- --ssh-target example-gpu --expected-hostname gpu-host.example --expected-ip 192.0.2.10 --expected-gpu "RTX 4090" --local-root project=.
```

The smoke test verifies the MCP handshake, tool list, host identity, special-character argv handling, stderr handling, Bash stdin execution, atomic file writing, file reading, stat metadata, and cleanup.

## Start the server

```powershell
node .\src\index.js `
  --ssh-target example-gpu `
  --expected-hostname gpu-host.example `
  --expected-ip 192.0.2.10 `
  --expected-gpu "RTX 4090" `
  --local-root project=. `
  --audit-log 'D:\path\to\logs\reliable-ssh-example.jsonl'
```

The target must be an OpenSSH alias that already handles authentication, host-key verification, and any `ProxyJump` route.

For OpenSSH aliases with an identity gate, the server runs `ssh -G` before the first identity probe. By default the effective `HostName` must match `expected-ip`. NAT hosts can set `expected-route-host` to the public SSH route while retaining the private interface address in `expected-ip` for remote identity verification.

For a password-authenticated Windows host, the fixed server can use the installed PuTTY Plink client without exposing the password in process arguments:

```powershell
node .\src\index.js `
  --ssh-target administrator@192.0.2.20 `
  --ssh-flavor plink `
  --ssh-command C:\path\to\plink.exe `
  --password-file C:\path\to\secrets\server.password `
  --host-key "ssh-ed25519 <pinned-public-key>" `
  --remote-python python `
  --pool-size 1 `
  --keepalive-interval 30 `
  --heartbeat-interval 60
```

Do not commit the password file. The Plink mode requires a pinned host key and runs with `-batch`, so an unexpected host key cannot be accepted silently.

## Client roots and publication safety

Version 0.6.0 supports the MCP client's Roots capability as a portable fallback.
`--client-roots fallback` is the default: explicitly configured startup or
environment roots win, and the client is queried only when none were configured.
Use `--client-roots merge` to add client-provided `file://` roots beside explicit
roots, or `--client-roots disabled` to ignore the capability. Non-file URIs are
ignored. Every effective root remains inspectable through `list_local_roots`, and
all transfer paths must still be relative to one named root.

The npm package is publishable and uses a `files` allowlist. The private
`config/fleet.json` is not included; only `config/fleet.example.json` is packed.
Always inspect `npm pack --dry-run` before publishing.

## Interactive password input through MCP

For a server already configured with `sshFlavor: "plink"` and a verified `hostKey`, call
`provide_connection_password` with the authorized login `password` (and `server` for fleet),
then call `probe_identity`. Supplying a password does not itself verify login and never
changes the remote account password. A wrong password fails; do not replay mutations.

The agent may automatically enter a password that the user has supplied for an authorized
connection. Do not ask the user to type it manually merely because normal commands use
batch mode. Never infer a password, disable host-key verification, or use a password to
bypass an operation policy. If bootstrapping through an authorized, trusted bastion using
a managed interactive session, first read the session and confirm the password prompt;
send the password only then, never to an ordinary shell prompt.

The Plink tool writes a process-scoped temporary password file with user-only permissions
(Windows ACL restricted before writing; Unix directory 0700/file 0600). Plink reads it
using `-pwfile` with `-batch` and the pinned `-hostkey`. Neither command argv nor this
service's audit log includes the password or its hash. MCP clients may retain tool inputs:
this is not a guarantee about third-party client history. The temporary file is plaintext
inside the protected directory, not an encrypted credential vault.

`clear_connection_password` removes that temporary file, closes idle command sessions,
and restores any startup `passwordFile` setting. Changes are rejected while operations
are active. Normal process exit removes session files; forced termination or power loss
can leave a protected temporary directory. Restarting requires supplying the password again.
This feature does not integrate a persistent keyring library and does not change OpenSSH
authentication, existing SSH aliases, or operating-system passwords. Plink targets must
use their own supported host/session configuration; OpenSSH ProxyJump aliases are not
automatically translated. Reload the MCP service after upgrading to expose the new tools.

## Run the full fleet verification

```powershell
npm run smoke:fleet -- .\config\fleet.json
```

The fleet smoke test uses the servers in your local fleet configuration and verifies persistent connections, explicit ProxyJump, identity gates, allowlisted argv, templates, TCP forwarding, SOCKS5, background archive transfer, progress, content integrity, cleanup, and connection shutdown.

## Per-server inventory and operating guidance

Each fleet server supports optional `serverInfo` (an inline object) or
`serverInfoFile` (a JSON file relative to the fleet configuration directory).
Use only one; inventory is never inherited from fleet defaults because it describes
an individual host. Multiple connection routes to one host can share one file.
Single-server instances accept `--server-info-file <path>`; relative paths resolve
against the launch working directory.

```json
{
  "description": "Research GPU server",
  "cpu": "Intel Core i9",
  "memoryGb": 64,
  "storageTb": 4,
  "gpus": [{"model": "RTX 4090", "count": 1, "memoryGbPerGpu": 48}],
  "os": "Ubuntu",
  "usageGuidance": "Use the data directory only after verifying its backing disk is mounted.",
  "notes": "Example inventory; replace with measured hardware and exact paths.",
  "source": "Operator-provided example"
}
```

All fields are optional. `verifiedAt` accepts an ISO 8601 timestamp with a timezone.
Capacity values must be positive numbers; GPU counts must be positive integers.
`memoryGb` and `memoryGbPerGpu` express customary nominal RAM/VRAM capacities;
`storageTb` is nominal physical storage in decimal TB, not free space. Put exact
measurements, disk layout and unit caveats in `notes`.

`list_servers` includes the complete `server_info` object for every host.
`get_server_info({server: "name"})` returns one fleet host's saved inventory;
a single-server instance uses `get_server_info({})`. Neither requires an SSH
connection. Missing inventory is `null`; credentials are never included.
Single-server MCP startup instructions contain its inventory; both modes include
operator-configured `usageGuidance` in startup instructions so agents see storage
preferences even before invoking a tool. This guidance does not change execution
policy, grant permissions or enforce filesystem restrictions.

Files are loaded at startup. Restart/reconnect the affected MCP instances after
editing code or inventory. Hardware metadata is a dated snapshot; use remote
read-only tools to confirm mounts, available memory and disk space before a job.

## Unified server registry

Use registry version 2 to share identity, inventory and policy across named connection routes. A scoped independent process loads the same registry with `--server <name> --route <route>`. See [shared registry guide](docs/shared-registry.md). Existing version 1 configurations remain supported.

## Windows persistent connections

The pooled runner starts with a short Python command and sends its source through
SSH standard input. The bootstrap reads the exact UTF-8 byte count before accepting
newline-delimited JSON requests. This avoids sending the entire daemon as a long
command line to the Windows SSH shell. Python starts with `-X utf8` so the runner's
JSON and Unicode file paths use UTF-8.

For registry version 2, put `remotePython` in the selected **route**, alongside
`sshTarget`. Use a verified Python executable path. A Windows host may have stale
inherited `USERPROFILE` or `COMPUTERNAME` variables; use `probe_identity` and actual
file-path checks when selecting directories. Keep Windows-only program allowlists
and omit Linux templates such as `df` or `systemctl`.

Reload the MCP process after code changes; closing pooled SSH connections alone
does not reload its JavaScript. Validate through the reloaded MCP with
`probe_identity`, `exec_argv`, and a Unicode-path `write_file`/`read_file` round trip.
Windows PowerShell 5 scripts should explicitly select UTF-8 output when returning
non-ASCII command output; Python's UTF-8 mode does not change other programs' code
pages. This bootstrap fix does not make Linux-only templates or tmux available on
Windows, and does not change Plink transfer/tunnel restrictions.
