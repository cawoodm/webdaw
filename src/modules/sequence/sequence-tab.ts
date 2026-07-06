import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { SeqTrack, Sequence, SynthKind } from '../../core/model';
import { STEPS_PER_BAR, uid } from '../../core/model';
import { store } from '../../core/project-store';
import { uiState, updateUi } from '../../core/ui-state';
import { knob } from '../../ui/knob';
import { makeSynth, playSequenceLive, renderSequence, type LivePlayback } from './sequence-playback';
import * as Tone from '../../core/tone';

const PIANO_NOTES: string[] = [];
for (let octave = 5; octave >= 3; octave--) {
  for (const n of ['B', 'A#', 'A', 'G#', 'G', 'F#', 'F', 'E', 'D#', 'D', 'C#', 'C']) {
    PIANO_NOTES.push(`${n}${octave}`);
  }
}

export class SequenceTab extends HTMLElement {
  private seqId = '';
  private selectedTrackId = '';
  private playback: LivePlayback | null = null;
  private recording = false;
  private monitorSynth: Tone.PolySynth | null = null;
  private heldNotes = new Map<string, number>(); // note -> beat at noteon

  connectedCallback(): void {
    this.className = 'tab-panel sequence-tab';
    bus.on('project:loaded', () => this.render());
    bus.on('ui:loaded', () => {
      this.seqId = uiState().sequence.seqId;
      this.selectedTrackId = uiState().sequence.trackId;
      this.render();
    });
    bus.on('sample:editInSequencer', ({ sequenceId }) => {
      this.selectSeq(sequenceId);
      this.render();
    });
    // playback survives tab switches; release only when another module claims it
    bus.on('transport:claim', ({ owner }) => {
      if (owner === 'sequence') return;
      this.playback?.dispose();
      this.playback = null;
      if (this.recording) {
        this.recording = false;
        this.render();
      }
    });
    bus.on('midi:noteon', ({ note, velocity }) => this.onNoteOn(note, velocity));
    bus.on('midi:noteoff', ({ note }) => this.onNoteOff(note));
    this.render();
  }

  private isActive(): boolean {
    return this.classList.contains('active-tab');
  }

  private selectSeq(id: string): void {
    this.seqId = id;
    updateUi((s) => (s.sequence.seqId = id));
  }

  private selectTrack(id: string): void {
    this.selectedTrackId = id;
    updateUi((s) => (s.sequence.trackId = id));
  }

  private seq(): Sequence | null {
    return store.data.sequences.find((s) => s.id === this.seqId) ?? store.data.sequences[0] ?? null;
  }

  private selectedTrack(): SeqTrack | null {
    const seq = this.seq();
    return seq?.tracks.find((t) => t.id === this.selectedTrackId) ?? null;
  }

  // ---- live note input (monitor + record) ----

  private onNoteOn(note: string, velocity: number): void {
    if (!this.isActive()) return;
    const track = this.selectedTrack();
    if (!track || track.kind !== 'midi') return;
    void engine.ensureStarted().then(() => {
      if (!this.monitorSynth) {
        this.monitorSynth = makeSynth(track.synth).connect(engine.master);
      }
      this.monitorSynth.triggerAttack(note, Tone.immediate(), velocity);
    });
    if (this.recording && engine.playing) {
      this.heldNotes.set(note, engine.positionBeats);
    }
  }

  private onNoteOff(note: string): void {
    if (!this.isActive()) return;
    this.monitorSynth?.triggerRelease(note, Tone.immediate());
    const onBeat = this.heldNotes.get(note);
    if (onBeat === undefined) return;
    this.heldNotes.delete(note);
    const seq = this.seq();
    const track = this.selectedTrack();
    if (!seq || !track || track.kind !== 'midi') return;
    const totalSteps = seq.bars * STEPS_PER_BAR;
    const step = Math.round(onBeat * 4) % totalSteps;
    const duration = Math.max(1, Math.round((engine.positionBeats - onBeat) * 4));
    store.update(() => {
      track.notes = track.notes ?? [];
      track.notes.push({ step, note, duration, velocity: 0.8 });
    });
    this.renderGrid();
  }

  // ---- playback ----

  private async play(): Promise<void> {
    const seq = this.seq();
    if (!seq) return;
    await engine.ensureStarted();
    this.stopPlayback(false);
    engine.claimTransport('sequence');
    this.playback = playSequenceLive(seq, engine.master);
    engine.setLoop(seq.bars);
    engine.play();
  }

  private stopPlayback(fullStop = true): void {
    this.playback?.dispose();
    this.playback = null;
    if (fullStop) {
      engine.stop();
      engine.setLoop(0);
      this.recording = false;
    }
  }

  // ---- rendering ----

