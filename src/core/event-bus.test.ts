import { describe, expect, it } from 'vitest';
import { bus } from './event-bus';

describe('EventBus', () => {
  it('delivers payloads to subscribers', () => {
    let seen = '';
    const off = bus.on('sample:editInSequencer', (p) => (seen = p.sequenceId));
    bus.emit('sample:editInSequencer', { sequenceId: 'abc' });
    off();
    expect(seen).toBe('abc');
  });

  it('stops delivering after unsubscribe', () => {
    let count = 0;
    const off = bus.on('project:changed', () => count++);
    bus.emit('project:changed');
    off();
    bus.emit('project:changed');
    expect(count).toBe(1);
  });
});
