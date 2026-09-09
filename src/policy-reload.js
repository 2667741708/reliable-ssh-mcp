const POLICY_FIELDS = new Set([
  "mode", "allowPrograms", "denyPrograms", "allowProgramPaths",
  "readOnlyPrograms", "allowTemplates", "allowScripts", "allowScriptHashes",
  "preferredPython",
]);

function snapshot(fleet) {
  return JSON.stringify(fleet, (key, value) =>
    POLICY_FIELDS.has(key) ? undefined : value);
}

export function createPolicyReloader(fleet) {
  const baseline = snapshot(fleet);
  return async function reloadPolicy() {
  if (!fleet.reload) throw new Error("This configuration cannot be reloaded");
  const next = await fleet.reload();
  if (baseline !== snapshot(next)) {
    throw new Error("Non-policy configuration changed; restart MCP to load connection, tool-group or inventory changes. No changes applied.");
  }
  const currentEntries = fleet.connections && Object.keys(fleet.connections).length
    ? fleet.connections : fleet.servers;
  const nextEntries = next.connections && Object.keys(next.connections).length
    ? next.connections : next.servers;
  // Commit synchronously after complete validation; keep live connections and jobs.
  for (const [name, selected] of Object.entries(currentEntries)) {
    for (const field of POLICY_FIELDS) {
      if (Object.hasOwn(nextEntries[name], field)) selected[field] = nextEntries[name][field];
      else delete selected[field];
    }
  }
  return { reloaded: true, scope: "execution_policy", connections_preserved: true };
  };
}
