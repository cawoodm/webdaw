/**
 * Tone.js re-export that avoids the package root ('tone' -> index.js):
 * index.js evaluates deprecated top-level constants (Transport,
 * Destination, Master, Listener, Draw) that call getContext() at module
 * load, creating the AudioContext before any user gesture — which Chrome
 * flags with an autoplay warning. classes.js carries every class without
 * those side effects; the helpers below reproduce the lazy accessors.
 *
 * Always `import * as Tone from '<path>/core/tone'` — never from 'tone'.
 */
export * from 'tone/build/esm/classes.js';
export { getContext, setContext, start } from 'tone/build/esm/core/Global.js';
import { getContext } from 'tone/build/esm/core/Global.js';

/** The current audio context time (lazy — does not create the context at import). */
export function now(): ReturnType<ReturnType<typeof getContext>['now']> {
  return getContext().now();
}

export function getTransport(): ReturnType<typeof getContext>['transport'] {
  return getContext().transport;
}

export function getDestination(): ReturnType<typeof getContext>['destination'] {
  return getContext().destination;
}
