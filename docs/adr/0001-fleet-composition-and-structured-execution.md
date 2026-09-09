# 1. Compose fleet features around structured SSH execution

- **Status**: accepted
- **Date**: 2026-07-16
- **Deciders**: workspace owner, Codex

## Context

The original service handled one Ubuntu server per MCP process. It avoided multi-shell quoting errors by sending JSON/Base64 payloads to a remote Python runner and using `subprocess(..., shell=False)` for ordinary commands.

The fleet upgrade needs multi-server routing, explicit ProxyJump, command policies, templates, persistent connections, tunnels, zero-context transfers, directory archives, and background progress. Several third-party SSH MCP servers already provide parts of this feature set, but their core command tools accept raw shell strings. Replacing the existing execution path would reintroduce quoting and path-injection risks.

Windows OpenSSH in this environment does not provide a working ControlMaster socket, so native multiplexing cannot supply the connection pool.

## Decision

Keep the structured single-host runner as the execution boundary and compose fleet capabilities around it.

- A versioned JSON fleet configuration owns server profiles, ProxyJump routes, identity expectations, policies, tool groups, templates, and named forwards.
- Each fleet server gets a pool of persistent OpenSSH processes running a line-oriented Python runner. Fixed single-server instances may opt into the same pool with `--pool-size`; pinned-key Plink/Windows targets use the configured `--remote-python` and the same JSON runner.
- `--keepalive-interval` configures OpenSSH protocol keepalives; `--heartbeat-interval` independently controls the application-level idle identity probe. Pool recovery happens between requests; in-flight commands are never automatically replayed.
- File transfers use OpenSSH SCP's default SFTP protocol and restrict relative local paths to explicitly named roots. Downloads are staged and atomically published without overwriting existing destinations.
- Long-running programs use explicitly managed tmux sessions with durable logs; synchronous command tools retain timeout and exit-code semantics.
- LAN discovery runs only from named bastions against configured IPv4 CIDRs and ports. Dynamic onboarding is ephemeral and requires an exact, independently confirmed SSH host-key fingerprint.
- Directory transfers create temporary tar.gz archives, transfer them without model context, validate extraction paths, reject links on the remote side, and report background task progress.
- Port forwards and SOCKS proxies use separate managed OpenSSH processes with list, close, and restart operations.
- Policy and audit checks execute before every selected-server operation.
- Existing single-server MCP registrations remain supported.

## Consequences

- Positive: Existing command reliability and identity gates remain intact.
- Positive: ProxyJump, known_hosts, and local SSH key behavior stay delegated to OpenSSH.
- Positive: Multi-server features are testable independently from the remote execution runner.
- Positive: Files and archives can move without entering model context.
- Negative: The fleet server exposes more tools and therefore consumes more tool context than the single-server instances.
- Negative: Persistent sessions and tunnels consume local and remote processes until closed or the MCP process exits.
- Negative: Directory progress is stage-based, not byte-perfect during compression and extraction.
- Neutral: Raw Bash remains available only as an explicit policy-controlled fallback.

## Alternatives considered

- Adopt `mcp-ssh-manager`: rejected as the execution core because commands and working directories are composed into shell strings.
- Adopt `@uarlouski/ssh-mcp-server`: rejected as the execution core because its command policy still wraps a raw command string.
- Adopt `@nl4ever/sshmcp`: rejected as the execution core because directory workflows use shell-string commands and the source package has no automated test script.
- Use OpenSSH ControlMaster: rejected after a real Windows probe returned `getsockname failed: Not a socket`.
- Use one new SSH connection per fleet call: retained only for SFTP transfers; rejected for ordinary commands because it provides no connection pooling.

## References

- `PT/reliable-ssh-mcp功能与使用说明.md`
- `config/fleet.json`
- MCP TypeScript SDK `1.29.0`
