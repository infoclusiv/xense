import { describe, expect, it, vi } from 'vitest';
import { makeAnalysisPrompts, makeSynthesisPrompt } from '../lib/ai/analysis';
import { buildInfographic } from '../lib/ai/infographic';
import { nativeRequest } from '../lib/ai/native';
import { analyzeCollection } from '../lib/ai/run-analysis';
import { DEFAULT_SETTINGS } from '../lib/defaults';
import { computeRunStats, createProgress } from '../lib/runs';
import type { NormalizedPost, RunData } from '../lib/types';

vi.mock('../lib/ai/native');

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

function collection(posts: NormalizedPost[]): RunData {
  const settings = DEFAULT_SETTINGS;
  const start = '2026-11-13T05:00:00.000Z';
  const end = '2026-11-14T05:00:00.000Z';
  return {
    posts,
    stats: computeRunStats(posts, settings.timezone),
    run: {
      id: 'run-1', createdAt: start, updatedAt: end, status: 'completed',
      config: {
        ...settings, listId: '123', listName: 'Tecnología',
        range: { start, end, timezone: settings.timezone, expression: 'ayer', label: 'Ayer', partial: false, rolling: false },
      },
      windows: [], currentWindowIndex: 0, captured: posts.length,
      progress: createProgress(), errors: [], diagnostics: [],
    },
  };
}

const answer = {
  title: 'Nuevas herramientas',
  takeaway: 'Las publicaciones describen un nuevo conjunto de herramientas.',
  findings: [{ title: 'Una nueva opción', detail: 'Un autor anuncia el lanzamiento.', postIds: ['1', '404', ' 1 '] }],
};

describe('lotes de análisis IA', () => {
  it('deduplica por ID y preserva enlaces', () => {
    const result = makeAnalysisPrompts([post('1'), post('1'), post('2')], 'themes');
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.prompts.join('\n')).toContain('https://x.com/ejemplo/status/2');
    expect(result.prompts.join('\n').match(/"id":"1"/g)).toHaveLength(1);
  });

  it('exige instrucciones al usar análisis personalizado', () => {
    expect(() => makeAnalysisPrompts([post('1')], 'custom')).toThrow();
    expect(makeAnalysisPrompts([post('1')], 'custom', 'Busca novedades').prompts[0])
      .toContain('Busca novedades');
  });

  it('incluye toda la recolección en más de ocho lotes y conserva los textos largos', () => {
    const posts = Array.from({ length: 120 }, (_, i) => post(String(i), 'X'.repeat(4000) + 'FINAL-' + i));
    const result = makeAnalysisPrompts(posts, 'trends');
    expect(result.prompts.length).toBeGreaterThan(8);
    expect(result.processed).toBe(120);
    expect(result.skipped).toBe(0);
    expect(result.prompts.at(-1)).toContain('FINAL-119');
    expect(result.prompts.every(prompt => prompt.length < 75000)).toBe(true);
  });

  it('limita el tamaño de la síntesis de ocho lotes', () => {
    const prompt = makeSynthesisPrompt(Array.from({ length: 8 }, () => 'A'.repeat(40000)), 'themes');
    expect(prompt.length).toBeLessThan(75000);
  });
});

describe('infografía generada', () => {
  it('conserva únicamente referencias a posts recolectados y calcula sus métricas', () => {
    const data = collection([{ ...post('1'), permalink: 'javascript:alert(1)' }]);
    const report = buildInfographic('```json\n' + JSON.stringify(answer) + '\n```', data);
    expect(report.findings[0]?.sources).toMatchObject([{ id: '1', handle: 'ejemplo', url: 'https://x.com/ejemplo/status/1' }]);
    expect(report.collection).toMatchObject({ total: 1, authors: 1, activeDays: 1, byType: { original: 1 } });
    expect(report.collection.activity[0]?.count).toBe(1);
    expect(report.collection.period).toContain('2026');
    expect(() => buildInfographic(JSON.stringify(answer), collection([post('2')]))).toThrow('sin respaldo');
  });

  it('consolida todos los lotes y repite una salida inválida con las instrucciones propias', async () => {
    const responses = vi.mocked(nativeRequest);
    responses.mockReset();
    const posts = Array.from({ length: 120 }, (_, i) => post(String(i + 1), 'A'.repeat(4000)));
    let finalCalls = 0;
    responses.mockImplementation(async (request) => {
      const prompt = String(request.prompt);
      expect(prompt).toContain('Busca herramientas');
      if (!prompt.includes('estructura exacta')) return { ok: true, text: 'Hallazgo con post 1.' };
      finalCalls += 1;
      return { ok: true, text: finalCalls === 1 ? 'Texto libre' : JSON.stringify(answer) };
    });

    const analysis = await analyzeCollection(collection(posts), {
      provider: 'chatgpt_codex', model: '', kind: 'custom', instruction: 'Busca herramientas',
      onProgress: () => {}, signal: new AbortController().signal,
    });

    expect(analysis.processedPosts).toBe(120);
    expect(analysis.chunkCount).toBeGreaterThan(8);
    expect(responses.mock.calls.length).toBeGreaterThan(analysis.chunkCount + 2);
    expect(finalCalls).toBe(2);
    expect(analysis.infographic?.title).toBe(answer.title);
  });
});
