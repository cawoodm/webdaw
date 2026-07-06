/** Sentinel value used by the project dropdown's "- new project -" option. */
export const NEW_PROJECT_SENTINEL = '__new__';

/**
 * Turn user input into a valid project directory name, or null if nothing
 * usable remains. Strips characters invalid in Windows/macOS dir names and
 * trailing dots/spaces; rejects hidden (dot-leading) names and the dropdown
 * sentinel.
 */
export function sanitizeProjectName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const invalid = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', 'g');
  const name = raw.trim().replace(invalid, '').replace(/[. ]+$/, '').trim();
  if (!name || name.startsWith('.') || name === NEW_PROJECT_SENTINEL) return null;
  return name;
}

export function projectDataKey(name: string): string {
  return `project:${name}:data`;
}

export function projectUiKey(name: string): string {
  return `project:${name}:ui`;
}

/** "Kick" -> "Kick 2" (then "Kick 3", …) until it collides with none of `taken`. */
export function uniqueName(wanted: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.toLowerCase()));
  if (!set.has(wanted.toLowerCase())) return wanted;
  let n = 2;
  while (set.has(`${wanted} ${n}`.toLowerCase())) n++;
  return `${wanted} ${n}`;
}

/** Extract the project name from a `project:<name>:data|ui` key. */
export function projectNameFromKey(key: string): string | null {
  const match = /^project:(.+):(data|ui)$/.exec(key);
  return match ? match[1] : null;
}
