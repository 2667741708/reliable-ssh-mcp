# Shared registry and scoped MCP processes

Registry version 2 groups connection routes under a canonical server. Version 1 remains readable.

```json
{
  "version": 2,
  "defaults": {"mode": "readonly", "toolGroups": ["core", "files", "connections"]},
  "servers": {
    "example": {
      "expectedHostname": "example-host",
      "serverInfo": {"description": "Example server"},
      "defaultRoute": "ssh",
      "routes": {
        "ssh": {"sshTarget": "example-ssh"},
        "password": {
          "sshTarget": "user@192.0.2.10",
          "sshFlavor": "plink",
          "sshCommand": "plink.exe",
          "hostKey": "REPLACE_WITH_VERIFIED_KEY",
          "aliases": ["example_plink"]
        }
      }
    }
  }
}
```

Server identity expectations (hostname/GPU), inventory and policy are shared.
Only transport settings and route-specific address checks can appear inside routes.
Route policy/inventory overrides are rejected. Legacy aliases cannot shadow canonical server names.

Fleet launch: `node src/index.js --fleet-config registry.json`.
Scoped launch: add `--server example --route ssh`.
Both use the same config loader, tool implementations and policy checks.
A scoped process omits server/route selectors and fleet discovery tools; disallowed tool groups are omitted.
Only local-root/client-root settings may be overridden on the launcher; connection and policy settings belong in the registry.

Fleet tools accept an optional `route` argument. Omit it to use the explicitly configured default.
A legacy alias selects its original route; a conflicting route parameter is rejected.
No automatic route fallback or command replay occurs.
Runtime state is keyed by a stable `server@route` connection ID; aliases share that state.
Different MCP processes remain isolated even when they select the same route.

`list_servers` returns one row per server with routes, aliases, capabilities and saved inventory.
`get_server_info` reports the canonical server, chosen route and saved metadata without SSH.
Raw credentials and credential-file references are not included.
Uploads/downloads and tunnel creation are currently unavailable through the Plink adapter;
select a configured OpenSSH route for those operations.

Registry and inventory changes take effect after reconnect/restart.
To minimize duplicate tools, enable the Fleet registration by default and keep scoped entries disabled until needed.
