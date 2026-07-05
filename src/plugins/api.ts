import * as Tone from 'tone';

export interface PluginMeta {
  id: string;
  name: string;
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
  createUI(): HTMLElement;
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
