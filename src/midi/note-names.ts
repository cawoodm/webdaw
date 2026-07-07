const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number -> note name, e.g. 60 -> "C4". */
export function midiToNoteName(m: number): string {
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** Note name -> MIDI note number, e.g. "C4" -> 60. Parses sharps and negative octaves (e.g. "A0"). */
export function noteNameToMidi(name: string): number {
  const match = /^([A-Ga-g])(#?)(-?\d+)$/.exec(name.trim());
  if (!match) throw new Error(`Invalid note name: ${name}`);
  const [, letter, sharp, octave] = match;
  const index = NOTE_NAMES.indexOf(`${letter.toUpperCase()}${sharp}`);
  return index + (Number(octave) + 1) * 12;
}
