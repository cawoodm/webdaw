# Instructions

- Run a loop to process one task at a time:
  - Read an unmarked TODO from the list below, don't take a task marked 🕜
  - Move it to in-progress and mark it with 🕜 (add name of branch you are on e.g. todos)
  - Begin implementing and ask questions if anything is unclear
  - Once a task is implemented, show the user the full dev URL link (with http://), ask the user if they are happy explaining what was done and how to test it
  - Once the user accepts it, mark as done ✅ and move to DONE
  - Commit (Don't put TODO or claim in the commit message, just the original task text)

# TODOs

- Sequencer: Scroll vertically with mouse wheel, make keyboard twice as wide and show all note names
- Sampler: Should not show orange vertical play bar (or lights) when sampler is not playing

# In-Progress

- pressing sequencer stop should not stop sampler (and vice versa). Only the global stop button stops everything. 🕜 (todos — stop buttons already independent; making Space toggle the active tab only)

# DONE

- Sequencer: Add a clear button to delete all notes ✅ (worktree-midi-file-support — eraser button in the toolbar, confirms then clears the current sequence's notes)
- When starting the app with the sequencer tab open we are still in the wrong octave - always scroll to make the notes visible or to the middle c3 octave ✅ (worktree-midi-file-support — defer the initial scroll when the panel renders hidden at boot, apply once visible)
- When on the sequencer tab, the keyboard should play sequencer (not patch) notes ✅ (todos2)
- sequencer: sampler and sequencer can play at same time ✅ (todos2)
- sequencer: play/rec buttons at top left of screen ✅ (todos2)
- sequencer: play note as it is placed but not when dragged, dbl click to delete ✅ (placement plays through the instrument; drags stay silent)
- sequencer: Don't use browser scroll but scroll buttons above and below keyboard which page half an octave; scroll to center vertically C4 by default ✅
- sequencer: assign colors to each note (A=blue, A#=light blue ... G=Red, G#=light red), higlight entire row on mouseover ✅ (clips + key swatches; color follows a dragged note)
- Add a guage next to master volume to indicate level (green) and clipping (red) ✅ (green -60..0 dB bar beside the volume knob; red 400ms hold on clipping)
- bug: When I save the project Marc with the loop Happy and reload the project Marc on another tab/site I don't see the loop Happy ✅ (stale tabs were clobbering newer saves; saves now broadcast to other tabs and the newer of folder/mirror copy wins on load)
- feat: Sort names of patches and loops in their dropdowns by name ✅ (case-insensitive; stored order unchanged)
- feat: Drag and drop has a nice overlay in tone but not in sample, add it. Also allow dragging to the tab name. ✅ (overlay on all tab panels; tab names switch mid-drag and accept drops)
- feat: Add master volume knob to top ✅ (compact dial in the header, persisted per project)
- feat: When dragging a sample pad (mousedown) don't play it ✅ (pads play on click; drags stay silent)
- feat: BPF should have 0hz as minimum, it should also be able to boost not just attenuate ✅ (peaking bell with ±24 dB gain knob)
- feat: Show quantize gridlines and bar numbers above sample grid ✅
- feat: Be consistent with play/stop/record buttons in the top left of each tab (only icons), global play/stop button (next to metronome, icons only) should play stop everything. In general, spacebar is play/stop. ✅ (both sessions implemented it; todos variant merged — sample tab has a single play/stop toggle + record above the grid)

- feat: Allow drag and drop of sample pads to swap (dest is occupied) or move (if dest empty) ✅
- feat: Add a duplicate button (copy icon) to samples, make new, rename and delete just icons ✅
- feat: When dragging in a new patch with same name, prompt to overwrite or rename ✅ (overwrite keeps the patch id, so pad links survive)
- feat: Move envelope (etc) controls to above the layers ✅
- feat: Add a solo button next to mute for tone layers so they play on their own ✅
- feat: Add a BPF (band pass filter) in yellow ✅ (opt-in checkbox, center-freq knob, slope applies)
- feat: Add an option to increase slope of LPF/HPF ✅ (12/24/48 dB per octave)
- feat: In "tone" when asdfghjkl are pressed play the current sample shifted by a half tone up per letter ✅ (physical key rows: q–p below, home row +0…+8, bottom row +9 and up)
- feat: Change "Root Folder" button to just a Folder icon ✅
- feat: Add a small toggle to enable/disable LPF/HPF completely (same for LFO) ✅
- feat: Add a dropdown to the "Sample" box which let's the user choose a note (88 notes) ✅
- feat: The Sample frequency should be moved to the layer so it's layer-specific ✅ (notes transpose relative to C4; click a knob's number to type a value)
- feat: Export tone should export .json settings of that tone ✅ (browser download of .wav + .json; Ctrl+S writes tones/\*.wav to the project folder)
- the metronome is the clock for playback: when samples play in a loop, align with metronome and BPM ✅
- bug: changing sample length should shorten the x-axis of left viz live and not just envelope ✅
- feat: Add a new wave type "White Noise" which generates a random signal instead of a wave but that random signal is persisted ✅
- bug: Renaming tone should update dropdown in sampler ✅
- bug: Vizualizations are not displayed at startup ✅
- Change wave type dropdown to an icon selector ✅
- User should be able to set frequency and duration of sample ✅
- bug: BPM is not persisting ✅ (could not reproduce — works)
- Live update viz as user drags dials ✅
- Create a vizualisation for the envelope showing how attack/delay is attenuating the signal over time ✅
- Ad viz for the LFO in magenta and add a small magenta square left of the "LFO" label ✅
- Add small orange square left of "Envelope" ✅
- Add small blue/red squares left of "LPF" ✅
- Create dials for HPF and LPF and add these as visualizations to the freq (FFT) vizualization ✅
- Add a dropdown in the sampler to load a tone ✅
- Make the mute button an svg icon ✅
