function quotePowerShellCommandPath(value) {
  const command = String(value ?? "");
  if (!command || !/[\s&()]/.test(command)) return command;
  return `& '${command.replace(/'/g, "''")}'`;
}

export function remoteExecutable(config) {
  if (config.sshFlavor !== "plink") return config.remotePython;
  return quotePowerShellCommandPath(config.remotePython);
}
