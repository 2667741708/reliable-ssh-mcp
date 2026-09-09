import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function removePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("reliable-ssh-password-"))
    throw new Error("Refusing to remove a directory outside the session password area");
  rmSync(resolved, { recursive: true, force: true });
}

// Plink reads a private file, never a password argument or the runner's stdin.
// This is session-scoped authentication, not a persistent credential vault.
export class SessionPassword {
  constructor(config) {
    this.config = config;
    this.directory = null;
    this.originalFile = config.passwordFile;
  }

  set(password) {
    if (this.config.sshFlavor !== "plink")
      throw new Error("Session passwords require a configured Plink transport; OpenSSH is unchanged.");
    if (!this.config.hostKey)
      throw new Error("A pinned Plink host key is required before supplying a password.");
    if (typeof password !== "string" || !password.length || password.length > 4096 || /[\r\n\0]/u.test(password))
      throw new Error("Password must be 1-4096 characters without newline or NUL.");

    const directory = mkdtempSync(path.join(os.tmpdir(), "reliable-ssh-password-"));
    try {
      if (process.platform === "win32") {
        const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
          encoding: "utf8", windowsHide: true, timeout: 5000,
        });
        const sid = identity.match(/S-1-5-(?:\d+-)*\d+/u)?.[0];
        if (!sid) throw new Error("Cannot determine Windows account SID");
        execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], {
          windowsHide: true, timeout: 5000, stdio: "pipe",
        });
      }
      const file = path.join(directory, "password");
      writeFileSync(file, password + "\n", { mode: 0o600, flag: "wx" });
      this.clear();
      this.directory = directory;
      this.config.passwordFile = file;
      return { password_configured: true, scope: "mcp_process", authentication_verified: false };
    } catch {
      removePrivateDirectory(directory);
      throw new Error("Could not prepare the private session password file; previous credential is unchanged.");
    }
  }

  clear() {
    if (this.directory) {
      removePrivateDirectory(this.directory);
      this.directory = null;
      if (this.originalFile === undefined) delete this.config.passwordFile;
      else this.config.passwordFile = this.originalFile;
    }
    return { session_password_cleared: true, configured_password_file_restored: Boolean(this.originalFile) };
  }
}

export function assertPasswordChangeIdle(client) {
  if (client.starting || client.status?.().sessions?.some(session => session.in_flight > 0))
    throw new Error("Wait for in-flight SSH operations before changing credentials.");
}
