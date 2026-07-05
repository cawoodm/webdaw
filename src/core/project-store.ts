import * as Tone from 'tone';
import { engine } from './audio-engine';
import { bus } from './event-bus';
import { defaultProject, type ProjectData } from './model';
import { idbGet, idbSet } from './persistence';
import { encodeWav } from './wav';

const DIR_KEY = 'projectDir';
const PROJECT_FILE = 'project.json';
const PROJECT_IDB_KEY = 'projectData';

/**
 * In-memory project model with autosave to a File System Access folder.
 * The directory handle is persisted in IndexedDB so the project reopens
 * automatically on reload (a permission re-grant may be required).
 *
 * Every save also mirrors the project JSON to IndexedDB, so edits survive
 * reloads even before a folder is chosen (or while permission is pending).
 * The folder's project.json is authoritative once available.
 */
class ProjectStore {
  data: ProjectData = defaultProject();
  dir: FileSystemDirectoryHandle | null = null;
  /** True when a stored handle exists but needs a user gesture to re-grant. */
  needsPermission = false;

  private buffers = new Map<string, AudioBuffer>();
  private saveTimer: number | undefined;

  async chooseFolder(): Promise<void> {
    this.dir = await window.showDirectoryPicker({ id: 'webdaw', mode: 'readwrite' });
    this.needsPermission = false;
    await idbSet(DIR_KEY, this.dir);
    await this.loadOrInit();
  }

  async tryRestore(): Promise<void> {
    const handle = await idbGet<FileSystemDirectoryHandle>(DIR_KEY);
    if (handle) {
      this.dir = handle;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await this.loadOrInit();
        return;
      }
      this.needsPermission = true;
    }
    // no folder access (yet) — fall back to the IndexedDB mirror
    const cached = await idbGet<ProjectData>(PROJECT_IDB_KEY);
    if (cached) this.data = { ...defaultProject(), ...cached };
    bus.emit('project:loaded');
  }

  async reconnect(): Promise<void> {
    if (!this.dir) return;
    const perm = await this.dir.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      this.needsPermission = false;
      await this.loadOrInit();
    }
  }

  private async loadOrInit(): Promise<void> {
    const raw = await this.readFile(PROJECT_FILE);
    if (raw) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(raw)) as ProjectData;
        this.data = { ...defaultProject(), ...parsed };
      } catch (err) {
        console.error('Failed to parse project.json, starting fresh', err);
        this.data = defaultProject();
      }
    } else {
      await this.save();
    }
    await this.preloadBuffers();
    bus.emit('project:loaded');
  }

  /** Apply a mutation, notify listeners, schedule an autosave. */
  update(mutate: (data: ProjectData) => void): void {
    mutate(this.data);
    bus.emit('project:changed');
    this.scheduleSave();
  }

  scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 800);
  }

  async save(): Promise<void> {
    await idbSet(PROJECT_IDB_KEY, this.data);
    if (!this.dir || this.needsPermission) return;
    await this.writeFile(PROJECT_FILE, JSON.stringify(this.data, null, 2));
  }

  // ---- audio buffers ----

  getBuffer(path: string): AudioBuffer | null {
    return this.buffers.get(path) ?? null;
  }

  setBuffer(path: string, buffer: AudioBuffer): void {
    this.cacheBuffer(path, buffer);
  }

  /** Cache a buffer and silently warm it so its first play has no delay. */
  private cacheBuffer(path: string, buffer: AudioBuffer): void {
    this.buffers.set(path, buffer);
    engine.warmUp(buffer);
  }

  /** Cache the buffer and persist it as a WAV in the project folder. */
  async saveWav(path: string, buffer: AudioBuffer): Promise<void> {
    this.cacheBuffer(path, buffer);
    if (this.dir && !this.needsPermission) {
      await this.writeFile(path, encodeWav(buffer));
    }
  }

  async loadBuffer(path: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(path);
    if (cached) return cached;
    const raw = await this.readFile(path);
    if (!raw) return null;
    try {
      const ctx = Tone.getContext().rawContext as AudioContext;
      const buffer = await ctx.decodeAudioData(raw);
      this.cacheBuffer(path, buffer);
      return buffer;
    } catch (err) {
      console.error(`Failed to decode ${path}`, err);
      return null;
    }
  }

  /** Decode a user-picked file and copy it into the project folder. */
  async importAudioFile(file: File, destPath: string): Promise<AudioBuffer> {
    const raw = await file.arrayBuffer();
    const ctx = Tone.getContext().rawContext as AudioContext;
    const buffer = await ctx.decodeAudioData(raw.slice(0));
    await this.saveWav(destPath, buffer);
    return buffer;
  }

  private async preloadBuffers(): Promise<void> {
    const paths = new Set<string>();
    for (const p of this.data.patches) if (p.wavFile) paths.add(p.wavFile);
    for (const pad of this.data.pads) if (pad?.file) paths.add(pad.file);
    for (const seq of this.data.sequences) {
      if (seq.wavFile) paths.add(seq.wavFile);
      for (const t of seq.tracks) if (t.source?.file) paths.add(t.source.file);
    }
    for (const t of this.data.arrangement.tracks) {
      for (const c of t.clips) if (c.ref.type === 'file') paths.add(c.ref.file);
    }
    await Promise.all([...paths].map((p) => this.loadBuffer(p)));
  }

  // ---- file system helpers ----

  private async resolveDir(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string } | null> {
    if (!this.dir) return null;
    const parts = path.split('/');
    const name = parts.pop()!;
    let dir = this.dir;
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch {
        return null;
      }
    }
    return { dir, name };
  }

  private async writeFile(path: string, data: ArrayBuffer | string): Promise<void> {
    const loc = await this.resolveDir(path, true);
    if (!loc) return;
    const fh = await loc.dir.getFileHandle(loc.name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(data);
    await writable.close();
  }

  private async readFile(path: string): Promise<ArrayBuffer | null> {
    const loc = await this.resolveDir(path, false);
    if (!loc) return null;
    try {
      const fh = await loc.dir.getFileHandle(loc.name);
      const file = await fh.getFile();
      return await file.arrayBuffer();
    } catch {
      return null;
    }
  }
}

export const store = new ProjectStore();
