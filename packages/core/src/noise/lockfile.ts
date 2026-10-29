/**
 * npm lockfile summary (NOISE-6): what a regenerated `package-lock.json` means for direct
 * dependencies, read from the lockfile's root entry (`packages[""]`, lockfile v2/v3), so it
 * works even when `package.json` is not part of the change.
 */

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<
    string,
    {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }
  >;
}

export const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

/** Sentences such as "1 new direct dependency: nodemailer"; empty when unreadable (v1, invalid JSON). */
export function summarizeNpmLockfile(oldText: string | null, newText: string | null): string[] {
  const before = parse(oldText);
  const after = parse(newText);
  if (!before && !after) return [];
  const direct = (l: Lockfile | null, field: 'dependencies' | 'devDependencies') => {
    const root = l?.packages?.[''];
    return new Set(
      Object.keys(
        field === 'dependencies'
          ? { ...root?.dependencies, ...root?.optionalDependencies }
          : (root?.devDependencies ?? {}),
      ),
    );
  };
  const version = (l: Lockfile | null, name: string) =>
    l?.packages?.[`node_modules/${name}`]?.version;

  const lines: string[] = [];
  for (const [field, label] of [
    ['dependencies', 'direct dependenc'],
    ['devDependencies', 'dev dependenc'],
  ] as const) {
    const was = direct(before, field);
    const now = direct(after, field);
    const added = [...now].filter((n) => !was.has(n)).sort();
    const removed = [...was].filter((n) => !now.has(n)).sort();
    if (added.length)
      lines.push(
        `${added.length} new ${label}${added.length === 1 ? 'y' : 'ies'}: ${added.join(', ')}`,
      );
    if (removed.length)
      lines.push(
        `${removed.length} removed ${label}${removed.length === 1 ? 'y' : 'ies'}: ${removed.join(', ')}`,
      );
  }

  const kept = [
    ...new Set([...direct(before, 'dependencies'), ...direct(before, 'devDependencies')]),
  ]
    .filter((n) => direct(after, 'dependencies').has(n) || direct(after, 'devDependencies').has(n))
    .sort();
  const majors = kept.flatMap((n) => {
    const a = version(before, n);
    const b = version(after, n);
    return a && b && major(a) !== major(b) ? [`${n} ${a} → ${b}`] : [];
  });
  if (majors.length) lines.push(`Major version change: ${majors.join(', ')}`);
  else if (kept.length) lines.push('No existing direct dependency changed major version');

  const all = (l: Lockfile | null) =>
    new Map(
      Object.entries(l?.packages ?? {})
        .filter(([k]) => k !== '')
        .map(([k, v]) => [k, v.version]),
    );
  const a = all(before);
  const b = all(after);
  const addedPkgs = [...b.keys()].filter((k) => !a.has(k)).length;
  const removedPkgs = [...a.keys()].filter((k) => !b.has(k)).length;
  const updated = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)).length;
  lines.push(`Installed packages: ${addedPkgs} added, ${removedPkgs} removed, ${updated} updated`);
  return lines;
}

function parse(text: string | null): Lockfile | null {
  if (!text) return null;
  try {
    const l = JSON.parse(text) as Lockfile;
    return l.packages ? l : null;
  } catch {
    return null;
  }
}

function major(version: string): string {
  const [m = '', minor = ''] = version.replace(/^v/, '').split('.');
  // 0.x: the minor version is the breaking one.
  return m === '0' ? `0.${minor}` : m;
}
