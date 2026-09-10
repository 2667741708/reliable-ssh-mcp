#!/usr/bin/env node
import process from "node:process";

import { inspectLines, inspectSearch, readInspectionQuery } from "../src/code-inspect.js";

function option(arguments_, name, fallback) {
  const index = arguments_.indexOf(name);
  return index < 0 ? fallback : arguments_[index + 1];
}

function usage() {
  return [
    "Usage:",
    "  reliable-ssh-inspect lines --file <relative-path> [--start N] [--end N] [--json]",
    "  reliable-ssh-inspect search --query <relative-json-path> [--json]",
    "",
    "Put complex regular expressions in the JSON query file so no shell parses them.",
  ].join("\n");
}

const arguments_ = process.argv.slice(2);
const command = arguments_[0];
const asJson = arguments_.includes("--json");
try {
  if (command === "lines") {
    const result = await inspectLines(process.cwd(), {
      file: option(arguments_, "--file"),
      start: option(arguments_, "--start", 1),
      end: option(arguments_, "--end", 40),
    });
    process.stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : `${result.text}\n`);
  } else if (command === "search") {
    const queryPath = option(arguments_, "--query");
    if (!queryPath) throw new Error("search requires --query <relative-json-path>.");
    const result = await inspectSearch(process.cwd(), await readInspectionQuery(process.cwd(), queryPath));
    if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const match of result.matches)
        process.stdout.write(`${match.path}:${match.line}:${match.text}\n`);
      process.stdout.write(`Scanned ${result.files_scanned} files; ${result.match_count} matches${result.truncated ? " (truncated)" : ""}.\n`);
    }
  } else {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = command && !new Set(["-h", "--help"]).has(command) ? 2 : 0;
  }
} catch (error) {
  process.stderr.write(`Inspection failed: ${error.message}\n`);
  process.exitCode = 1;
}
