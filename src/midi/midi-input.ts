import { bus } from '../core/event-bus';
import { noteForKey } from './keymap';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number -> note name, e.g. 60 -> "C4". */
function midiToNote(key: number): string {
  return `${NOTE_NAMES[key % 12]}${Math.floor(key / 12) - 1}`;
}

/**
 * Note input: Web MIDI devices plus computer-keyboard fallback.
 * Both paths emit 'midi:noteon' / 'midi:noteoff' on the bus.
 * Deliberately Tone-free: MIDI messages can arrive before the first user
 * gesture, and creating the audio context then triggers Chrome's autoplay
 * warning.
 */
class MidiInput {
  deviceNames: string[] = [];
  private downKeys = new Set<string>();

  async init(): Promise<void> {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    if (!navigator.requestMIDIAccess) return;
    try {
      const access = await navigator.requestMIDIAccess();
      const attach = (): void => {
        this.deviceNames = [];
        access.inputs.forEach((input) => {
          this.deviceNames.push(input.name ?? 'MIDI device');
          input.onmidimessage = this.onMessage;
        });
      };
      access.onstatechange = attach;
      attach();
    } catch (err) {
      console.warn('Web MIDI unavailable', err);
    }
  }

  private onMessage = (e: MIDIMessageEvent): void => {
    const data = e.data;
    if (!data || data.length < 3) return;
    const [status, key, velocity] = data;
    const cmd = status & 0xf0;
    const note = midiToNote(key);
    if (cmd === 0x90 && velocity > 0) {
      bus.emit('midi:noteon', { note, velocity: velocity / 127 });
    } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
      bus.emit('midi:noteoff', { note });
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || this.isTyping(e)) return;
    const note = noteForKey(e.code);
    if (!note || this.downKeys.has(e.code)) return;
    this.downKeys.add(e.code);
    bus.emit('midi:noteon', { note, velocity: 0.8 });
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const note = noteForKey(e.code);
    if (!note) return;
    this.downKeys.delete(e.code);
    bus.emit('midi:noteoff', { note });
  };

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
  }
}

export const midiInput = new MidiInput();
