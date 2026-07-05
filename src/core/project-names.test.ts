import { describe, expect, it } from 'vitest';
import { NEW_PROJECT_SENTINEL, projectDataKey, projectNameFromKey, projectUiKey, sanitizeProjectName } from './project-names';

describe('sanitizeProjectName', () => {
  it('keeps normal names, including spaces and hyphens', () => {
    expect(sanitizeProjectName('My Song')).toBe('My Song');
    expect(sanitizeProjectName('  demo-2 ')).toBe('demo-2');
  });

  it('strips characters invalid in directory names', () => {
    expect(sanitizeProjectName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('rejects empty and effectively-empty names', () => {
    expect(sanitizeProjectName('')).toBeNull();
    expect(sanitizeProjectName('   ')).toBeNull();
    expect(sanitizeProjectName('///')).toBeNull();
  });

  it('strips trailing dots/spaces (Windows) and rejects hidden names', () => {
    expect(sanitizeProjectName('song...')).toBe('song');
    expect(sanitizeProjectName('.hidden')).toBeNull();
  });

  it('rejects the new-project sentinel', () => {
    expect(sanitizeProjectName(NEW_PROJECT_SENTINEL)).toBeNull();
  });
});

describe('project mirror keys', () => {
  it('round-trips names through keys', () => {
    expect(projectNameFromKey(projectDataKey('My Song'))).toBe('My Song');
    expect(projectNameFromKey(projectUiKey('My Song'))).toBe('My Song');
    expect(projectNameFromKey('rootDir')).toBeNull();
  });
});
