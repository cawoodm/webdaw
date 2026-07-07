# Master Clock & Metronome

## Overview

WebDAW's audio playback is driven by a **master clock** (Tone.js transport) that all modules listen to. The metronome is a separate timer that clicks in sync with the clock. Multiple tabs can play audio together—the clock ensures they stay synchronized.

## Master Clock (Transport)

The master clock is Tone.js's `Transport` object, managed by the `engine` singleton (`src/core/audio-engine.ts`).

### What It Does

- Tracks playback position in **beats** (4 beats per bar in 4/4 time)
- Maintains the tempo in BPM (beats per minute)
- Synchronizes all scheduled audio events across the app
- Supports looping: you can define a loop region and the transport will restart when it reaches the end

### Key Properties

- **Position**: How far into the song (in beats). When you stop, position resets to 0.
- **BPM**: Tempo. Default is 120 BPM. Changing BPM affects playback speed in real-time.
- **Playing**: Boolean state—either the transport is running or stopped.

### How Modules Use It

When a module wants to play audio:
1. It schedules events at specific beats using Tone's `scheduleOnce()` or `Loop`
2. The transport fires those events automatically as playback proceeds
3. If multiple modules are playing, they all share the same transport and stay in sync

Example: the sequence player schedules each note to play at a specific beat. The tone tab also schedules its keyboard notes. Both hear the same clock tick.

## Metronome

The metronome is an optional click track that ticks on the beat.

### What It Does

- Produces an audio click once per beat (4 clicks per bar)
- Accents the downbeat (beat 0) with a higher-pitched click
- Only runs when playback is running—it never ticks on its own
- Must be toggled on/off; it's off by default

### When It Starts

The metronome ticker is created **before** the transport starts playback (not after). This ensures beat 0 gets a click. If you toggle the metronome on while already playing, it starts immediately.

### How It Works

1. When you press play and the metronome is armed, `engine.play()` creates a `Tone.Loop` that fires once per quarter-note (4 times per bar)
2. On each tick, the loop checks which beat of the bar we're on and plays a click
3. Beat 0 (the downbeat) gets an accent (1.25x playback rate)
4. Beats 1–3 are normal pitch (1x playback rate)

## Play & Stop

### Play

Calling `engine.play()`:
- Starts the transport (begins advancing position)
- If the metronome is armed, creates and starts the metronome ticker
- All modules' scheduled events begin firing as the transport advances

### Stop

Calling `engine.stop()`:
- Stops the transport
- Resets position to beat 0
- Stops the metronome ticker immediately
- Clears all loop requests from modules

## Module Coordination

### Exclusive vs. Shareable Playback

When a module wants to play audio, it can:

- **Claim the transport** (`engine.claimTransport(owner)`): "I need exclusive control." Other modules stop; this module starts fresh from beat 0.
- **Join the transport** (`engine.joinTransport(owner)`): "I want to share." Other modules keep playing; the transport rewinds to beat 0 so we both realign.

Example: the arrange tab claims the transport to play a full song. The tone tab would claim it to preview a patch. The sequence module could join to loop a sequence alongside a sample.

### Loop Coordination

When modules want to loop:
- Each module calls `engine.requestLoop(owner, bars, offsetBars)`
- The engine combines all requests using LCM (least common multiple) so every module's loop length divides evenly into the combined loop
- This ensures they all wrap on bar boundaries simultaneously

Example: Sequence A requests a 4-bar loop; Sequence B requests 8 bars. The combined loop is 8 bars. Both sequences wrap together.

## Timing Reference

All audio events are scheduled in **beats** (or 16th-steps for sequences):
- `engine.secondsPerBeat()` converts a BPM to seconds per beat
- `engine.secondsPerStep()` converts a 16th-step duration to seconds (beat / 4)
- When exporting/rendering, the same code that works live can run inside `Tone.Offline(callback, duration)` and produce a WAV

## Offline Rendering

When you export audio to WAV:
1. The app resolves all audio buffers from the store (before entering offline mode)
2. Schedules events in `Tone.Offline` using the same code as live playback
3. The offline context produces the rendered output
4. The live context automatically resumes when the render completes

The offline context is separate from the live context, so exporting doesn't interrupt playback.
