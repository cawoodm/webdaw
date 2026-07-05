import { engine } from './audio-engine';
import { bus } from './event-bus';
import { defaultProject, type ProjectData } from './model';
import { idbDel, idbGet, idbKeys, idbSet } from './persistence';
import { projectDataKey, projectNameFromKey, projectUiKey, sanitizeProjectName } from './project-names';
import { store } from './project-store';
import { applyUiState, flushUiState, setUiStatePersister, type UiState } from './ui-state';
import { applyKeyMap, getKeyMap, type KeyMap } from '../midi/keymap';

const ROOT_KEY = 'rootDir';
const ACTIVE_KEY = 'activeProject';
const DEFAULT_NAME = 'default';

/**
 * Owns the ROOT folder (one subdirectory per project) and the active
 * project's lifecycle: restore at boot, switch, create, and full flush
 * (Save / Ctrl+S). Each project directory is self-contained and portable:
 * project.json + ui.json + keymap.json + all WAVs. Everything is also
 * mirrored to IndexedDB so the app works with no folder connected.
 */
class ProjectManager {
  root: FileSystemDirectoryHandle | null = null;
  /** True when a stored root handle exists but needs a user gesture to re-grant. */
  needsPermission = false;
  activeName = DEFAULT_NAME;

  private saving: Promise<void> | null = null;
  private saveQueued = false;

  private dirAvailable(): boolean {
    return this.root !== null && !this.needsPermission;
  }

  /** Boot: migrate legacy keys, restore root handle, load the active project. */
  async restore(): Promise<void> {
    await this.migrateLegacy();
    const handle = await idbGet<FileSystemDirectoryHandle>(ROOT_KEY);
    if (handle) {
      this.root = handle;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      this.needsPermission = perm !== 'granted';
    }
    this.activeName = (await idbGet<string>(ACTIVE_KEY)) ?? DEFAULT_NAME;
    store.setMirrorKey(() => projectDataKey(this.activeName));
    setUiStatePersister(async (snapshot) => {
      await idbSet(projectUiKey(this.activeName), snapshot);
      await store.writeJson('ui.json', snapshot);
    });
    await this.load(this.activeName);
  }

  /** Pick (or change) the root folder; the in-memory project is written into it. */
  async chooseRoot(): Promise<void> {
    this.root = await window.showDirectoryPicker({ id: 'webdaw-root', mode: 'readwrite' });
    this.needsPermission = false;
    await idbSet(ROOT_KEY, this.root);
    store.setDir(await this.projectDir(this.activeName, true));
    await this.saveAll();
    bus.emit('project:loaded');
  }

  /** Re-grant permission for the stored root handle (needs a user gesture). */
  async reconnect(): Promise<void> {
    if (!this.root) return;
    const perm = await this.root.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return;
    this.needsPermission = false;
    // The session so far ran on the IndexedDB mirror — keep it authoritative
    // and write it through to disk, exactly like connecting a fresh root.
    store.setDir(await this.projectDir(this.activeName, true));
    await this.saveAll();
    bus.emit('project:loaded');
  }

  /** Names of all projects: subdirectories of the root plus IndexedDB mirrors. */
  async listProjects(): Promise<string[]> {
    const names = new Set<string>([this.activeName]);
    if (this.dirAvailable()) {
      for await (const handle of this.root!.values()) {
        if (handle.kind === 'directory' && !handle.name.startsWith('.')) names.add(handle.name);
      }
    }
    for (const key of await idbKeys('project:')) {
      const name = projectNameFromKey(key);
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /** Switch to another project (flushes the current one first). */
  async open(name: string): Promise<void> {
    if (name === this.activeName) return;
    await this.saveAll();
    engine.stop();
    await this.load(name);
  }

  /** Create a new empty project and switch to it. Returns false on invalid/duplicate name. */
  async createProject(rawName: string): Promise<boolean> {
    const name = sanitizeProjectName(rawName);
    if (!name) {
      alert('Invalid project name.');
      return false;
    }
    const existing = (await this.listProjects()).map((n) => n.toLowerCase());
    if (existing.includes(name.toLowerCase())) {
      alert(`A project named "${name}" already exists.`);
      return false;
    }
    await this.saveAll();
    engine.stop();
    this.activeName = name;
    store.setDir(await this.projectDir(name, true));
    const data = defaultProject();
    data.name = name;
    store.resetTo(data);
    applyUiState();
    await idbSet(ACTIVE_KEY, name);
    await this.saveAll(); // the new dir is valid/portable from birth
    bus.emit('ui:loaded');
    bus.emit('project:loaded');
    return true;
  }

  /**
   * Full flush: tone WAVs, project.json, ui.json, keymap.json, pending
   * WAVs, and all IndexedDB mirrors. Single-flight — calls during a save
   * collapse into one trailing save.
   */
  saveAll(): Promise<void> {
    if (this.saving) {
      this.saveQueued = true;
      return this.saving;
    }
    this.saving = this.doSave().finally(() => {
      this.saving = null;
      if (this.saveQueued) {
        this.saveQueued = false;
        void this.saveAll();
      }
    });
    return this.saving;
  }

  private async doSave(): Promise<void> {
    await store.saveTones(); // before save() so updated wavFile refs persist
    await store.save();
    await flushUiState();
    await store.writeJson('keymap.json', getKeyMap());
    await store.flushPendingWavs();
  }

  private async projectDir(name: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    if (!this.dirAvailable()) return null;
    try {
      return await this.root!.getDirectoryHandle(name, { create });
    } catch {
      return null;
    }
  }

  /** Load a project (disk first, IndexedDB mirror fallback) and notify the UI. */
  private async load(name: string): Promise<void> {
    this.activeName = name;
    const dir = await this.projectDir(name, this.dirAvailable());
    store.setDir(dir);

    let data = dir ? await store.readJson<ProjectData>('project.json') : null;
    data ??= (await idbGet<ProjectData>(projectDataKey(name))) ?? null;
    const resolved: ProjectData = { ...defaultProject(), ...(data ?? {}) };
    resolved.name = name;
    store.resetTo(resolved);

    let ui = dir ? await store.readJson<Partial<UiState>>('ui.json') : null;
    ui ??= (await idbGet<Partial<UiState>>(projectUiKey(name))) ?? null;
    applyUiState(ui ?? undefined);

    const keymap = dir ? await store.readJson<KeyMap>('keymap.json') : null;
    if (keymap && Object.keys(keymap).length > 0) await applyKeyMap(keymap);

    await store.preloadBuffers();
    await idbSet(ACTIVE_KEY, name);
    // same order as boot always used — modules re-apply UI state, then render
    bus.emit('ui:loaded');
    bus.emit('project:loaded');
  }

  /** One-time move from the single-project keys to the per-project layout. */
  private async migrateLegacy(): Promise<void> {
    if ((await idbKeys('project:')).length > 0) return;
    const legacy = await idbGet<ProjectData>('projectData');
    if (!legacy) return;
    const name = sanitizeProjectName(legacy.name ?? '') ?? DEFAULT_NAME;
    await idbSet(projectDataKey(name), legacy);
    const ui = await idbGet<UiState>('uiState');
    if (ui) await idbSet(projectUiKey(name), ui);
    await idbSet(ACTIVE_KEY, name);
    await idbDel('projectData');
    await idbDel('uiState');
    await idbDel('projectDir');
  }
}

export const projects = new ProjectManager();
