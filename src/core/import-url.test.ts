import { describe, expect, it } from 'vitest';
import {
  candidateInstrumentDefUrls,
  DEFAULT_IMPORT_URL,
  deriveLibraryBase,
  fallbackNameFromUrl,
  instrumentAssetUrl,
  nameCollisionAction,
  normalizeProjectUrl,
  rootPathUrl,
} from './import-url';

describe('normalizeProjectUrl', () => {
  it('rewrites a GitHub blob URL to raw.githubusercontent.com', () => {
    expect(normalizeProjectUrl('https://github.com/cawoodm/webdaw/blob/main/projects/_instruments/piano/piano.json')).toBe(
      'https://raw.githubusercontent.com/cawoodm/webdaw/main/projects/_instruments/piano/piano.json',
    );
  });

  it('leaves a raw.githubusercontent.com URL untouched', () => {
    expect(normalizeProjectUrl(DEFAULT_IMPORT_URL)).toBe(DEFAULT_IMPORT_URL);
  });

  it('leaves an unrelated URL untouched', () => {
    expect(normalizeProjectUrl('https://example.com/project.json')).toBe('https://example.com/project.json');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeProjectUrl('  https://example.com/project.json  ')).toBe('https://example.com/project.json');
  });
});

describe('deriveLibraryBase', () => {
  it('drops the project.json filename and its parent project directory', () => {
    expect(deriveLibraryBase(DEFAULT_IMPORT_URL)).toBe(
      'https://raw.githubusercontent.com/cawoodm/webdaw/refs/heads/main/projects/',
    );
  });
});

describe('candidateInstrumentDefUrls', () => {
  it('tries .inst.json then .json, URL-encoding the name', () => {
    expect(candidateInstrumentDefUrls('https://example.com/projects/', 'piano')).toEqual([
      'https://example.com/projects/_instruments/piano/piano.inst.json',
      'https://example.com/projects/_instruments/piano/piano.json',
    ]);
  });

  it('URL-encodes names with spaces', () => {
    expect(candidateInstrumentDefUrls('https://example.com/projects/', 'mellow keys')).toEqual([
      'https://example.com/projects/_instruments/mellow%20keys/mellow%20keys.inst.json',
      'https://example.com/projects/_instruments/mellow%20keys/mellow%20keys.json',
    ]);
  });
});

describe('instrumentAssetUrl', () => {
  it('builds a sample-file URL inside the instrument folder', () => {
    expect(instrumentAssetUrl('https://example.com/projects/', 'piano', 'A0.ogg')).toBe(
      'https://example.com/projects/_instruments/piano/A0.ogg',
    );
  });
});

describe('rootPathUrl', () => {
  it('resolves a root-relative path against the library base', () => {
    expect(rootPathUrl('https://example.com/projects/', '/_tones/mellow-pad.tone.json')).toBe(
      'https://example.com/projects/_tones/mellow-pad.tone.json',
    );
  });

  it('encodes a segment containing a space', () => {
    expect(rootPathUrl('https://example.com/projects/', '/_tones/mellow pad.tone.json')).toBe(
      'https://example.com/projects/_tones/mellow%20pad.tone.json',
    );
  });
});

describe('fallbackNameFromUrl', () => {
  it('uses the URL-decoded project directory segment', () => {
    expect(fallbackNameFromUrl(DEFAULT_IMPORT_URL)).toBe('demo 1');
  });
});

describe('nameCollisionAction', () => {
  it('allows straight through when no name matches (case-insensitive)', () => {
    expect(nameCollisionAction('Demo 1', ['Other Song'])).toBe('use');
  });

  it('flags a collision regardless of case', () => {
    expect(nameCollisionAction('demo 1', ['Demo 1'])).toBe('ask-overwrite');
  });
});
