import './ui/knob';
import './plugins/chain';
import './modules/tone/tone-tab';
import './modules/sample/sample-tab';
import './modules/sequence/sequence-tab';
import './modules/arrange/arrange-tab';
import './modules/produce/produce-tab';
import './shell/app-shell';

import { bus } from './core/event-bus';
import { store } from './core/project-store';
import { loadUiState } from './core/ui-state';
import { loadKeyMap } from './midi/keymap';
import { midiInput } from './midi/midi-input';

async function boot(): Promise<void> {
  await loadKeyMap();
  await loadUiState();
  bus.emit('ui:loaded');
  await midiInput.init();
  await store.tryRestore();
}

void boot();
