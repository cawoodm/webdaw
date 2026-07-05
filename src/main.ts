import './ui/knob';
import './plugins/chain';
import './modules/tone/tone-tab';
import './modules/sample/sample-tab';
import './modules/sequence/sequence-tab';
import './modules/arrange/arrange-tab';
import './modules/produce/produce-tab';
import './shell/app-shell';

import { loadKeyMap } from './midi/keymap';
import { midiInput } from './midi/midi-input';
import { store } from './core/project-store';

async function boot(): Promise<void> {
  await loadKeyMap();
  await midiInput.init();
  await store.tryRestore();
}

void boot();
