# Exploration and training

Call `get_execution_policy` before exploring. It reports the effective policy,
allowed program names, exact paths and `preferred_python`. Fleet calls take
`server` and optionally `route`; pinned MCP entries omit both.

The installed fleet includes file/search tools and `id`, `whoami`, `free`, `ps`,
`pwd`, `readlink`, `realpath`, `which` for environment discovery. Inspect GPU
capacity with `nvidia-smi` and use managed file tools for files and logs.
Program availability on a remote host still needs verification.

Use the interpreter explicitly requested by the user first, otherwise the
server's configured `preferredPython` absolute path. Pass that path as
`program` to `exec_argv` and `start_remote_session`. Check
`--version`, then `-c "import sys; print(sys.executable)"` and required imports.
Set `cwd` explicitly. Use the same interpreter with `-m pip` and
`-m torch.distributed.run` so installation and distributed training use the
chosen environment. Package installation must be part of the user's task.
Use `start_remote_session` for training, `remote_session_status` for completion
and `read_remote_log` for progress; do not replay a launch after a timeout.

## Reloading

After editing fleet.json, call `reload_config`, then `get_execution_policy`.
Reload validates the complete file before applying any change. It supports
mode, command allow/deny lists, exact program paths, read-only program lists,
template permissions, script permissions/hashes and preferredPython.
It preserves live connections and jobs. Invalid configuration leaves the old
policy in place. Transport, inventory, tool-group and other structural changes
require a restart. CLI local-root overrides remain effective. Each MCP process
must reload separately. An initial restart is needed to load this new code.

Reload does not write fleet.json. AI can explore and execute within configured
permissions without adding each command itself to the configuration.
`allowPrograms` matches program basenames; `allowProgramPaths` matches exact
strings. The former may already allow a path by basename. PreferredPython is
guidance, not a new permission grant. General Python and shell execution can
launch subprocesses: this policy is not a security sandbox, and read-only
program names do not guarantee read-only arguments. Use OS-level isolation
when strong confinement is required.
