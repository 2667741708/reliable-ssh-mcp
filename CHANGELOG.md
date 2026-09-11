# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

## 0.9.1 - 2026-09-11

### Changed

- Read-only Fleet execution now requires a built-in positive argv profile in
  addition to `readOnlyPrograms`; unknown programs and argument shapes fail closed.
- `git` read-only execution is limited to `status` and `rev-parse`; complex
  programs such as `find`, `sed`, `journalctl`, and `ip` are unsupported in
  readonly mode until a dedicated reviewed and tested profile or tool is added.
  Restricted-mode templates do not bypass readonly policy.
- All single-server and Fleet tools now expose a common output schema and return
  structured content alongside backward-compatible JSON text.
- Server inventory and usage guidance are loaded through `get_server_info` instead
  of being embedded in startup instructions.
- Runtime MCP versions are read from `package.json`.
- Added `smoke:readonly` for real-host validation without remote file mutation.

### Fixed

- `--help` and `-h` now print usage and exit successfully.
- Audit events now distinguish disabled groups and unsupported transports from
  operations that passed policy and reached a handler.

### Safety

- Read-only execution rejects environment overrides and stdin and returns stable
  denial metadata with an explanatory `next_step`, without suggesting an
  unavailable tool path.
- Documentation now states explicitly that policy allowlists are not an OS sandbox.

## 0.9.0 - 2026-09-10

### Added

- Health-aware SSH connection pool (`health-pool-v2`) with response freshness,
  lightweight idle pings, background spare creation and classified errors.
- Five-minute identity-cache TTL tied to connection generation and recent
  successful responses.
- One bounded retry for built-in `probe_identity` and `ping` operations only.
- Parser-safe local code-inspection CLI and repository-level Codex workflow.
- Fixed `npm run verify` release pipeline using argument-array subprocesses.

### Changed

- A single verified connection can serve requests while spare capacity is
  filled in the background.
- Every new pooled connection verifies remote identity before user operations.
- Busy connections skip heartbeats; stale idle connections are pinged before use.
- Fleet connection closure is rejected while requests are in flight.

### Safety

- User commands, file operations and training launches are never automatically
  replayed after an uncertain SSH failure.
- Closing the controller cancels delayed retries and in-progress pool refills.
- Complex regular expressions are read from JSON files instead of being passed
  through PowerShell quoting layers.

### Documentation

- Added a complete Simplified Chinese README and Chinese changelog.
- Added an explicit first-time reading order and clarified the different roles
  of README usage documentation and version history.
