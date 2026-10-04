/**
 * Which bound references apply to a card in a scope (Studio's
 * `resolveStoryReferences`, contracts exchange.ts), kept free of zod so the
 * workbench's browser bundle can use the same rule.
 * @module dsh-film/screenwriter/contracts/references
 */

import type { StoryBinding, StoryMetadata } from './types.js';

export interface StoryResolvedReferences {
  purpose: string;
  source: 'document' | 'scene' | 'disabled';
  inherited: boolean;
  bindings: StoryBinding[];
}

/** A scene overrides only the same purpose; scene costume never evicts document appearance. */
export function resolveStoryReferences(metadata: StoryMetadata, options: {
  target: StoryBinding['target']; sceneId?: string; purpose?: string;
}): StoryResolvedReferences[] {
  const matches = (target: StoryBinding['target']) => target.id === options.target.id && target.kind === options.target.kind;
  const bindings = metadata.bindings.filter((binding) => matches(binding.target));
  const overrides = metadata.referenceOverrides.filter((override) => matches(override.target) && override.scope.sceneId === options.sceneId);
  const purposes = options.purpose ? [options.purpose] : [...new Set([...bindings.map((binding) => binding.purpose), ...overrides.map((override) => override.purpose)])];
  return purposes.map((purpose) => {
    const override = overrides.find((item) => item.purpose === purpose);
    if (override?.mode === 'disabled') return { purpose, source: 'disabled' as const, inherited: false, bindings: [] };
    const scene = bindings.filter((binding) => binding.purpose === purpose && binding.scope.kind === 'scene' && binding.scope.sceneId === options.sceneId);
    if (scene.length || override?.mode === 'replace') return { purpose, source: 'scene' as const, inherited: false, bindings: scene };
    return { purpose, source: 'document' as const, inherited: !!options.sceneId, bindings: bindings.filter((binding) => binding.purpose === purpose && binding.scope.kind === 'document') };
  });
}
