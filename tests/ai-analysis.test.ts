import { describe, expect, it, vi } from 'vitest';
import { makeAnalysisPrompts, makeSynthesisPrompt } from '../lib/ai/analysis';
import { buildInfographic } from '../lib/ai/infographic';
import { nativeRequest } from '../lib/ai/native';
import { analyzeCollection } from '../lib/ai/run-analysis';
import { DEFAULT_SETTINGS } from '../lib/defaults';
import { computeRunStats, createProgress } from '../lib/runs';
import type { NormalizedPost, RunData } from '../lib/types';
import { getPostFromHistory, getSavedTranscript, saveTranscript } from '../lib/db';
import { readXDetail } from '../lib/x/detail';
import { parseTranscription } from '../lib/ai/transcript';

vi.mock('../lib/ai/native');
vi.mock('../lib/db', () => ({
  getPostFromHistory: vi.fn(),
  getSavedTranscript: vi.fn(async () => undefined),
  saveTranscript: vi.fn(async () => undefined),
}));
vi.mock('../lib/x/detail', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/x/detail')>(),
  readXDetail: vi.fn(),
}));

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
  it('recupera una sola pista de YouTube por video y cita el segundo de la transcripción', async () => {
    const replies = vi.mocked(nativeRequest);
    replies.mockReset().mockImplementation(async request => {
      if (request.type === 'YOUTUBE_TRANSCRIPT') {
        expect(request).toMatchObject({ videoId: 'abcDEF123_4', language: 'es' });
        return { ok: true, transcription: {
          status: 'ready', origin: 'youtube-manual', language: 'es',
          text: 'WEBVTT\n\n00:01:37.250 --> 00:01:39.000\nEl sistema procesa doce archivos.\n',
        } };
      }
      expect(String(request.prompt)).toContain('subtítulos del canal de YouTube · es');
      expect(String(request.prompt)).toContain('"inicio":97.25,"fin":99,"texto":"El sistema procesa doce archivos."');
      return { ok: true, text: JSON.stringify({ ...answer, findings: [{
        ...answer.findings[0], detail: 'El sistema procesa doce archivos.', sourceIds: ['1', 'recurso-1'],
      }] }) };
    });
    const result = await analyzeCollection(collection([
      { ...post('1'), lang: 'es', urls: ['https://youtu.be/abcDEF123_4?t=10'] },
      { ...post('2'), urls: ['https://www.youtube.com/shorts/abcDEF123_4'] },
    ]), {
      provider: 'chatgpt_codex', model: '', kind: 'themes', instruction: '', enrich: true,
      onProgress: () => {}, signal: new AbortController().signal,
    });
    expect(replies.mock.calls.map(([request]) => request.type)).toEqual(['YOUTUBE_TRANSCRIPT', 'ANALYZE']);
    expect(saveTranscript).toHaveBeenCalledWith('run-1', 'https://www.youtube.com/watch?v=abcDEF123_4',
      expect.objectContaining({ status: 'ready', origin: 'youtube-manual' }));
    expect(result.result).toContain('[1:37](<https://www.youtube.com/watch?v=abcDEF123_4&t=97s>)');
  });

  it('reutiliza el audio transcrito con WhisperX y muestra separadamente un fallo de audio', async () => {
    const asset = 'https://video.twimg.com/clip.mp4';
    const saved = parseTranscription({
      status: 'ready', origin: 'whisperx', seconds: 489, complete: true,
      text: '1\n00:00:46,000 --> 00:00:48,300\nLa medición llegó a 37 por ciento.\n',
    });
    vi.mocked(getSavedTranscript).mockResolvedValueOnce(saved);
    const replies = vi.mocked(nativeRequest);
    replies.mockReset().mockImplementation(async request => {
      if (request.type === 'ANALYZE_MEDIA') {
        if (request.originalUrl === asset) {
          expect(request).toMatchObject({ url: 'https://video.twimg.com/small.mp4', skipTranscription: true });
          return { ok: true, media: { frames: [0, 12], description: 'Captura de una gráfica.' } };
        }
        return { ok: true, media: { frames: [0], transcription: { status: 'failed' } } };
      }
      expect(String(request.prompt)).toContain('transcrito con WhisperX · audio completo (8:09)');
      expect(String(request.prompt)).toContain('La medición llegó a 37 por ciento.');
      return { ok: true, text: JSON.stringify({ ...answer, findings: [{
        ...answer.findings[0], sourceIds: ['1', 'recurso-1'],
      }] }) };
    });
    const result = await analyzeCollection(collection([{
      ...post('1'), media: [
        { type: 'video', url: asset, analysisUrl: 'https://video.twimg.com/small.mp4' },
        { type: 'video', url: 'https://video.twimg.com/failed.mp4' },
      ],
    }]), {
      provider: 'chatgpt_codex', model: '', kind: 'themes', instruction: '', enrich: true,
      onProgress: () => {}, signal: new AbortController().signal,
    });
    expect(result.result).toContain('[0:46](<https://video.twimg.com/clip.mp4#t=46>)');
    expect(result.infographic?.transcriptNotes).toEqual([
      { url: 'https://video.twimg.com/failed.mp4', label: 'Video o GIF', detail: 'error de transcripción' },
    ]);
  });

  it('vuelve a transcribir una muestra antigua y cita una frase de un tramo posterior con el tiempo original', async () => {
    const asset = 'https://video.twimg.com/full.mp4';
    vi.mocked(getSavedTranscript).mockResolvedValueOnce(parseTranscription({
      status: 'ready', origin: 'whisperx', seconds: 120,
      text: '1\n00:01:00,000 --> 00:01:02,000\nUna muestra antigua.\n',
    }));
    const replies = vi.mocked(nativeRequest);
    replies.mockReset().mockImplementation(async request => {
      if (request.type === 'ANALYZE_MEDIA') {
        expect(request.skipTranscription).toBe(false);
        return { ok: true, media: { frames: [0, 60, 119], transcription: {
          status: 'ready', origin: 'whisperx', seconds: 520, complete: true,
          parts: [
            { offset: 0, text: '1\n00:00:15,000 --> 00:00:17,000\nIntroducción.\n' },
            { offset: 300.032, text: '1\n00:00:45,500 --> 00:00:47,125\nEl resultado aparece al final.\n' },
          ],
        } } };
      }
      expect(String(request.prompt)).toContain('"inicio":345.532,"fin":347.157,"texto":"El resultado aparece al final."');
      return { ok: true, text: JSON.stringify({ ...answer, findings: [{
        ...answer.findings[0], sourceIds: ['1', 'recurso-1'],
      }] }) };
    });
    const result = await analyzeCollection(collection([{
      ...post('1'), media: [{ type: 'video', url: asset }],
    }]), {
      provider: 'chatgpt_codex', model: '', kind: 'themes', instruction: '', enrich: true,
      onProgress: () => {}, signal: new AbortController().signal,
    });
    expect(result.result).toContain('[5:45](<https://video.twimg.com/full.mp4#t=345.532>)');
    expect(saveTranscript).toHaveBeenCalledWith('run-1', asset, expect.objectContaining({ complete: true, seconds: 520 }));
  });

  it('busca los adjuntos aunque ya tenga el texto y atribuye el dato de un GIF al segundo y artículo correctos', async () => {
    const url = 'https://x.com/i/article/999';
    const gif = 'https://video.twimg.com/tweet_video/result.gif';
    vi.mocked(readXDetail).mockResolvedValueOnce({ article: {
      url, title: 'Informe de seguimiento', text: 'El resultado aparece a mitad de la animación.',
      blocksFromDetail: true,
      blocks: [
        { kind: 'heading', text: 'Medición final' },
        { kind: 'text', text: 'El resultado aparece a mitad de la animación.' },
        { kind: 'media', media: { type: 'gif', url: gif }, caption: 'Figura 2. La medición.' },
      ],
    } });
    const responses = vi.mocked(nativeRequest);
    responses.mockReset().mockImplementation(async request => {
      if (request.type === 'ANALYZE_MEDIA') {
        expect(request).toMatchObject({ kind: 'gif', url: gif, publicArticle: true });
        return { ok: true, media: {
          frames: [0, 0.5, 1, 1.5, 1.9],
          moments: [{ seconds: 1, text: 'El indicador cambia a 37 %.' }],
          transcription: { status: 'no-audio' },
        } };
      }
      const prompt = String(request.prompt);
      expect(prompt).toContain('"ubicaciónEnArtículo":{"id":"recurso-1","sección":"Medición final"');
      expect(prompt).toContain('"pieOTextoDelEnlace":"Figura 2. La medición."');
      expect(prompt).toContain('"fotogramas":[{"segundo":1,"observación":"El indicador cambia a 37 %."}]');
      expect(prompt).toContain('sin pista de audio');
      return { ok: true, text: JSON.stringify({ ...answer, findings: [{
        title: 'Medición final', detail: 'El GIF muestra 37 % en el segundo 1.', sourceIds: ['1', 'recurso-1', 'recurso-2'],
      }] }) };
    });
    const input: NormalizedPost = {
      ...post('1', 'Vean la medición.'), article: { url, title: 'Informe de seguimiento', text: 'Texto ya recolectado.' },
    };
    const report = await analyzeCollection(collection([input]), {
      provider: 'chatgpt_codex', model: '', kind: 'themes', instruction: '', enrich: true,
      onProgress: () => {}, signal: new AbortController().signal,
    });
    expect(readXDetail).toHaveBeenCalledWith('article', '999', expect.any(AbortSignal));
    expect(responses.mock.calls.map(([request]) => request.type)).toEqual(['ANALYZE_MEDIA', 'ANALYZE']);
    expect(report.infographic?.findings[0]?.sources.map(source => source.url)).toEqual([input.permalink, url, gif]);
    expect(report.infographic?.findings[0]?.sources[2]?.moments).toEqual([
      { seconds: 1, text: 'El indicador cambia a 37 %.' },
    ]);
    expect(report.infographic?.findings[0]?.detail).toContain('segundo 1');
  });

  it('atribuye una objeción al post y cita el contexto externo al rango sin contar esas fuentes como publicaciones', async () => {
    const responses = vi.mocked(nativeRequest);
    responses.mockReset();
    vi.mocked(getPostFromHistory).mockResolvedValueOnce({
      ...post('10', 'La cifra anunciada fue 5 %.'),
      author: { handle: 'origen', name: 'Origen' },
      createdAt: '2026-11-10T10:00:00.000Z',
    });
    const quoted = {
      id: '9',
      handle: 'autora_grafico',
      text: 'El gráfico muestra la cifra corregida.',
      media: [{
        type: 'photo' as const,
        url: 'https://pbs.twimg.com/media/grafico.png',
        alt: 'Gráfico de variación anual.',
      }],
      urls: ['https://example.com/estudio'],
    };
    const objection: NormalizedPost = {
      ...post('1', 'Esa cifra está mal.'),
      isReply: true, isQuote: true, type: 'reply', replyToPostId: '10', conversationId: '10',
      quotedPostId: quoted.id, quoted,
    };
    const other = { ...post('2'), type: 'quote' as const, isQuote: true, quoted };
    responses.mockImplementation(async request => {
      if (request.type === 'ANALYZE_MEDIA') {
        return { ok: true, media: { frames: [], description: 'La etiqueta visible dice 3 %.' } };
      }
      if (request.type === 'READ_PUBLIC_PAGE') {
        return { ok: true, page: { html: 'Estimación corregida al 3 %.', url: 'https://example.com/estudio', type: 'text/plain' } };
      }
      const prompt = String(request.prompt);
      expect(prompt).toContain('responde a');
      expect(prompt).toContain('La cifra anunciada fue 5 %.');
      expect(prompt).toContain('autora_grafico');
      expect(prompt).toContain('imagen analizada con visión');
      expect(prompt).toContain('La etiqueta visible dice 3 %.');
      expect(prompt).toContain('Gráfico de variación anual.');
      expect(prompt).toContain('Estimación corregida al 3 %.');
      return {
        ok: true,
        text: JSON.stringify({ ...answer, findings: [{
          ...answer.findings[0], sourceIds: ['1', '10', '9', 'recurso-1'],
        }] }),
      };
    });

    const report = await analyzeCollection(collection([objection, other]), {
      provider: 'chatgpt_codex', model: '', kind: 'themes', instruction: '', enrich: true,
      onProgress: () => {}, signal: new AbortController().signal,
    });
    expect(responses.mock.calls.map(([request]) => request.type))
      .toEqual(['ANALYZE_MEDIA', 'READ_PUBLIC_PAGE', 'ANALYZE']);
    expect(report.infographic?.collection.total).toBe(2);
    expect(report.contextCoverage).toEqual({ complete: 4, partial: 0, unavailable: 0, skipped: 0 });
    expect(report.infographic?.findings[0]?.sources).toEqual([
      expect.objectContaining({ id: '1' }),
      expect.objectContaining({ id: '10', url: 'https://x.com/i/status/10' }),
      expect.objectContaining({ id: '9', handle: 'autora_grafico' }),
      expect.objectContaining({ url: quoted.media[0]?.url, method: expect.stringContaining('visión') }),
    ]);
  });

  it('señala una vista previa y un video sin lectura cuando la recuperación está desactivada', async () => {
    const responses = vi.mocked(nativeRequest);
    responses.mockReset();
    responses.mockImplementation(async request => {
      const prompt = String(request.prompt);
      expect(prompt).toContain('vista previa');
      expect(prompt).toContain('sin recuperar');
      expect(prompt).not.toContain('fotogramas en');
      return { ok: true, text: JSON.stringify(answer) };
    });
    const input = {
      ...post('1'),
      urls: ['https://example.com/nota'],
      linkPreview: { url: 'https://example.com/nota', title: 'Resumen de la nota' },
      media: [{ type: 'video' as const, url: 'https://video.twimg.com/clip.mp4' }],
    };
    const report = await analyzeCollection(collection([input]), {
      provider: 'chatgpt_codex', model: '', kind: 'themes', instruction: '', enrich: false,
      onProgress: () => {}, signal: new AbortController().signal,
    });
    expect(responses.mock.calls.map(([request]) => request.type)).toEqual(['ANALYZE']);
    expect(report.contextCoverage).toEqual({ complete: 0, partial: 1, unavailable: 0, skipped: 1 });
  });

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
