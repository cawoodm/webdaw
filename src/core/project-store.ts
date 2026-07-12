import * as Tone from './tone';
import { engine } from './audio-engine';
import { bus } from './event-bus';
import { defaultProject, toneBufferKey, type ProjectData } from './model';
import { renderPatch } from './patch-voice';
import { idbSet } from './persistence';
import { encodeWav } from './wav';

const PROJECT_FILE = 'project.json';

/**
 * In-memory model + file IO + audio-buffer cache for the ACTIVE project.
 * The project manager (project-manager.ts) owns the root folder, decides
 * which project subdirectory `dir` points at, and provides the IndexedDB
 * mirror key. Every save writes the mirror; the folder copy is written
 * when a directory handle is attached.
 */
class ProjectStore {
  data: ProjectData = defaultProject();
  dir: FileSystemDirectoryHandle | null = null;
  /** The user-picked ROOT folder, for resolving `_`-prefixed paths (e.g. `_samples/x.wav`) that live above the project dir. */
  rootDir: FileSystemDirectoryHandle | null = null;

  private buffers = new Map<string, AudioBuffer>();
  private pendingWavs = new Set<string>();
  private saveTimer: number | undefined;
  private decodeCtx: OfflineAudioContext | null = null;
  private mirrorKey: () => string = () => 'project:default:data';
  private dirtyFlag = false;
  private diskDirtyFlag = false;
  private onSavedCb: (() => void) | null = null;

  /** True when in-memory edits haven't been saved yet. */
  get dirty(): boolean {
    return this.dirtyFlag;
  }

  /**
   * True when the project folder's `project.json` doesn't reflect the
   * current in-memory data — either because of unsaved edits, or because no
   * folder is connected (a browser-only save never counts as clean).
   */
  get diskDirty(): boolean {
    return this.diskDirtyFlag;
  }

  private setDiskDirty(value: boolean): void {
    if (this.diskDirtyFlag === value) return;
    this.diskDirtyFlag = value;
    bus.emit('project:diskDirty', value);
  }

  /** The manager tells the store where its IndexedDB mirror lives. */
  setMirrorKey(provider: () => string): void {
    this.mirrorKey = provider;
  }

  /** The manager hooks this to broadcast saves to other tabs. */
  setOnSaved(cb: () => void): void {
    this.onSavedCb = cb;
  }

  /** Attach/detach the active project's directory handle. */
  setDir(dir: FileSystemDirectoryHandle | null): void {
    this.dir = dir;
  }

  /** Attach/detach the ROOT folder handle, for resolving `_`-prefixed paths. */
  setRootDir(dir: FileSystemDirectoryHandle | null): void {
    this.rootDir = dir;
  }

  /** Swap in another project's data; clears caches and pending writes. */
  resetTo(data: ProjectData): void {
    clearTimeout(this.saveTimer);
    this.data = data;
    this.buffers.clear();
    this.pendingWavs.clear();
    this.dirtyFlag = false;
    this.setDiskDirty(false);
  }

  /**
   * Decode audio without forcing the live AudioContext into existence
   * before a user gesture (Chrome logs an autoplay warning for that).
   */
  private async decode(raw: ArrayBuffer): Promise<AudioBuffer> {
    if (engine.started) {
      return (Tone.getContext().rawContext as AudioContext).decodeAudioData(raw);
    }
    this.decodeCtx ??= new OfflineAudioContext(1, 1, 44100);
    return this.decodeCtx.decodeAudioData(raw);
  }

  /** Apply a mutation, notify listeners, schedule an autosave. */
  update(mutate: (data: ProjectData) => void): void {
    mutate(this.data);
    this.dirtyFlag = true;
    this.setDiskDirty(true);
    bus.emit('project:changed');
    this.scheduleSave();
  }

  scheduleSave(): void {
    this.dirtyFlag = true;
    this.setDiskDirty(true);
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 800);
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.data.savedAt = Date.now();
    await idbSet(this.mirrorKey(), this.data);
    this.dirtyFlag = false;
    this.onSavedCb?.();
    if (!this.dir) return;
    await this.writeFile(PROJECT_FILE, JSON.stringify(this.data, null, 2));
    this.setDiskDirty(false);
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

