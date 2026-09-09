import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

const ROOT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/u;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertRelativePath(requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0)
    throw new Error("Local path must be a non-empty relative path");
  if (
    path.isAbsolute(requestedPath) ||
    path.win32.isAbsolute(requestedPath) ||
    path.posix.isAbsolute(requestedPath)
  ) {
    throw new Error(
      "Absolute local paths are not allowed; choose a local_root and use a relative path",
    );
  }
  if (/[\0\r\n]/u.test(requestedPath))
    throw new Error("Local path contains an invalid character");
}

async function missing(candidate) {
  try {
    await lstat(candidate);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function resolveRoot(localRoot) {
  const root = await realpath(localRoot);
  const info = await stat(root);
  if (!info.isDirectory())
    throw new Error("Configured local root must be a directory");
  return root;
}

async function resolveCandidate(localRoot, requestedPath) {
  assertRelativePath(requestedPath);
  const root = await resolveRoot(localRoot);
  const candidate = path.resolve(root, requestedPath);
  if (!isWithin(root, candidate))
    throw new Error("Local path is outside the selected local root");
  return { root, candidate };
}

async function ensureSafeParent(root, candidate, createParents) {
  const relativeParent = path.relative(root, path.dirname(candidate));
  const segments = relativeParent === "" ? [] : relativeParent.split(path.sep);
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      const resolved = await realpath(next);
      if (!isWithin(root, resolved))
        throw new Error(
          "Local destination parent escapes through a symbolic link",
        );
      const info = await stat(resolved);
      if (!info.isDirectory())
        throw new Error("Local destination parent is not a directory");
      current = resolved;
    } catch (error) {
      if (error.code !== "ENOENT" || !createParents) throw error;
      await mkdir(next);
      current = await realpath(next);
      if (!isWithin(root, current))
        throw new Error(
          "Local destination parent escapes through a symbolic link",
        );
    }
  }
  return path.join(current, path.basename(candidate));
}

export function validateLocalRootName(name) {
  if (!ROOT_NAME_PATTERN.test(name))
    throw new Error(
      `Invalid local root name ${name}; use letters, digits, underscores, or hyphens`,
    );
  return name;
}

export function selectLocalRoot(localRoots, requestedName = "project") {
  const name = validateLocalRootName(requestedName);
  const root = localRoots?.[name];
  if (!root) {
    const available = Object.keys(localRoots ?? {});
    throw new Error(
      available.length === 0
        ? "No local roots are configured"
        : `Unknown local root ${name}; available roots: ${available.join(", ")}`,
    );
  }
  return { name, path: root };
}

export async function inspectLocalRoots(localRoots = {}) {
  return Promise.all(
    Object.entries(localRoots).map(async ([name, configuredPath]) => {
      try {
        const resolvedPath = await resolveRoot(configuredPath);
        return { name, path: resolvedPath, available: true };
      } catch (error) {
        return {
          name,
          path: configuredPath,
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

export async function resolveUploadPath(localRoot, requestedPath) {
  const { root, candidate: lexicalCandidate } = await resolveCandidate(
    localRoot,
    requestedPath,
  );
  const candidate = await realpath(lexicalCandidate);
  if (!isWithin(root, candidate))
    throw new Error("Local path escapes through a symbolic link");
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error("Upload source must be a regular file");
  return { path: candidate, size: info.size };
}

export async function prepareDownloadPath(
  localRoot,
  requestedPath,
  createParents,
) {
  const { root, candidate } = await resolveCandidate(localRoot, requestedPath);
  const destination = await ensureSafeParent(
    root,
    candidate,
    createParents,
  );
  if (!(await missing(destination)))
    throw new Error("Local destination already exists; downloads do not overwrite");
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.reliable-ssh-${randomUUID()}.part`,
  );
  const handle = await open(temporary, "wx");
  await handle.close();
  return { destination, temporary };
}

export async function commitDownloadedFile(temporary, destination) {
  const info = await stat(temporary);
  if (!info.isFile()) throw new Error("Downloaded temporary path is not a file");
  try {
    await link(temporary, destination);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Local destination was created during transfer; existing file was preserved",
      );
    throw error;
  }
  await rm(temporary, { force: true });
  return { path: destination, size: info.size };
}

export async function discardTemporaryPath(temporary) {
  await rm(temporary, { recursive: true, force: true });
}

export async function resolveUploadDirectory(localRoot, requestedPath) {
  const { root, candidate: lexicalCandidate } = await resolveCandidate(
    localRoot,
    requestedPath,
  );
  const candidate = await realpath(lexicalCandidate);
  if (!isWithin(root, candidate))
    throw new Error("Local directory escapes through a symbolic link");
  const info = await stat(candidate);
  if (!info.isDirectory()) throw new Error("Upload source must be a directory");
  return candidate;
}

export async function prepareDownloadDirectory(
  localRoot,
  requestedPath,
  createParents,
) {
  const { root, candidate } = await resolveCandidate(localRoot, requestedPath);
  const destination = await ensureSafeParent(
    root,
    candidate,
    createParents,
  );
  if (!(await missing(destination)))
    throw new Error("Local destination already exists; downloads do not overwrite");
  const staging = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.reliable-ssh-${randomUUID()}.part`,
  );
  await mkdir(staging);
  return { destination, staging };
}

export async function commitDownloadedDirectory(staging, destination) {
  if (!(await missing(destination)))
    throw new Error(
      "Local destination was created during transfer; existing directory was preserved",
    );
  await rename(staging, destination);
  return destination;
}
