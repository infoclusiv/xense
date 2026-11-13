import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createProgress } from '../lib/runs';
import {
  applyRunToTracking,
  buildContinuationRange,
  buildTrackingFromRuns,
  computeCoverageEnd,
  isWindowCovered,
  nextCursorForRun,
  pickNewestPost,
  toLastCapturedPost,
} from '../lib/tracking';
import type {
  LastCapturedPost,
  ListTracking,
  NormalizedPost,
  RunRecord,
  RunWindow,
  WindowStatus,
} from '../lib/types';

const START = '2026-11-10T05:00:00.000Z';
const MID = '2026-11-11T05:00:00.000Z';
const END = '2026-11-12T05:00:00.000Z';

function makeWindow(
  index: number,
  start: string,
  end: string,
  status: WindowStatus = 'done',
  reason?: string,
): RunWindow {
  return {
    index,
    start,
    end,
    mode: 'search',
    status,
    triedTimeline: false,
    captured: status === 'done' ? 5 : 0,
    reason,
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const timestamp = '2026-11-12T10:00:00.000Z';
  return {
    id: 'run-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    status: 'completed',
    config: {
      listId: '42',
      listName: 'Tecnología',
      range: {
        start: START,
        end: END,
        timezone: 'America/Bogota',
        expression: 'rango',
        label: 'Rango personalizado',
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
    windows: [makeWindow(0, START, MID), makeWindow(1, MID, END)],
    currentWindowIndex: 1,
    captured: 10,
    progress: createProgress(),
    errors: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeTracking(overrides: Partial<ListTracking> = {}): ListTracking {
  return {
    listId: '42',
    listName: 'Tecnología',
    cursor: MID,
    lastRunId: 'run-old',
    lastRunAt: '2026-11-11T10:00:00.000Z',
    lastFinishedAt: '2026-11-11T11:00:00.000Z',
    lastStatus: 'completed',
    lastRangeStart: START,
    lastRangeEnd: MID,
    lastRangeLabel: 'Ayer',
    lastCaptured: 8,
    lastPost: null,
    updatedAt: '2026-11-11T11:00:00.000Z',
    ...overrides,
  };
}

function makePost(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  return {
    id: 'post-1',
    createdAt: MID,
    author: { handle: 'ana', name: 'Ana' },
    text: 'Un post de prueba',
    type: 'original',
    isReply: false,
    isRepost: false,
    isQuote: false,
    urls: [],
    hashtags: [],
    mentions: [],
    media: [],
    metrics: {
      likes: 0,
      reposts: 0,
      replies: 0,
      quotes: 0,
      views: 0,
      bookmarks: 0,
    },
    permalink: 'https://x.com/ana/status/1',
    collectedAt: END,
    ...overrides,
  };
}

describe('cobertura de ventanas', () => {
  it('considera completas las ventanas done sin motivos incompletos', () => {
    expect(isWindowCovered(makeWindow(0, START, MID))).toBe(true);
    expect(isWindowCovered(makeWindow(0, START, MID, 'done', 'exhausted'))).toBe(true);
    expect(isWindowCovered(makeWindow(0, START, MID, 'done', 'no_results'))).toBe(true);
    expect(isWindowCovered(makeWindow(0, START, MID, 'done', 'date_boundary'))).toBe(true);
  });

  it('considera incompletos los límites, la cancelación y las ventanas omitidas', () => {
    expect(isWindowCovered(makeWindow(0, START, MID, 'done', 'max_scrolls'))).toBe(false);
    expect(isWindowCovered(makeWindow(0, START, MID, 'done', 'max_posts'))).toBe(false);
    expect(isWindowCovered(makeWindow(0, START, MID, 'done', 'cancelled'))).toBe(false);
    expect(isWindowCovered(makeWindow(0, START, MID, 'done', 'skipped_limit'))).toBe(false);
    expect(isWindowCovered(makeWindow(0, START, MID, 'failed', 'rate_limited'))).toBe(false);
    expect(isWindowCovered(makeWindow(0, START, MID, 'active'))).toBe(false);
  });

  it('avanza hasta el final del tramo contiguo completado', () => {
    expect(computeCoverageEnd(makeRun())).toBe(END);
  });

  it('se detiene en el primer tramo incompleto', () => {
    const run = makeRun({
      windows: [
        makeWindow(0, START, MID),
        makeWindow(1, MID, END, 'done', 'max_posts'),
      ],
    });
    expect(computeCoverageEnd(run)).toBe(MID);
  });

  it('no avanza nada si el primer tramo falló', () => {
    const run = makeRun({
      windows: [
        makeWindow(0, START, MID, 'failed', 'page_error'),
        makeWindow(1, MID, END),
      ],
    });
    expect(computeCoverageEnd(run)).toBe(START);
  });

  it('trata una ventana activa como incompleta', () => {
    const run = makeRun({
      windows: [makeWindow(0, START, MID), makeWindow(1, MID, END, 'active')],
    });
    expect(computeCoverageEnd(run)).toBe(MID);
  });
});

describe('avance del cursor', () => {
  it('usa la cobertura cuando no hay seguimiento previo', () => {
    expect(nextCursorForRun(null, makeRun())).toBe(END);
  });

  it('avanza cuando el run empieza en el cursor o antes', () => {
    expect(nextCursorForRun(makeTracking(), makeRun())).toBe(END);
  });

  it('avanza si el run empieza exactamente en el cursor', () => {
    const run = makeRun({
      config: {
        ...makeRun().config,
        range: { ...makeRun().config.range, start: MID },
      },
      windows: [makeWindow(0, MID, END)],
    });
    expect(nextCursorForRun(makeTracking(), run)).toBe(END);
  });

  it('nunca retrocede', () => {
    const run = makeRun({
      windows: [makeWindow(0, START, MID)],
      config: {
        ...makeRun().config,
        range: { ...makeRun().config.range, end: MID },
      },
    });
    expect(nextCursorForRun(makeTracking({ cursor: END }), run)).toBe(END);
  });

  it('no avanza con un rango que empieza después del cursor', () => {
    const later = '2026-11-11T12:00:00.000Z';
    const run = makeRun({
      config: {
        ...makeRun().config,
        range: { ...makeRun().config.range, start: later },
      },
      windows: [makeWindow(0, later, END)],
    });
    expect(nextCursorForRun(makeTracking(), run)).toBe(MID);
  });

  it('no avanza si la cobertura no supera el cursor', () => {
    const run = makeRun({ windows: [makeWindow(0, START, MID)] });
    expect(nextCursorForRun(makeTracking(), run)).toBe(MID);
  });

  it('conserva el cursor si la fecha guardada no es válida', () => {
    expect(nextCursorForRun(makeTracking({ cursor: 'no-es-fecha' }), makeRun())).toBe(
      'no-es-fecha',
    );
  });
});

describe('metadatos del seguimiento', () => {
  it('crea el seguimiento desde un run sin historial', () => {
    const post = makePost();
    const run = makeRun({ lastCapturedPost: toLastCapturedPost(post) });
    const tracking = applyRunToTracking(null, run);
    expect(tracking.cursor).toBe(END);
    expect(tracking.lastRunId).toBe(run.id);
    expect(tracking.lastRunAt).toBe(run.createdAt);
    expect(tracking.lastStatus).toBe('completed');
    expect(tracking.lastCaptured).toBe(10);
    expect(tracking.lastPost?.id).toBe(post.id);
  });

  it('conserva los metadatos del run más reciente y el último post más nuevo', () => {
    const oldPost: LastCapturedPost = {
      id: 'old',
      createdAt: START,
      authorHandle: 'viejo',
      permalink: 'https://x.com/viejo/status/1',
      text: 'Viejo',
    };
    const newPost: LastCapturedPost = {
      id: 'new',
      createdAt: END,
      authorHandle: 'nuevo',
      permalink: 'https://x.com/nuevo/status/2',
      text: 'Nuevo',
    };
    const existing = makeTracking({ lastPost: oldPost });
    const run = makeRun({
      id: 'run-new',
      createdAt: '2026-11-12T12:00:00.000Z',
      lastCapturedPost: newPost,
    });
    const tracking = applyRunToTracking(existing, run);
    expect(tracking.lastRunId).toBe('run-new');
    expect(tracking.lastPost?.id).toBe('new');
    expect(tracking.cursor).toBe(END);
  });

  it('no reemplaza los metadatos con un run antiguo', () => {
    const existing = makeTracking();
    const oldRun = makeRun({
      id: 'run-ancient',
      createdAt: '2026-11-10T10:00:00.000Z',
      finishedAt: '2026-11-10T11:00:00.000Z',
    });
    const tracking = applyRunToTracking(existing, oldRun);
    expect(tracking.lastRunId).toBe('run-old');
    expect(tracking.lastStatus).toBe('completed');
    expect(tracking.cursor).toBe(END);
  });

  it('elige el post más nuevo entre dos snapshots', () => {
    const older: LastCapturedPost = {
      id: 'a',
      createdAt: START,
      authorHandle: 'a',
      permalink: '',
      text: '',
    };
    const newer: LastCapturedPost = {
      id: 'b',
      createdAt: MID,
      authorHandle: 'b',
      permalink: '',
      text: '',
    };
    expect(pickNewestPost(older, newer)?.id).toBe('b');
    expect(pickNewestPost(newer, older)?.id).toBe('b');
    expect(pickNewestPost(null, newer)?.id).toBe('b');
    expect(pickNewestPost(older, null)?.id).toBe('a');
  });

  it('resume el último post y recorta el texto', () => {
    const longText = `  ${'palabra '.repeat(40)}  `;
    const snapshot = toLastCapturedPost(makePost({ text: longText }));
    expect(snapshot.text.length).toBeLessThanOrEqual(180);
    expect(snapshot.text.startsWith('palabra')).toBe(true);
    expect(snapshot.text).not.toContain('\n');
    expect(snapshot.permalink).toBe('https://x.com/ana/status/1');
  });
});

describe('siembra del seguimiento desde runs antiguos', () => {
  it('devuelve null sin runs finalizados', () => {
    expect(buildTrackingFromRuns([])).toBeNull();
    expect(buildTrackingFromRuns([makeRun({ status: 'running' })])).toBeNull();
  });

  it('devuelve null si ningún run completó cobertura', () => {
    const failed = makeRun({
      windows: [makeWindow(0, START, MID, 'failed', 'login_required')],
    });
    expect(buildTrackingFromRuns([failed])).toBeNull();
  });

  it('toma la mayor cobertura conocida y los metadatos del run más reciente', () => {
    const first = makeRun({
      id: 'run-a',
      createdAt: '2026-11-10T10:00:00.000Z',
      finishedAt: '2026-11-10T11:00:00.000Z',
      windows: [makeWindow(0, START, MID), makeWindow(1, MID, END)],
    });
    const latest = makeRun({
      id: 'run-b',
      createdAt: '2026-11-12T10:00:00.000Z',
      finishedAt: '2026-11-12T11:00:00.000Z',
      captured: 3,
      windows: [makeWindow(0, START, MID, 'failed', 'error')],
      config: {
        ...makeRun().config,
        range: { ...makeRun().config.range, label: 'Rango reciente' },
      },
    });
    const tracking = buildTrackingFromRuns([latest, first]);
    expect(tracking?.cursor).toBe(END);
    expect(tracking?.lastRunId).toBe('run-b');
    expect(tracking?.lastRangeLabel).toBe('Rango reciente');
    expect(tracking?.lastCaptured).toBe(3);
  });

  it('no salta un hueco entre recolecciones antiguas', () => {
    const early = makeRun({
      id: 'run-early',
      createdAt: '2026-11-10T10:00:00.000Z',
      windows: [makeWindow(0, START, MID)],
    });
    const afterGapStart = END;
    const afterGapEnd = '2026-11-13T05:00:00.000Z';
    const late = makeRun({
      id: 'run-late',
      createdAt: '2026-11-13T10:00:00.000Z',
      windows: [makeWindow(0, afterGapStart, afterGapEnd)],
      config: {
        ...makeRun().config,
        range: { ...makeRun().config.range, start: afterGapStart, end: afterGapEnd },
      },
    });
    const tracking = buildTrackingFromRuns([late, early]);
    expect(tracking?.cursor).toBe(MID);
    expect(tracking?.lastRunId).toBe('run-late');
  });

  it('acepta un último post externo y conserva el más nuevo', () => {
    const external: LastCapturedPost = {
      id: 'external',
      createdAt: END,
      authorHandle: 'externa',
      permalink: 'https://x.com/externa/status/9',
      text: 'Post externo',
    };
    const run = makeRun({
      lastCapturedPost: {
        id: 'internal',
        createdAt: START,
        authorHandle: 'interna',
        permalink: 'https://x.com/interna/status/8',
        text: 'Post interno',
      },
    });
    const tracking = buildTrackingFromRuns([run], external);
    expect(tracking?.lastPost?.id).toBe('external');
  });
});

describe('rango de continuación', () => {
  const now = DateTime.fromISO('2026-11-13T10:00:00.000Z', { setZone: true });

  it('construye el rango desde el cursor hasta ahora', () => {
    const range = buildContinuationRange(makeTracking(), 'America/Bogota', now);
    expect(range.start).toBe(MID);
    expect(range.end).toBe(now.toUTC().toISO());
    expect(range.timezone).toBe('America/Bogota');
    expect(range.expression).toBe('novedades');
    expect(range.label).toContain('Novedades desde');
    expect(range.partial).toBe(false);
    expect(range.rolling).toBe(false);
  });

  it('falla si la lista no tiene seguimiento', () => {
    expect(() => buildContinuationRange(null, 'UTC', now)).toThrow(/no tiene un análisis previo/i);
  });

  it('falla si ya estamos al día', () => {
    const tracking = makeTracking({ cursor: now.toUTC().toISO()! });
    expect(() => buildContinuationRange(tracking, 'UTC', now)).toThrow(/Ya estás al día/i);
  });

  it('falla si pasó menos de un minuto', () => {
    const cursor = now.minus({ seconds: 30 }).toUTC().toISO()!;
    expect(() => buildContinuationRange(makeTracking({ cursor }), 'UTC', now)).toThrow(
      /espera un momento/i,
    );
  });

  it('falla y sugiere dividir el periodo si pasan más de 180 días', () => {
    const cursor = now.minus({ days: 181 }).toUTC().toISO()!;
    expect(() => buildContinuationRange(makeTracking({ cursor }), 'UTC', now)).toThrow(
      /máximo por recolección/i,
    );
  });

  it('falla si el cursor guardado no es válido', () => {
    expect(() => buildContinuationRange(makeTracking({ cursor: 'roto' }), 'UTC', now)).toThrow(
      /no es válido/i,
    );
  });

  it('acepta una fecha JavaScript como límite actual', () => {
    const range = buildContinuationRange(makeTracking(), 'UTC', now.toJSDate());
    expect(range.end).toBe(now.toUTC().toISO());
  });
});
