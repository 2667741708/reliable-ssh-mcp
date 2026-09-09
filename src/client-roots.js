import { fileURLToPath } from "node:url";

function safeName(value, fallback) {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/^[^A-Za-z]+/u, "")
    .slice(0, 48);
  return normalized || fallback;
}

export function mergeClientRoots(configuredRoots = {}, roots = []) {
  const merged = { ...configuredRoots };
  const seenPaths = new Set(Object.values(merged));
  let index = 0;

  for (const root of roots) {
    let localPath;
    try {
      const uri = new URL(root.uri);
      if (uri.protocol !== "file:") continue;
      localPath = fileURLToPath(uri);
    } catch {
      continue;
    }
    if (seenPaths.has(localPath)) continue;

    index += 1;
    let name;
    if (!Object.hasOwn(merged, "project")) {
      name = "project";
    } else {
      const base = `client_${safeName(root.name, String(index))}`;
      name = base;
      let suffix = 2;
      while (Object.hasOwn(merged, name)) {
        name = `${base}_${suffix}`;
        suffix += 1;
      }
    }
    merged[name] = localPath;
    seenPaths.add(localPath);
  }
  return merged;
}

export async function effectiveLocalRoots(
  mcpServer,
  configuredRoots = {},
  mode = "fallback",
) {
  if (mode === "disabled") return { ...configuredRoots };
  if (mode === "fallback" && Object.keys(configuredRoots).length > 0)
    return { ...configuredRoots };

  const capabilities = mcpServer.server.getClientCapabilities();
  if (!capabilities?.roots) return { ...configuredRoots };

  const response = await mcpServer.server.listRoots();
  return mergeClientRoots(configuredRoots, response.roots);
}
