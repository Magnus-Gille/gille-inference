import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HALOGEN_PILOT_PROFILE as profile, halogenEnvironment, halogenProfileHash, halogenRequest } from '../src/homeserver/halogen-profile.js';

describe('Halogen lab profile', () => {
  it('binds the downloadable candidate to the configured runtime and model revision', () => {
    const manifest = JSON.parse(readFileSync(new URL('../deploy/halogen-candidate.json', import.meta.url), 'utf8'));
    expect(manifest.image).toBe(profile.image);
    expect(manifest.revision).toBe(profile.modelRevision);
    expect(manifest.files).toHaveLength(8);
    expect(manifest.files.reduce((n: number, f: {bytes: number}) => n + f.bytes, 0)).toBe(126663462884);
  });
  it('pins sampling, output reserve and explicit reasoning in the effective request', () => {
    const request = halogenRequest(profile, [{ role: 'user', content: 'fixture' }]);
    expect(request).toMatchObject({ max_tokens: 16384, temperature: 1, top_p: 0.95,
      top_k: 20, min_p: 0, reasoning_effort: 'xhigh',
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } });
  });
  it.each([{ image: 'latest' }, { context: 262144 }, { maxTokens: 2048 },
    { slots: 4 }, { temperature: 0 }, { extra: true }])('rejects drift: %j', change => {
    expect(() => halogenEnvironment({ ...profile, ...change })).toThrow();
  });
  it('separates allocation from context and refuses automatic fit-down', () => {
    expect(halogenEnvironment(profile)).toMatchObject({ HALOGEN_CTX: '32768',
      HALOGEN_KV_POOL_POSITIONS: '32768', HALOGEN_KV_POOL_FIT: '0', HALOGEN_KV_SLOTS: '1',
      HALOGEN_PLD: '0', HALOGEN_COMPOSABLE_CONTEXT: '0' });
    expect(halogenEnvironment(profile)).not.toHaveProperty('HALOGEN_DOWNLOAD');
  });
  it('changes evidence identity when context or cache changes, independent of object key order', () => {
    const reordered = Object.fromEntries(Object.entries(profile).reverse());
    expect(halogenProfileHash(reordered)).toBe(halogenProfileHash(profile));
    expect(halogenProfileHash({ ...profile, context: 65536 })).not.toBe(halogenProfileHash(profile));
    expect(halogenProfileHash({ ...profile, cacheMode: 2 })).not.toBe(halogenProfileHash(profile));
  });
});