  private render(): void {
    this.innerHTML = '';
    const seq = this.seq();
    if (seq) this.seqId = seq.id;

    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const btn = (label: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.onclick = fn;
      return b;
    };

    const select = document.createElement('select');
    for (const s of store.data.sequences) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      opt.selected = s.id === this.seqId;
      select.appendChild(opt);
    }
    select.onchange = (): void => {
      this.selectSeq(select.value);
      this.render();
    };
    bar.append(
      select,
      btn('New', () => {
        const s: Sequence = { id: uid(), name: `Sequence ${store.data.sequences.length + 1}`, bars: 2, tracks: [] };
        store.update((d) => d.sequences.push(s));
        this.selectSeq(s.id);
        this.render();
      }),
    );

    if (seq) {
      const barsSel = document.createElement('select');
      for (const n of [1, 2, 4, 8]) {
        const opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = `${n} bars`;
        opt.selected = seq.bars === n;
        barsSel.appendChild(opt);
      }
      barsSel.onchange = (): void => {
        store.update(() => (seq.bars = Number(barsSel.value)));
        this.render();
      };
      bar.append(
        btn('Rename', () => {
          const name = prompt('Sequence name', seq.name);
          if (name) {
            store.update(() => (seq.name = name));
            this.render();
          }
        }),
        btn('Delete', () => {
          store.update((d) => (d.sequences = d.sequences.filter((s) => s.id !== seq.id)));
          this.selectSeq('');
          this.render();
        }),
        barsSel,
        btn('▶ Play', () => void this.play()),
        btn('⏹ Stop', () => this.stopPlayback()),
        btn(this.recording ? '⏺ Recording…' : '⏺ Record MIDI', async () => {
          if (this.recording) {
            this.stopPlayback();
          } else {
            this.recording = true;
            await this.play();
          }
          this.render();
        }, this.recording ? 'active' : ''),
        btn('Bounce to WAV', async () => {
          const buffer = await renderSequence(seq);
          const path = `sequences/${seq.name.replace(/[^\w-]+/g, '_')}.wav`;
          const written = await store.saveWav(path, buffer);
          store.update(() => (seq.wavFile = path));
          this.flash(written ? `Bounced to ${path}` : `Bounced ${path} in memory — connect a project folder to write files`);
        }),
        btn('+ Audio track', () => this.addTrack(seq, 'audio')),
        btn('+ MIDI track', () => this.addTrack(seq, 'midi')),
      );
    }
    this.appendChild(bar);

