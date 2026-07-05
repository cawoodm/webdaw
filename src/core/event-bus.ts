import type { TabId } from './model';

export interface BusEvents {
  'project:loaded': void;
  'project:changed': void;
  'tone:sendToPad': { name: string; buffer: AudioBuffer };
  'sample:editInSequencer': { sequenceId: string };
  'tab:activate': TabId;
  'midi:noteon': { note: string; velocity: number };
  'midi:noteoff': { note: string };
}

type Handler = (payload: unknown) => void;

class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on<K extends keyof BusEvents>(type: K, fn: (payload: BusEvents[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler);
    return () => set!.delete(fn as Handler);
  }

  emit<K extends keyof BusEvents>(
    type: K,
    ...payload: BusEvents[K] extends void ? [] : [BusEvents[K]]
  ): void {
    this.handlers.get(type)?.forEach((fn) => fn(payload[0]));
  }
}

export const bus = new EventBus();
