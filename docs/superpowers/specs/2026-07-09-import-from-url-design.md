# Import a project from a URL — design

## Goal

Add a cloud icon to the header that lets a user load a WebDAW project from a
remote `project.json` URL (e.g. a GitHub raw link), automatically resolving
its instrument and tone references from a sibling `_instruments`/`_tones`
library, and saving the result as a new local project.

## UI entry point

- A new icon-button (`.import-btn`, cloud SVG) in `app-shell.ts`'s
  `.project-menu`, next to the existing folder icon.
- Clicking it calls `openImportDialog()`, a new standalone dialog module at
  `src/ui/import-dialog.ts`, following the exact pattern already used by
  `src/ui/keymap-dialog.ts`: builds a `<dialog>`, appends to `document.body`,
  `showModal()`.
- Dialog contents: a URL text input, an "Import" button, a "Cancel" button,
  and an inline status/error line.
- The URL field is prefilled from IndexedDB key `importUrl`; if unset, it
  defaults to
  `https://raw.githubusercontent.com/cawoodm/webdaw/refs/heads/main/projects/demo%201/project.json`.
- Every Import click writes the current field value back to `importUrl` in
  IndexedDB immediately (before validating), so it becomes the default for
  next time regardless of outcome.
- Import is always available — it does not require a connected root folder.
  Without one, the result lands only in the IndexedDB project mirror (same
  as any project when no folder is connected); with one, it's also written
  to disk.

## URL normalization

Before fetching, rewrite a pasted `github.com/<owner>/<repo>/blob/<ref>/<path>`
URL to `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` (users
will naturally copy "blob" links from the GitHub UI). Leave any other URL
(including one already pointing at `raw.githubusercontent.com`) untouched.

## Import flow

New method `projects.importFromUrl(url: string): Promise<{ok: true; warnings: string[]} | {ok: false; error: string}>`
in `src/core/project-manager.ts`:

1. Normalize the URL (see above) and save it to `importUrl` in IndexedDB.
2. `fetch()` it. Network error or non-2xx → `{ok:false, error}`; dialog shows
   the error inline and stays open. Nothing is created.
3. `JSON.parse` the body, then run it through the existing `normalizeProject()`
   (the same defaulting/id-repair function boot and legacy-load already use).
   Parse failure or a value `normalizeProject` can't make sense of → same
   inline-error path as step 2.
4. Determine the new project's name: sanitize the parsed `name` field via the
   existing `sanitizeProjectName()`; if that yields nothing usable, derive a
   name from the URL's project-directory path segment instead.
5. Check `listProjects()` for a case-insensitive collision (same rule
   `createProject()` uses):
   - No collision → proceed with that name.
   - Collision → `confirm('A project named "<name>" already exists. Overwrite?')`.
     - OK → proceed, overwriting that project.
     - Cancel → `prompt('New project name', <name>)`. Empty or
       cancelled → abort the whole import (dialog stays open, no changes).
6. Resolve instrument/tone references (see below), collecting a `warnings`
   list of any names/ids that couldn't be resolved.
7. Commit: same tail as `createProject()` — set `activeName`, `store.setDir`,
   `store.resetTo(normalizeProject(data))`, `idbSet(ACTIVE_KEY, name)`,
   `saveAll()`, emit `ui:loaded` + `project:loaded`. Extract this shared tail
   into a small private helper used by both `createProject` and
   `importFromUrl` rather than duplicating it.
8. Close the dialog. If `warnings.length > 0`, `alert()` a summary: "Imported
   '<name>' but couldn't resolve: <list>."

## Instrument & tone resolution

Runs after step 3 (valid project data), before step 7 (commit):

1. Compute `libraryBase`: drop the last two path segments off the (normalized)
   project URL — `.../projects/<project-dir>/project.json` →
   `.../projects/`. This mirrors the local root-folder layout, where
   `_instruments`/`_tones` are siblings of every project directory.
2. Collect every distinct instrument `name` referenced by
   `{type:'instrument', name}` entries in the imported data's sequences.
3. For each name, try in order until one 2xx's:
   `${libraryBase}_instruments/${name}/${name}.inst.json`, then
   `${libraryBase}_instruments/${name}/${name}.json` (both filename
   conventions are in active use in the real repo). Parse with the existing
   `parseInstrumentDef`; a name with no successful fetch is added to
   `warnings` and skipped.
4. For a resolved `type: 'audio'` def: fetch every filename in `notes`
   (relative to that instrument's folder, e.g. `${instrumentDir}/A0.ogg`) as
   `arrayBuffer()`. A file that fails to fetch is dropped from that
   instrument's playable notes (same as today's local per-note try/catch) —
   does not add to `warnings` (matches existing per-note-failure handling,
   which only `console.warn`s).
5. For a resolved `type: 'tone'` def: each note's value is a tone *ref*, which
   is either a project-local patch id or a root-relative file path starting
   with `/` (e.g. `/_tones/mellow-pad.tone.json`) — the filename-equals-id
   convention no longer exists. A ref not starting with `/` is looked up only
   in the imported project's own `patches` array (matches local `findTone`'s
   first fallback leg; there is no global/remote id scan). A ref starting
   with `/` is fetched directly as `${libraryBase}<path>` (each path segment
   URL-encoded) — there is no directory listing to scan over a static file
   host, unlike the local filesystem case. Still unresolved → added to that
   instrument's `missingTones`, which existing code already surfaces as a
   non-blocking console warning; also add `"<instrument>: tone <ref>"` to the
   overall `warnings` list for the post-import alert.
6. Whatever resolved (defs + fetched audio buffers) is written into the
   *new* project's own `instruments/<name>/` folder when a disk folder is
   connected, via the same raw `FileSystemDirectoryHandle` writes
   `importInstrument()` already uses (create dir, write `<name>.inst.json` +
   each sample file). Either way (folder or not), resolved instruments also
   populate the in-memory `instrumentCache` so the just-imported project
   plays immediately in the current session. Without a folder, nothing is
   persisted beyond that in-memory cache — a future reload re-fetches from
   the network, same as any other IndexedDB-only project re-deriving what it
   needs at load time.

## Error handling summary

- Fetch/parse/schema failure on the top-level `project.json` → inline dialog
  error, nothing created, retry in place.
- Name collision → confirm/prompt flow above; cancelling either step aborts
  with no partial writes.
- Individual instrument/tone resolution failure → non-blocking; import
  completes, summarized in a post-import `alert()`.
- CORS: `raw.githubusercontent.com` sends permissive CORS headers, so
  `fetch()` works directly from the browser for both the project JSON and
  the derived instrument/tone URLs; no proxy needed.

## Testing

Everything that touches `fetch()` or `FileSystemDirectoryHandle` can't run
under Vitest (no network, no real filesystem). Split out the pure logic into
testable helpers in a file without side effects, e.g. `src/core/import-url.ts`:

- URL normalization (`blob` → `raw.githubusercontent.com`).
- `libraryBase` derivation from a project URL.
- Instrument-name-candidate generation (`.inst.json` / `.json` ordering).
- Name-collision resolution logic, expressed as a pure function of
  `(parsedName, existingNames) → 'use' | 'ask-overwrite'` so the
  confirm/prompt calls stay a thin wrapper in `project-manager.ts`.

These get unit tests (`src/core/import-url.test.ts`). The end-to-end fetch +
resolve + write flow is verified manually in the browser against the actual
demo URL, per this project's existing convention for anything that can't be
unit-tested in Node.
