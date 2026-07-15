/** IndexedDB key remembering the last-used (or last-attempted) import URL. */
export const IMPORT_URL_STORAGE_KEY = 'importUrl';

export const DEFAULT_IMPORT_URL =
  'https://raw.githubusercontent.com/cawoodm/webdaw/refs/heads/main/projects/demo%201/project.json';

const BLOB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;

/** Rewrite a GitHub "blob" UI URL to its raw.githubusercontent.com equivalent; any other URL passes through unchanged. */
export function normalizeProjectUrl(url: string): string {
  const trimmed = url.trim();
  const m = BLOB_URL_RE.exec(trimmed);
  if (!m) return trimmed;
  const [, owner, repo, ref, path] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

/** The "projects root" a project.json lives under — its own directory's parent — where `_instruments`/`_tones` live as siblings of every project directory. */
export function deriveLibraryBase(projectUrl: string): string {
  const url = new URL(projectUrl);
  const segments = url.pathname.split('/');
  segments.pop(); // filename, e.g. project.json
  segments.pop(); // the project's own directory
  url.pathname = `${segments.join('/')}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Both known `<name>.inst.json` / `<name>.json` naming conventions seen in the real instrument library, in try-order. */
export function candidateInstrumentDefUrls(libraryBase: string, name: string): string[] {
  const enc = encodeURIComponent(name);
  return [`${libraryBase}_instruments/${enc}/${enc}.inst.json`, `${libraryBase}_instruments/${enc}/${enc}.json`];
}

/** A sample file inside a resolved instrument's own folder. */
export function instrumentAssetUrl(libraryBase: string, name: string, filename: string): string {
  return `${libraryBase}_instruments/${encodeURIComponent(name)}/${encodeURIComponent(filename)}`;
}

/** Resolve a root-relative ref (e.g. "/_tones/mellow-pad.tone.json") against the library base, encoding each path segment. */
export function rootPathUrl(libraryBase: string, rootPath: string): string {
  const segments = rootPath.replace(/^\//, '').split('/').map(encodeURIComponent);
  return `${libraryBase}${segments.join('/')}`;
}

/** Fallback project name when the fetched JSON has no usable `name` field: the URL's own project-directory segment. */
export function fallbackNameFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const dir = segments[segments.length - 2] ?? 'Imported';
  return decodeURIComponent(dir);
}

/** Whether an import should proceed straight through or ask the user to overwrite/rename (case-insensitive match). */
export function nameCollisionAction(name: string, existing: string[]): 'use' | 'ask-overwrite' {
  const lower = new Set(existing.map((n) => n.toLowerCase()));
  return lower.has(name.toLowerCase()) ? 'ask-overwrite' : 'use';
}
