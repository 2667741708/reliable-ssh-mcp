#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  process.stderr.write("Run this verifier through npm run verify.\n");
  process.exit(2);
}
const steps = [
  ["git", ["diff", "--check"]],
  ["git", ["diff", "--cached", "--check"]],
  [process.execPath, [npmCli, "run", "check"]],
  [process.execPath, [npmCli, "test"]],
  [process.execPath, [npmCli, "pack", "--dry-run", "--json"]],
];

for (const [program, args] of steps) {
  process.stdout.write(`\n> ${program} ${args.join(" ")}\n`);
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
