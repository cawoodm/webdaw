import './ui/knob';
import './plugins/chain';
import './modules/tone/tone-tab';
import './modules/sample/sample-tab';
import './modules/sequence/sequence-tab';
import './modules/arrange/arrange-tab';
import './modules/produce/produce-tab';
import './shell/app-shell';

import { projects } from './core/project-manager';
import { loadKeyMap } from './midi/keymap';
import { midiInput } from './midi/midi-input';

async function boot(): Promise<void> {
  await loadKeyMap(); // local mapping; the project's keymap.json may override
  await projects.restore(); // emits ui:loaded + project:loaded
  await midiInput.init(); // keyboard fallback only; MIDI access is user-toggled in the shell
}

void boot();
