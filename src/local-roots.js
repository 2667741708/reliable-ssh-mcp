import path from "node:path";

import { validateLocalRootName } from "./local-path.js";

function expandRootValue(value, environment) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Each local root must be a non-empty path string");
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value);
  if (!match) return value;
  const expanded = environment[match[1]];
  if (!expanded)
    throw new Error(`Environment variable ${match[1]} is not set`);
  return expanded;
}

export function normalizeLocalRoots(
  rawRoots,
  baseDirectory = process.cwd(),
  environment = process.env,
) {
  if (rawRoots === undefined) return {};
  if (!rawRoots || typeof rawRoots !== "object" || Array.isArray(rawRoots))
    throw new Error("localRoots must be an object of name-to-path entries");
  const roots = {};
  for (const [name, rawPath] of Object.entries(rawRoots)) {
    validateLocalRootName(name);
    roots[name] = path.resolve(
      baseDirectory,
      expandRootValue(rawPath, environment),
    );
  }
  return roots;
}

export function parseLocalRootSpecs(
  specs,
  baseDirectory = process.cwd(),
  environment = process.env,
) {
  const rawRoots = {};
  for (const spec of specs) {
    const equalsAt = spec.indexOf("=");
    const name = equalsAt > 0 ? spec.slice(0, equalsAt) : "project";
    const rawPath = equalsAt > 0 ? spec.slice(equalsAt + 1) : spec;
    validateLocalRootName(name);
    if (Object.hasOwn(rawRoots, name))
      throw new Error(`Duplicate local root name ${name}`);
    rawRoots[name] = rawPath;
  }
  return normalizeLocalRoots(rawRoots, baseDirectory, environment);
}

export function localRootsFromEnvironment(
  environment = process.env,
  baseDirectory = process.cwd(),
) {
  const raw = environment.RELIABLE_SSH_LOCAL_ROOTS;
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `RELIABLE_SSH_LOCAL_ROOTS must be a JSON object: ${error.message}`,
    );
  }
  return normalizeLocalRoots(parsed, baseDirectory, environment);
}

export function mergedRawLocalRoots(defaults = {}, server = {}) {
  const inherited = {
    ...(defaults.localRoot ? { project: defaults.localRoot } : {}),
    ...(defaults.localRoots ?? {}),
  };
  return {
    ...inherited,
    ...(server.localRoot ? { project: server.localRoot } : {}),
    ...(server.localRoots ?? {}),
  };
}
