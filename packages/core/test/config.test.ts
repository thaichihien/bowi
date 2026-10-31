import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, UsageError } from '../src/index.ts';

describe('parseConfig (§10, CLI-9)', () => {
  it('merges settings over the defaults', () => {
    const { config, warnings } = parseConfig(
      JSON.stringify({
        $schema: './bowi.schema.json',
        base: 'develop',
        generated: ['src/graphql/generated/**'],
        layers: { schema: ['db/migrations/**'] },
        grouping: { edgeThreshold: 0.6 },
        outsideRefs: { maxPerSymbol: 0 },
        order: 'tests-first',
      }),
      '.bowi.json',
    );
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      ...DEFAULT_CONFIG,
      base: 'develop',
      generated: ['src/graphql/generated/**'],
      layers: { schema: ['db/migrations/**'] },
      grouping: { ...DEFAULT_CONFIG.grouping, edgeThreshold: 0.6 },
      outsideRefs: { maxPerSymbol: 0 },
      order: 'tests-first',
    });
  });

  it('warns about unknown keys and layers, and keeps AI settings', () => {
    const { config, warnings } = parseConfig(
      JSON.stringify({
        colour: 'red',
        grouping: { extra: 1 },
        layers: { persistence: ['x/**'] },
        ai: { enabled: true, provider: 'anthropic' },
      }),
      '.bowi.json',
    );
    expect(warnings).toEqual([
      '.bowi.json: unknown setting "colour" was ignored',
      '.bowi.json: unknown setting "grouping.extra" was ignored',
      '.bowi.json: unknown layer "persistence" in "layers" was ignored',
    ]);
    expect(config.layers).toEqual({});
    expect(config.ai).toEqual({ ...DEFAULT_CONFIG.ai, enabled: true, provider: 'anthropic' });
  });

  it('reads the AI model, effort, concurrency and timeout, and rejects unknown levels', () => {
    const { config } = parseConfig(
      JSON.stringify({
        ai: { model: 'sonnet', effort: 'low', concurrency: 5, timeoutSeconds: 60 },
      }),
      '.bowi.json',
    );
    expect(config.ai).toEqual({
      enabled: false,
      provider: 'claude-code',
      model: 'sonnet',
      effort: 'low',
      concurrency: 5,
      timeoutSeconds: 60,
    });
    expect(() => parseConfig('{"ai":{"effort":"extreme"}}', '.bowi.json')).toThrow(
      /\.bowi\.json has invalid settings: ai\.effort: /,
    );
  });

  it('rejects wrong values and invalid JSON with a usage error naming the key', () => {
    const bad = () => parseConfig('{"grouping":{"edgeThreshold":2},"order":"random"}', 'my.json');
    expect(bad).toThrow(UsageError);
    expect(bad).toThrow(/my\.json has invalid settings: grouping\.edgeThreshold: .*; order: /);
    expect(() => parseConfig('{oops', '.bowi.json')).toThrow(/\.bowi\.json is not valid JSON/);
  });
});
