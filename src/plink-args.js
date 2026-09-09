export function plinkArgs(config, command) {
  const args = ["-batch", "-ssh", "-T", "-no-antispoof", "-hostkey", config.hostKey];
  if (config.proxyJump && !config.proxyCommand)
    throw new Error("Plink does not read OpenSSH ProxyJump; configure an explicit proxyCommand.");
  if (config.proxyCommand) args.push("-proxycmd", config.proxyCommand);
  if (config.passwordFile) args.push("-pwfile", config.passwordFile);
  args.push(config.sshTarget, ...command);
  return args;
}
