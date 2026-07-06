# TODO

Mark in progress 🕜 and then move to done ✅ when complete and merge branch into main
Once a task is done, show the user the dev URL, confirm with the user they are happy before marking done

- feat: Add a solo button next to mute for tone layers so they play on their own
- feat: Add a small toggle to enable/disable LPF/HPF completely
- feat: Add an option to increase slope of LPF/HPF
- feat: Add a BPF (band pass filter) in yellow
- feat: Add a dropdown to the "Sample" box which let's the user choose a note (88 notes)

# DONE

- feat: The Sample frequency should be moved to the layer so it's layer-specific ✅ (notes transpose relative to C4; click a knob's number to type a value)
- feat: Export tone should export .json settings of that tone ✅ (browser download of .wav + .json; Ctrl+S writes tones/*.wav to the project folder)
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
