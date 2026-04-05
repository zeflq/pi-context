import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join as localJoin } from "node:path";
import { dirname as posixDirname, join as posixJoin } from "node:path/posix";

/**
 * Thin abstraction so the rest of the code doesn't care whether it is
 * reading local files or tunnelling through SSH.
 */
export interface FsOps {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
  join(...parts: string[]): string;
  dirname(p: string): string;
}

/** Local backend – uses node:fs synchronously, works on Windows and Unix. */
export const localFs: FsOps = {
  async exists(p) {
    try { return existsSync(p); }
    catch { return false; }
  },
  async list(dir) {
    try { return readdirSync(dir); }
    catch { return []; }
  },
  async read(p) {
    try { return readFileSync(p, "utf8"); }
    catch { return null; }
  },
  join: localJoin,
  dirname,
};

/**
 * Executes a command on the remote host via SSH.
 * Returns stdout on success, rejects on non-zero exit.
 */
export function sshExec(remote: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh", [remote, command], { encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as string);
    });
  });
}

/**
 * Remote backend – every operation spawns ssh so it runs on the remote host.
 * Used when the --ssh flag is active (provided by the ssh.ts extension).
 */
export function sshFs(remote: string): FsOps {
  return {
    async exists(p) {
      try { await sshExec(remote, `test -e ${JSON.stringify(p)}`); return true; }
      catch { return false; }
    },
    async read(p) {
      try { return await sshExec(remote, `cat ${JSON.stringify(p)}`); }
      catch { return null; }
    },
    async list(dir) {
      try {
        const out = await sshExec(remote, `ls -1 ${JSON.stringify(dir)}`);
        return out.split("\n").map(l => l.trim()).filter(Boolean);
      } catch { return []; }
    },
    join: posixJoin,
    dirname: posixDirname,
  };
}
