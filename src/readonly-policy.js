import path from "node:path";

function normalizedProgram(program) {
  return path.posix
    .basename(String(program).replaceAll("\\", "/"))
    .toLowerCase();
}

function denied(program, detail, options = {}) {
  return {
    allowed: false,
    code: options.code ?? "READONLY_PROFILE_DENIED",
    reason: `Read-only profile for ${program} does not allow ${detail}`,
    nextStep: options.nextStep ??
      "Use arguments supported by this read-only profile or a dedicated read-only tool.",
  };
}

function allStrings(args) {
  return Array.isArray(args) && args.every((value) => typeof value === "string");
}

function exactArgs(program, args, allowed) {
  if (args.every((arg) => allowed.has(arg))) return { allowed: true };
  const rejected = args.find((arg) => !allowed.has(arg));
  return denied(program, `argument ${JSON.stringify(rejected)}`);
}

const validators = new Map([
  ["hostname", (args) => exactArgs("hostname", args, new Set([
    "-a", "--alias", "-d", "--domain", "-f", "--fqdn", "--long",
    "-i", "--ip-address", "-I", "--all-ip-addresses", "-s", "--short",
    "-y", "--yp", "--nis", "-V", "--version", "-h", "--help",
  ]))],
  ["uptime", (args) => exactArgs("uptime", args, new Set([
    "-p", "--pretty", "-s", "--since", "-h", "--help", "-V", "--version",
  ]))],
  ["uname", (args) => exactArgs("uname", args, new Set([
    "-a", "--all", "-s", "--kernel-name", "-n", "--nodename",
    "-r", "--kernel-release", "-v", "--kernel-version", "-m", "--machine",
    "-p", "--processor", "-i", "--hardware-platform", "-o", "--operating-system",
    "--help", "--version",
  ]))],
  ["whoami", (args) => exactArgs("whoami", args, new Set(["--help", "--version"]))],
  ["id", (args) => {
    const safe = /^(?:-[ugGnrzZ]+|--(?:user|group|groups|name|real|zero|context|help|version))$/u;
    return args.every((arg) => !arg.startsWith("-") || safe.test(arg))
      ? { allowed: true }
      : denied("id", `argument ${JSON.stringify(args.find((arg) => arg.startsWith("-") && !safe.test(arg)))}`);
  }],
  ["which", () => ({ allowed: true })],
  ["df", () => ({ allowed: true })],
  ["stat", () => ({ allowed: true })],
  ["ls", () => ({ allowed: true })],
  ["free", () => ({ allowed: true })],
  ["lsblk", () => ({ allowed: true })],
  ["findmnt", () => ({ allowed: true })],
  ["mountpoint", () => ({ allowed: true })],
  ["ps", () => ({ allowed: true })],
  ["git", validateGit],
  ["systemctl", validateSystemctl],
  ["nvidia-smi", validateNvidiaSmi],
]);

function validateGit(args) {
  const globalOptions = new Set([
    "--no-pager",
    "--no-optional-locks",
    "--literal-pathspecs",
  ]);
  let index = 0;
  while (globalOptions.has(args[index])) index += 1;
  const subcommand = args[index];
  const allowedSubcommands = new Set(["status", "rev-parse"]);
  if (!allowedSubcommands.has(subcommand)) {
    return denied("git", `subcommand ${JSON.stringify(subcommand ?? "<missing>")}`);
  }
  const selectedGlobalOptions = args.slice(0, index);
  if (!selectedGlobalOptions.includes("--no-pager")) {
    return denied("git", "execution without the global --no-pager guard");
  }
  if (
    subcommand === "status" &&
    !selectedGlobalOptions.includes("--no-optional-locks")
  ) {
    return denied(
      "git",
      "status without the global --no-optional-locks guard",
    );
  }
  return { allowed: true };
}

function validateSystemctl(args) {
  const globalOptions = new Set([
    "--user", "--system", "--no-pager", "--no-legend", "--plain", "--all", "--quiet",
  ]);
  let index = 0;
  while (globalOptions.has(args[index])) index += 1;
  const subcommand = args[index];
  const allowedSubcommands = new Set([
    "status", "show", "is-active", "is-enabled", "is-failed",
    "list-units", "list-unit-files", "list-dependencies", "list-sockets", "list-timers",
  ]);
  if (!allowedSubcommands.has(subcommand)) {
    return denied("systemctl", `subcommand ${JSON.stringify(subcommand ?? "<missing>")}`);
  }
  const safeOption = /^(?:--(?:type|state|property)=.+)$/u;
  const rejected = args.slice(index + 1).find((arg) => arg.startsWith("-") && !globalOptions.has(arg) && !safeOption.test(arg));
  return rejected ? denied("systemctl", `argument ${JSON.stringify(rejected)}`) : { allowed: true };
}

function validateNvidiaSmi(args) {
  let expectValue;
  for (const arg of args) {
    if (expectValue) {
      if (expectValue === "format" && !/^(?:csv|xml)(?:,(?:noheader|nounits))*$/u.test(arg)) {
        return denied("nvidia-smi", `format value ${JSON.stringify(arg)}`);
      }
      expectValue = undefined;
      continue;
    }
    if (["-i", "--id", "-d", "--display", "--format"].includes(arg)) {
      expectValue = arg === "--format" ? "format" : "value";
      continue;
    }
    if (["-L", "--list-gpus", "-q", "--query", "-x", "--xml-format", "-B", "--list-excluded-gpus"].includes(arg)) continue;
    if (/^--(?:id|display|query-gpu|query-compute-apps|query-supported-clocks|query-accounted-apps|query-retired-pages|query-remapped-rows)=.+$/u.test(arg)) continue;
    if (/^--format=(?:csv|xml)(?:,(?:noheader|nounits))*$/u.test(arg)) continue;
    return denied("nvidia-smi", `argument ${JSON.stringify(arg)}`);
  }
  return expectValue
    ? denied("nvidia-smi", `missing value after ${JSON.stringify(args.at(-1))}`)
    : { allowed: true };
}

export function evaluateReadOnlyCommand(args = {}) {
  const program = normalizedProgram(args.program);
  const validator = validators.get(program);
  if (!validator) {
    return denied(
      program || "<missing>",
      "this program because no built-in profile exists",
      {
        code: "READONLY_PROFILE_UNAVAILABLE",
        nextStep: "Add a code-reviewed and tested read-only profile or use a dedicated read-only tool. Restricted-mode templates do not bypass readonly policy.",
      },
    );
  }
  if (args.env && Object.keys(args.env).length > 0) {
    return denied(program, "environment overrides");
  }
  if (args.stdin) return denied(program, "stdin input");
  const argv = args.args ?? [];
  if (!allStrings(argv)) return denied(program, "non-string argv values");
  return validator(argv);
}

export function hasReadOnlyProfile(program) {
  return validators.has(normalizedProgram(program));
}
