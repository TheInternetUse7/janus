import { describe, expect, it, vi } from 'vitest';
import { generateContentHash } from '../../src/lib/loopFilter';

describe('generateContentHash', () => {
  it('returns the same hash for same content/author in same minute', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1710000000000);

    const h1 = generateContentHash('hello', 'alice');
    const h2 = generateContentHash('hello', 'alice');

    expect(h1).toBe(h2);
    nowSpy.mockRestore();
  });

  it('returns different hashes when author changes', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1710000000000);

    const h1 = generateContentHash('hello', 'alice');
    const h2 = generateContentHash('hello', 'bob');

    expect(h1).not.toBe(h2);
    nowSpy.mockRestore();
  });

  it('returns different hashes across minute boundaries', () => {
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1710000000000);
    const h1 = generateContentHash('hello', 'alice');

    nowSpy.mockReturnValue(1710000060000);
    const h2 = generateContentHash('hello', 'alice');

    expect(h1).not.toBe(h2);
    nowSpy.mockRestore();
  });
});
