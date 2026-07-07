// Extracts every preset ("instrument") from an SF3 SoundFont into a folder of
// .ogg files plus a webdaw-instrument .inst.json manifest. SF3 stores sample
// data as raw Ogg Vorbis, byte-sliced by the sample header offsets, so no
// decode/re-encode is needed: the sliced bytes are already a standalone .ogg.
//
// Usage: node scripts/extract-soundfont-instruments.mjs [input.sf3] [outputDir]
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@marmooo/soundfont-parser';

const inputPath = process.argv[2] ?? 'C:\\Users\\MarcCawood\\Downloads\\GeneralUserGS.sf3';
const outputRoot = process.argv[3] ?? 'C:\\Users\\MarcCawood\\my-data\\webdaw\\_instruments';

// Mirrors src/midi/note-names.ts (kept in sync manually — this script runs outside the TS build).
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiToNoteName(m) {
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

function slugify(name) {
  return name
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function zonesFromBagRange(generators, bags, from, to) {
  const result = [];
  for (let i = from; i < to; i++) {
    result.push(generators.slice(bags[i].generatorIndex, bags[i + 1].generatorIndex));
  }
  return result;
}

function getPresetZones(parsed, presetHeaderIndex) {
  const header = parsed.presetHeaders[presetHeaderIndex];
  const next = parsed.presetHeaders[presetHeaderIndex + 1];
  const toBag = next ? next.presetBagIndex : parsed.presetZone.length - 1;
  return zonesFromBagRange(parsed.presetGenerators, parsed.presetZone, header.presetBagIndex, toBag);
}

function getInstrumentZones(parsed, instrumentID) {
  const instrument = parsed.instruments[instrumentID];
  const next = parsed.instruments[instrumentID + 1];
  const toBag = next ? next.instrumentBagIndex : parsed.instrumentZone.length - 1;
  return zonesFromBagRange(parsed.instrumentGenerators, parsed.instrumentZone, instrument.instrumentBagIndex, toBag);
}

function zoneToObject(zone) {
  const obj = {};
  for (const g of zone) {
    if (g.type !== undefined) obj[g.type] = g.value;
  }
  return obj;
}

// One entry per sample-referencing zone, with the instrument's global zone
// generators merged underneath (matching how the SF2 spec resolves defaults).
function getInstrumentVoices(parsed, instrumentID) {
  const zones = getInstrumentZones(parsed, instrumentID);
  const globalZone = zones.find((z) => !z.some((g) => g.type === 'sampleID'));
  const globalGenerators = globalZone ? zoneToObject(globalZone) : {};
  const voices = [];
  for (const zone of zones) {
    const generators = zoneToObject(zone);
    if (generators.sampleID === undefined) continue;
    voices.push({ sampleId: generators.sampleID, generators: { ...globalGenerators, ...generators } });
  }
  return voices;
}

// sampleId -> { rootMidi, generators } for every unique sample the preset reaches.
function voicesForPreset(parsed, presetHeaderIndex) {
  const voicesBySample = new Map();
  for (const zone of getPresetZones(parsed, presetHeaderIndex)) {
    const instrumentGen = zone.find((g) => g.type === 'instrument');
    if (!instrumentGen) continue;
    for (const voice of getInstrumentVoices(parsed, instrumentGen.value)) {
      if (!voicesBySample.has(voice.sampleId)) voicesBySample.set(voice.sampleId, voice);
    }
  }
  return voicesBySample;
}

function rootMidiForVoice(voice, sampleHeader) {
  // A single-key keyRange (lo === hi) means this zone is pinned to exactly one MIDI
  // key regardless of recorded pitch — the standard SF2 idiom for percussion zones,
  // where originalPitch is often unset/unreliable. Trust the key assignment there.
  const keyRange = voice.generators.keyRange;
  if (keyRange && keyRange.lo === keyRange.hi) return keyRange.lo;

  const rootKey = voice.generators.overridingRootKey;
  const baseKey = rootKey !== undefined && rootKey !== -1 ? rootKey : sampleHeader.originalPitch;
  return baseKey - (voice.generators.coarseTune ?? 0);
}

const buffer = fs.readFileSync(inputPath);
const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
const parsed = parse(data);

if (parsed.info.version.major !== 3) {
  console.warn(`warning: ${inputPath} is SF${parsed.info.version.major}, not SF3 — sample bytes may not be Ogg Vorbis.`);
}

const attribution = parsed.info.copyright ? `${parsed.info.name} — ${parsed.info.copyright}` : parsed.info.name;

fs.mkdirSync(outputRoot, { recursive: true });

const usedFolderNames = new Map();
let presetCount = 0;
let fileCount = 0;
let droppedCollisions = 0;

for (let i = 0; i < parsed.presetHeaders.length; i++) {
  const preset = parsed.presetHeaders[i];
  if (preset.isEnd) continue;

  let folderName = slugify(preset.presetName);
  const seen = usedFolderNames.get(folderName) ?? 0;
  usedFolderNames.set(folderName, seen + 1);
  if (seen > 0) folderName = `${folderName}-${seen + 1}`;

  const instrumentDir = path.join(outputRoot, folderName);
  fs.rmSync(instrumentDir, { recursive: true, force: true });
  fs.mkdirSync(instrumentDir, { recursive: true });

  const voicesBySample = voicesForPreset(parsed, i);
  const notes = {};
  for (const voice of voicesBySample.values()) {
    const header = parsed.sampleHeaders[voice.sampleId];
    const sample = parsed.samples[voice.sampleId];
    const noteName = midiToNoteName(rootMidiForVoice(voice, header));
    const fileName = `${noteName.replace('#', 's')}.ogg`;

    if (notes[noteName] !== undefined) {
      droppedCollisions++;
      continue;
    }

    fs.writeFileSync(path.join(instrumentDir, fileName), sample.data);
    notes[noteName] = fileName;
    fileCount++;
  }

  const manifest = {
    format: 'webdaw-instrument',
    version: 1,
    name: preset.presetName,
    type: 'audio',
    attribution,
    envelope: { attack: 0, release: 0.3 },
    gain: 1,
    notes,
  };
  fs.writeFileSync(path.join(instrumentDir, `${folderName}.inst.json`), JSON.stringify(manifest, null, 2));

  presetCount++;
}

console.log(`Extracted ${presetCount} instruments (${fileCount} samples) from ${inputPath} to ${outputRoot}`);
if (droppedCollisions > 0) {
  console.log(`Note: ${droppedCollisions} samples shared a root note with another sample in the same instrument and were skipped (one file per note).`);
}
