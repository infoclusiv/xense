import { describe, expect, it } from 'vitest';
import {
  buildAiDigest,
  buildCsvExport,
  buildJsonExport,
  buildMarkdownExport,
  buildNdjsonExport,
  exportBaseName,
  slugify,
} from '../lib/export/exporters';
import { computeRunStats, createProgress } from '../lib/runs';
import type { NormalizedPost, RunData, RunRecord } from '../lib/types';

const POST: NormalizedPost = {
  id: '123',
  createdAt: '2026-11-12T14:30:00.000Z',
  author: { handle: 'ana', name: 'Ana Pérez', verified: true },
  text: 'Hola, "mundo"\nsegunda línea',
  lang: 'es',
  type: 'original',
  isReply: false,
  isRepost: false,
  isQuote: false,
  urls: ['https://example.com/nota'],
  hashtags: ['xense'],
  mentions: ['bob'],
  media: [],
  metrics: {
    likes: 12,
    reposts: 3,
    replies: 1,
    quotes: 0,
    views: 1000,
    bookmarks: 2,
  },
  permalink: 'https://x.com/ana/status/123',
  collectedAt: '2026-11-13T10:00:00.000Z',
};

function makeRun(): RunRecord {
  const timestamp = '2026-11-13T10:00:00.000Z';
  return {
    id: 'run-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    status: 'completed',
    config: {
      listId: '42',
      listName: 'Tecnología & IA',
      range: {
        start: '2026-11-12T05:00:00.000Z',
        end: '2026-11-13T05:00:00.000Z',
        timezone: 'America/Bogota',
        expression: 'ayer',
        label: 'Ayer',
        partial: false,
        rolling: false,
      },
      mode: 'auto',
      includeReplies: true,
      includeReposts: true,
      includeQuotes: true,
      maxPosts: 5000,
      minDelayMs: 2200,
      maxDelayMs: 4200,
      idleScrolls: 8,
      maxScrolls: 150,
    },
    windows: [
      {
        index: 0,
        start: '2026-11-12T05:00:00.000Z',
        end: '2026-11-13T05:00:00.000Z',
        mode: 'search',
        status: 'done',
        triedTimeline: false,
        captured: 1,
      },
    ],
    currentWindowIndex: 0,
    captured: 1,
    progress: createProgress(),
    errors: [],
    diagnostics: [],
  };
}

function makeData(): RunData {
  const run = makeRun();
  return {
    run,
    posts: [POST],
    stats: computeRunStats([POST], run.config.range.timezone),
  };
}

describe('slugify y nombres de archivo', () => {
  it('normaliza acentos y caracteres especiales', () => {
    expect(slugify('Tecnología & IA')).toBe('tecnologia-ia');
    expect(slugify('   ')).toBe('lista');
  });

  it('genera el nombre base con la fecha local de inicio', () => {
    expect(exportBaseName(makeData())).toBe('xense-tecnologia-ia-2026-11-12');
  });
});

describe('exportadores', () => {
  it('genera JSON con metadatos, stats y posts', () => {
    const parsed = JSON.parse(buildJsonExport(makeData()));
    expect(parsed.app).toBe('Xense');
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.list).toEqual({ id: '42', name: 'Tecnología & IA' });
    expect(parsed.range.label).toBe('Ayer');
    expect(parsed.stats.total).toBe(1);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].id).toBe('123');
    expect(parsed.run.origin).toBe('manual');
    expect(parsed.run.continuationOfRunId).toBeNull();
  });

  it('marca las recolecciones de novedades en JSON, Markdown y digest', () => {
    const data = makeData();
    data.run.config.origin = 'continuation';
    data.run.config.continuationOfRunId = 'run-0';

    const parsed = JSON.parse(buildJsonExport(data));
    expect(parsed.run.origin).toBe('continuation');
    expect(parsed.run.continuationOfRunId).toBe('run-0');
    expect(buildMarkdownExport(data)).toContain('- **Tipo:** Novedades desde el último análisis');
    expect(buildMarkdownExport(data)).toContain('- **Recolección anterior:** run-0');
    expect(buildAiDigest(data)).toContain('Tipo: Novedades desde el último análisis.');
  });

  it('genera CSV con BOM, cabeceras y escape correcto', () => {
    const csv = buildCsvExport(makeData());
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('id,created_at_utc,created_at_local');
    expect(csv).toContain('2026-11-12 09:30:00');
    expect(csv).toContain('"Hola, ""mundo""\nsegunda línea"');
    expect(csv).toContain('https://x.com/ana/status/123');
  });

  it('genera Markdown con encabezado, cita del texto y enlace', () => {
    const markdown = buildMarkdownExport(makeData());
    expect(markdown).toContain('# Xense — Lista “Tecnología & IA”');
    expect(markdown).toContain('## 1. @ana');
    expect(markdown).toContain('> Hola, "mundo"');
    expect(markdown).toContain('> segunda línea');
    expect(markdown).toContain('[Ver post](https://x.com/ana/status/123)');
  });

  it('genera NDJSON con una línea por post', () => {
    const ndjson = buildNdjsonExport(makeData());
    const lines = ndjson.split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe('123');
    expect(parsed.runId).toBe('run-1');
    expect(parsed.runName).toBe('Tecnología & IA');
  });

  it('genera un digest para IA con contexto y contenido', () => {
    const digest = buildAiDigest(makeData());
    expect(digest).toContain('# Contexto para análisis');
    expect(digest).toContain('Lista de X: “Tecnología & IA”');
    expect(digest).toContain('Total: 1 posts de 1 autores.');
    expect(digest).toContain('[1]');
    expect(digest).toContain('@ana (Ana Pérez)');
    expect(digest).toContain('URL: https://x.com/ana/status/123');
  });
});
