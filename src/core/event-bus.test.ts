import { describe, expect, it } from 'vitest';
import { bus } from './event-bus';

describe('EventBus', () => {
  it('delivers payloads to subscribers', () => {
    let seen: string | undefined;
    const off = bus.on('tab:activate', (tab) => (seen = tab));
    bus.emit('tab:activate', 'sequence');
    off();
    expect(seen).toBe('sequence');
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
