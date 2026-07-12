import * as Tone from '../core/tone';

export interface PluginMeta {
  id: string;
  name: string;
}

/** Optional host context handed to plugin UIs (chain host decides what it knows). */
export interface PluginUiContext {
  /** Offline-render the pre-FX source audio this chain is attached to, if known. */
  renderSource?: () => Promise<AudioBuffer | null>;
}

/**
 * A DAW plugin is an audio processor with a small UI.
 * Nodes are created against the currently active Tone context, so plugins
 * can be instantiated inside Tone.Offline for rendering.
 */
export interface DawPlugin {
  readonly meta: PluginMeta;
  readonly input: Tone.ToneAudioNode;
  readonly output: Tone.ToneAudioNode;
  createUI(ctx?: PluginUiContext): HTMLElement;
  getState(): Record<string, number>;
  setState(state: Record<string, number>): void;
  dispose(): void;
}

export interface PluginFactory {
  meta: PluginMeta;
  create(): DawPlugin;
}

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  log?: boolean;
  unit?: string;
}
