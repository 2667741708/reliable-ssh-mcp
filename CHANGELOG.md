# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

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