  /**
   * Cache the buffer and persist it as a WAV in the project folder.
   * Returns true if the file was written to disk; with no folder connected
   * the WAV is kept in memory and flushed when a folder is chosen.
   */
  async saveWav(path: string, buffer: AudioBuffer): Promise<boolean> {
    this.cacheBuffer(path, buffer);
    if (this.dir) {
      await this.writeFile(path, encodeWav(buffer));
      return true;
    }
    this.pendingWavs.add(path);
    return false;
  }

  /** Write WAVs that were exported before a project folder was connected. */
  async flushPendingWavs(): Promise<void> {
    if (!this.dir) return;
    for (const path of [...this.pendingWavs]) {
      const buffer = this.buffers.get(path);
      if (buffer) await this.writeFile(path, encodeWav(buffer));
      this.pendingWavs.delete(path);
    }
  }

  /**
   * Write every patch's current render into tones/ — part of a full save,
   * so the project folder always carries playable WAVs of its tones.
   */
  async saveTones(): Promise<void> {
    if (!this.dir) return;
    if (!engine.started) engine.allowOfflineRender();
    for (const patch of this.data.patches) {
      const buffer = this.buffers.get(toneBufferKey(patch.id)) ?? (await renderPatch(patch));
      const path = `tones/${patch.name.replace(/[^\w-]+/g, '_')}.wav`;
      this.cacheBuffer(path, buffer);
      await this.writeFile(path, encodeWav(buffer));
      patch.wavFile = path;
    }
  }

  async loadBuffer(path: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(path);
    if (cached) return cached;
    const raw = await this.readFile(path);
    if (!raw) return null;
    try {
      const buffer = await this.decode(raw);
      this.cacheBuffer(path, buffer);
      return buffer;
    } catch (err) {
      console.error(`Failed to decode ${path}`, err);
      return null;
    }
  }

  /** Decode arbitrary audio bytes without caching or copying them anywhere (e.g. instrument library samples). */
  async decodeExternal(raw: ArrayBuffer): Promise<AudioBuffer> {
    return this.decode(raw);
  }

  /** Decode a user-picked file and copy it into the project folder. */
  async importAudioFile(file: File, destPath: string): Promise<AudioBuffer> {
    const raw = await file.arrayBuffer();
    const buffer = await this.decode(raw.slice(0));
    await this.saveWav(destPath, buffer);
    return buffer;
  }

  /** Load every WAV referenced by the current project data into the cache. */
  async preloadBuffers(): Promise<void> {
    const paths = new Set<string>();
    for (const p of this.data.patches) if (p.wavFile) paths.add(p.wavFile);
    for (const pad of this.data.pads) if (pad?.file) paths.add(pad.file);
    for (const seq of this.data.sequences) {
      if (seq.wavFile) paths.add(seq.wavFile);
      if (seq.instrument?.type === 'wav') paths.add(seq.instrument.file);
    }
    for (const t of this.data.arrangement.tracks) {
      for (const c of t.clips) if (c.ref.type === 'file') paths.add(c.ref.file);
    }
    await Promise.all([...paths].map((p) => this.loadBuffer(p)));
  }

  // ---- file system helpers (paths relative to the project subdir) ----

  async readJson<T>(path: string): Promise<T | null> {
    const raw = await this.readFile(path);
    if (!raw) return null;
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as T;
    } catch (err) {
      console.error(`Failed to parse ${path}`, err);
      return null;
    }
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    if (!this.dir) return;
    await this.writeFile(path, JSON.stringify(value, null, 2));
  }

  private async resolveDir(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string } | null> {
    const parts = path.split('/');
    const name = parts.pop()!;
    const fromRoot = parts[0]?.startsWith('_') ?? false;
    let dir = fromRoot ? this.rootDir : this.dir;
    if (!dir) return null;
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
