/**
 * Launch an external command on Windows without the DEP0190 warning, where
 * Windows allows it.
 *
 * `spawn` on Windows will not find `bee` or `gh` without either the file
 * extension or `shell: true`, and `shell: true` concatenates arguments into a
 * command line without escaping them. Node 22 prints a DEP0190 deprecation
 * warning when it sees that, into the middle of whatever the tool was saying.
 *
 * The resolution is not symmetric, because Windows is not:
 *
 *   - a real executable (`gh.exe`) can be spawned by its resolved path with no
 *     shell at all, and that is what `launch` returns;
 *   - a `.cmd` shim (`bee`, installed by npm) *cannot*: since Node 20.19 /
 *     22.x, spawning a `.cmd` without a shell fails with EINVAL, on purpose.
 *     For those, `launch` returns the bare name and `shell: true`, which is the
 *     only thing that works, and lets the shell do the PATH lookup so a path
 *     with a space in it does not have to survive concatenation.
 *
 * For anything that is really Node in a costume -- `npx tsx` -- do not use this
 * at all. Spawn `process.execPath` with the tool's own entry point.
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const cache = new Map<string, string>();

export interface Launch {
  command: string;
  shell: boolean;
}

export function launch(name: string): Launch {
  const resolved = resolveBin(name);
  const isShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  return isShim ? { command: name, shell: true } : { command: resolved, shell: false };
}

export function resolveBin(name: string): string {
  if (process.platform !== 'win32') return name;
  const hit = cache.get(name);
  if (hit) return hit;

  // Extensions only. `C:\Program Files\nodejs\npx` exists as an extensionless
  // shell script that Windows cannot execute, so matching the bare name first
  // finds a file that then fails to spawn with ENOENT.
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const qualified = extensions.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of qualified ? [''] : extensions) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (existsSync(candidate)) {
        cache.set(name, candidate);
        return candidate;
      }
    }
  }
  // Not on PATH. Return the bare name, so the caller's own "is it installed"
  // error is what the user sees rather than one from here.
  return name;
}