    if (!seq) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'No sequences yet. Create one, or record a pad loop in the Sample tab.';
      this.appendChild(hint);
      return;
    }

    const gridWrap = document.createElement('div');
    gridWrap.className = 'seq-tracks';
    this.appendChild(gridWrap);
    this.renderGrid();
  }

  private addTrack(seq: Sequence, kind: 'audio' | 'midi'): void {
    const track: SeqTrack = {
      id: uid(),
      name: kind === 'audio' ? 'Audio' : 'MIDI',
      kind,
      gain: 0.9,
      ...(kind === 'audio' ? { source: {}, steps: [] } : { synth: 'synth' as SynthKind, notes: [] }),
    };
    store.update(() => seq.tracks.push(track));
    this.selectTrack(track.id);
    this.render();
  }

  private renderGrid(): void {
    const wrap = this.querySelector('.seq-tracks');
    const seq = this.seq();
    if (!wrap || !seq) return;
    wrap.innerHTML = '';
    const totalSteps = seq.bars * STEPS_PER_BAR;

    for (const track of seq.tracks) {
      const row = document.createElement('div');
      row.className = 'seq-track card' + (track.id === this.selectedTrackId ? ' selected' : '');

      const head = document.createElement('div');
      head.className = 'seq-track-head';
      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = `${track.name} (${track.kind})`;
      title.onclick = (): void => {
        this.selectTrack(track.id);
        this.monitorSynth?.dispose();
        this.monitorSynth = null;
        this.renderGrid();
      };
      head.appendChild(title);

      if (track.kind === 'audio') {
        head.appendChild(this.sourceSelect(track));
      } else {
        head.appendChild(this.synthSelect(track));
      }
      head.appendChild(
        knob({ label: 'Gain', min: 0, max: 1.2, step: 0.01, value: track.gain }, (v) => {
          track.gain = v;
          store.scheduleSave();
        }),
      );
      const del = document.createElement('button');
      del.textContent = '✕';
      del.onclick = (): void => {
        store.update(() => seq.tracks.splice(seq.tracks.indexOf(track), 1));
        this.render();
      };
      head.appendChild(del);
      row.appendChild(head);

      if (track.kind === 'audio') {
        row.appendChild(this.stepRow(track, totalSteps));
      } else if (track.id === this.selectedTrackId) {
        row.appendChild(this.pianoRoll(track, totalSteps));
      } else {
        row.appendChild(this.midiSummary(track, totalSteps));
      }
      wrap.appendChild(row);
    }
  }

  private sourceSelect(track: SeqTrack): HTMLSelectElement {
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— source —';
    sel.appendChild(none);
    store.data.pads.forEach((pad, i) => {
      if (!pad) return;
      const opt = document.createElement('option');
      opt.value = `pad:${i}`;
      opt.textContent = `Pad ${i + 1}: ${pad.name}`;
      opt.selected = track.source?.pad === i;
      sel.appendChild(opt);
    });
    for (const patch of store.data.patches) {
      if (!patch.wavFile) continue;
      const opt = document.createElement('option');
      opt.value = `file:${patch.wavFile}`;
      opt.textContent = `Tone: ${patch.name}`;
      opt.selected = track.source?.file === patch.wavFile;
      sel.appendChild(opt);
    }
    sel.onchange = (): void => {
      const v = sel.value;
      store.update(() => {
        if (v.startsWith('pad:')) track.source = { pad: Number(v.slice(4)) };
        else if (v.startsWith('file:')) track.source = { file: v.slice(5) };
        else track.source = {};
      });
    };
    return sel;
  }

  private synthSelect(track: SeqTrack): HTMLSelectElement {
    const sel = document.createElement('select');
    for (const [value, label] of [['synth', 'Synth'], ['fm', 'FM Synth'], ['am', 'AM Synth']] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = track.synth === value;
      sel.appendChild(opt);
    }
    sel.onchange = (): void => {
      store.update(() => (track.synth = sel.value as SynthKind));
      this.monitorSynth?.dispose();
      this.monitorSynth = null;
    };
    return sel;
  }

  private stepRow(track: SeqTrack, totalSteps: number): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'step-grid';
    grid.style.gridTemplateColumns = `repeat(${totalSteps}, 1fr)`;
    for (let s = 0; s < totalSteps; s++) {
      const cell = document.createElement('div');
      cell.className =
        'step-cell' + ((track.steps ?? []).includes(s) ? ' on' : '') + (s % STEPS_PER_BAR === 0 ? ' bar-start' : '');
      cell.onclick = (): void => {
        store.update(() => {
          track.steps = track.steps ?? [];
          const idx = track.steps.indexOf(s);
          if (idx >= 0) track.steps.splice(idx, 1);
          else track.steps.push(s);
        });
        cell.classList.toggle('on');
      };
      grid.appendChild(cell);
    }
    return grid;
  }

  private pianoRoll(track: SeqTrack, totalSteps: number): HTMLElement {
    const roll = document.createElement('div');
    roll.className = 'piano-roll';
    for (const note of PIANO_NOTES) {
      const row = document.createElement('div');
      row.className = 'roll-row';
      const label = document.createElement('span');
      label.className = 'roll-label' + (note.includes('#') ? ' black' : '');
      label.textContent = note;
      row.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'step-grid roll-grid';
      grid.style.gridTemplateColumns = `repeat(${totalSteps}, 1fr)`;
      for (let s = 0; s < totalSteps; s++) {
        const cell = document.createElement('div');
        const has = (track.notes ?? []).some((n) => n.note === note && n.step === s);
        cell.className = 'step-cell' + (has ? ' on' : '') + (s % STEPS_PER_BAR === 0 ? ' bar-start' : '');
        cell.onclick = (): void => {
          store.update(() => {
            track.notes = track.notes ?? [];
            const idx = track.notes.findIndex((n) => n.note === note && n.step === s);
            if (idx >= 0) track.notes.splice(idx, 1);
            else track.notes.push({ step: s, note, duration: 1, velocity: 0.8 });
          });
          cell.classList.toggle('on');
        };
        grid.appendChild(cell);
      }
      row.appendChild(grid);
      roll.appendChild(row);
    }
    return roll;
  }

  private midiSummary(track: SeqTrack, totalSteps: number): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'step-grid';
    grid.style.gridTemplateColumns = `repeat(${totalSteps}, 1fr)`;
    const stepsWithNotes = new Set((track.notes ?? []).map((n) => n.step));
    for (let s = 0; s < totalSteps; s++) {
      const cell = document.createElement('div');
      cell.className =
        'step-cell' + (stepsWithNotes.has(s) ? ' on midi' : '') + (s % STEPS_PER_BAR === 0 ? ' bar-start' : '');
      grid.appendChild(cell);
    }
    grid.title = 'Click track name to open piano roll';
    return grid;
  }

  private flash(msg: string): void {
    const el = document.createElement('div');
    el.className = 'flash';
    el.textContent = msg;
    this.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
}

customElements.define('sequence-tab', SequenceTab);
