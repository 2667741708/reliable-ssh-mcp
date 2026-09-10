# Connection health repair: 2026-09-10

## Scope

Incremental connector-only repair. No remote training commands, file writes,
server restarts, route changes, or permission-policy changes were performed.

The old pool required all configured sessions before serving a request, treated
local process liveness as connection health, and had no enabled heartbeat on
the affected deployment. A successful interactive SSH login did not establish
that an old pooled runner was responsive.

## Changes

- Serve through one verified session; fill spare capacity in the background.
- Lightweight idle ping; skip busy sessions; track last successful response.
- Probe stale idle sessions before use; identity cache TTL is five minutes.
- Verify each newly established session; invalidate cache on pool generation changes.
- Retry only built-in identity/ping probes once on transport failure.
- Never replay user commands or training launches, and never switch routes.
- Refuse closing a pool with in-flight operations through the fleet tool.
- Report transport/protocol/local-route errors separately.
- Remove the generated Python invalid-escape warning around shell PIPESTATUS.

The ignored local deployment configuration changes only the affected WG route:
connect timeout 25 seconds, OpenSSH keepalive 30 seconds, idle runner heartbeat
45 seconds. Protocol keepalive failure limit is three. Full identity probes
are not used as periodic heartbeats; identity is refreshed on demand after TTL.

## Validation and deployment

The final suite passed all 89 tests, including the cancellation-race regression
test and four parser-safe inspection tests. `npm run check` and the local
PowerShell launcher syntax check also passed.

## Parser-safe inspection follow-up

An inline PowerShell search later demonstrated the same parser-chain failure
class that this project is intended to avoid: alternation and quotes in a
regular expression were interpreted before `rg` received the pattern. Version
0.9.0 therefore adds `npm run inspect`, reads complex patterns from a JSON file,
and adds project-level Codex instructions requiring that path. `npm run verify`
now provides the fixed pre-release check sequence. See `docs/code-inspection.md`.

The read-only independent MCP canary at
`health-canary-20260910-short-retry1/status.json` passed 100 seconds of observation:
two sessions each sent two heartbeats, zero reconnects, and final identity refresh
took 124 ms. The earlier failed harness attempt is preserved separately; the
client needed the real user environment passed to its MCP child on Windows.

The canary uses the MCP SDK and configured fleet, not a raw SSH command path.
Local deployment helpers under `scripts/` and canary reports are intentionally
ignored because they contain host-specific information.

The existing Codex MCP process still reported the old implementation after
these edits. Source changes and transport settings are NOT activated by policy
reload or by closing SSH sessions. Reconnect/restart the MCP process at an idle
boundary, then require `connection_status.implementation == health-pool-v2`
and a fresh successful identity probe before declaring deployment complete.

A 1300-second hidden idle canary may be launched with
`powershell -NoProfile -File scripts/start-health-canary.ps1`. It maintains only
its own test connections and exits automatically; it does not replace the app
MCP. Check its explicit status path before claiming long-idle success.

## Rollback

Preserve all logs. At an idle boundary, revert only this connector patch and
restore the three deployment settings to their prior values (connect timeout
8 seconds, keepalive and heartbeat disabled), then reconnect MCP. Do not reset
the repository wholesale, kill unrelated processes, or alter remote training.
