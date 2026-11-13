import { describe, expect, it } from 'vitest';
import { makeAnalysisPrompts, makeSynthesisPrompt } from '../lib/ai/analysis';
import type { NormalizedPost } from '../lib/types';

function post(id: string, content = 'Resumen de inteligencia artificial'): NormalizedPost {
  return {
    id, createdAt: '2026-11-13T12:00:00.000Z',
    author: { handle: 'ejemplo', name: 'Ejemplo' },
    text: content, type: 'original',
    isReply: false, isRepost: false, isQuote: false,
    urls: [], hashtags: [], mentions: [], media: [],
    metrics: { likes: 1, reposts: 0, replies: 0, quotes: 0, views: 10, bookmarks: 0 },
    permalink: 'https://x.com/ejemplo/status/' + id,
    collectedAt: '2026-11-13T12:30:00.000Z',
  };
}

describe('lotes de análisis IA', () => {
  it('deduplica por ID y preserva enlaces', () => {
    const result = makeAnalysisPrompts([post('1'), post('1'), post('2')], 'themes');
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.prompts.join('\n')).toContain('https://x.com/ejemplo/status/2');
    expect(result.prompts.join('\n').match(/--- POST 1 ---/g)).toHaveLength(1);
  });

  it('exige instrucciones al usar análisis personalizado', () => {
    expect(() => makeAnalysisPrompts([post('1')], 'custom')).toThrow();
    expect(makeAnalysisPrompts([post('1')], 'custom', 'Busca novedades').prompts[0])
      .toContain('Busca novedades');
  });

  it('limita lotes e informa tweets omitidos', () => {
    const posts = Array.from({ length: 300 }, (_, i) => post(String(i), 'X'.repeat(4000)));
    const result = makeAnalysisPrompts(posts, 'trends');
    expect(result.prompts.length).toBeLessThanOrEqual(8);
    expect(result.processed + result.skipped).toBe(300);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.prompts.every(prompt => prompt.length <= 11500)).toBe(true);
  });

  it('limita el tamaño de la síntesis de ocho lotes', () => {
    const prompt = makeSynthesisPrompt(Array.from({ length: 8 }, () => 'A'.repeat(40000)), 'themes');
    expect(prompt.length).toBeLessThan(75000);
  });
});
