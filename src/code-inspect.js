import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".codex_tmp_deps",
  "artifacts",
  "node_modules",
  "staging",
]);

function projectPath(projectRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.length)
    throw new Error("Inspection paths must be non-empty strings.");
  if (path.isAbsolute(relativePath))
    throw new Error(`Inspection paths must be project-relative: ${relativePath}`);
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  const relation = path.relative(root, resolved);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation))
    throw new Error(`Inspection path escapes the project root: ${relativePath}`);
  return resolved;
}

function textLines(text) {
  const lines = text.replace(/^\uFEFF/u, "").replace(/\r\n|\r/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export async function inspectLines(projectRoot, request) {
  const start = Number(request.start ?? 1);
  const end = Number(request.end ?? start + 39);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
    throw new Error("Line range requires integers with 1 <= start <= end.");
  const relativePath = request.file;
  const contents = await readFile(projectPath(projectRoot, relativePath), "utf8");
  const lines = textLines(contents);
  const last = Math.min(end, lines.length);
  const width = String(last || start).length;
  const selected = [];
  for (let line = start; line <= last; line += 1)
    selected.push(`${String(line).padStart(width)}: ${lines[line - 1]}`);
  return { file: relativePath, start, end: last, total_lines: lines.length, text: selected.join("\n") };
}

async function collectFiles(projectRoot, relativePath, extensions, output) {
  const absolutePath = projectPath(projectRoot, relativePath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    if (!extensions || extensions.has(path.extname(relativePath).toLowerCase()))
      output.push(relativePath.replaceAll(path.sep, "/"));
    return;
  }
  if (!metadata.isDirectory()) return;
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith("health-canary")))
      continue;
    await collectFiles(projectRoot, path.join(relativePath, entry.name), extensions, output);
  }
}

function compiledPatterns(query) {
  if (!Array.isArray(query.patterns) || query.patterns.length === 0 ||
      query.patterns.some((value) => typeof value !== "string" || !value.length))
    throw new Error("Search query requires one or more non-empty patterns.");
  const mode = query.mode ?? "regex";
  if (!new Set(["literal", "regex"]).has(mode))
    throw new Error("Search mode must be literal or regex.");
  const flags = query.case_sensitive === false ? "iu" : "u";
  return query.patterns.map((source) => ({
    source,
    expression: new RegExp(mode === "literal" ? source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") : source, flags),
  }));
}

export async function inspectSearch(projectRoot, query) {
  if (!Array.isArray(query.paths) || query.paths.length === 0)
    throw new Error("Search query requires one or more project-relative paths.");
  const maximum = Number(query.max_results ?? 200);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5000)
    throw new Error("max_results must be an integer from 1 to 5000.");
  const extensions = query.extensions === undefined ? undefined : new Set(
    query.extensions.map((value) => value.startsWith(".") ? value.toLowerCase() : `.${value.toLowerCase()}`),
  );
  const patterns = compiledPatterns(query);
  const files = [];
  for (const relativePath of query.paths)
    await collectFiles(projectRoot, relativePath, extensions, files);
  const uniqueFiles = [...new Set(files)].sort();
  const matches = [];
  let truncated = false;
  for (const file of uniqueFiles) {
    const contents = await readFile(projectPath(projectRoot, file), "utf8");
    if (contents.includes("\0")) continue;
    const lines = textLines(contents);
    for (let index = 0; index < lines.length; index += 1) {
      for (const pattern of patterns) {
        if (!pattern.expression.test(lines[index])) continue;
        matches.push({ path: file, line: index + 1, pattern: pattern.source, text: lines[index] });
        if (matches.length === maximum) {
          truncated = true;
          return { files_scanned: uniqueFiles.length, match_count: matches.length, truncated, matches };
        }
        break;
      }
    }
  }
  return { files_scanned: uniqueFiles.length, match_count: matches.length, truncated, matches };
}

export async function readInspectionQuery(projectRoot, relativePath) {
  const contents = await readFile(projectPath(projectRoot, relativePath), "utf8");
  try {
    return JSON.parse(contents.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`Invalid inspection query JSON: ${error.message}`);
  }
}
