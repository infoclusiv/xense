import { DateTime } from 'luxon';
import type { DateRangeInfo, NormalizedPost, RunData, RunStats } from '../types';
import { postIdFromUrl } from '../x/urls';
import { contextCoverageText, webUrl, type ContextCoverage, type ContextEvidence } from './evidence';
import { pickTranscriptSegments, transcriptLabel, transcriptLink, transcriptTime, type TranscriptSegment } from './transcript';

interface Source {
  id: string;
  handle: string;
  url: string;
  createdAt: string;
  title?: string;
  method?: string;
  moments?: ContextEvidence['moments'];
  transcript?: TranscriptSegment[];
}

interface Finding {
  title: string;
  detail: string;
  sources: Source[];
}

interface Activity {
  label: string;
  range: string;
  count: number;
}

export interface Infographic {
  title: string;
  takeaway: string;
  findings: Finding[];
  limitation: string;
  transcriptNotes?: Array<{ url: string; label: string; detail: string }>;
  collection: {
    name: string;
    period: string;
    timezone: string;
    total: number;
    authors: number;
    activeDays: number;
    byType: RunStats['byType'];
    activity: Activity[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function sourceForPost(post: NormalizedPost): Source | undefined {
  if (!/^\d{1,30}$/.test(post.id)) return;
  const handle = post.author.handle;
  const path = /^[\w]{1,50}$/.test(handle) ? handle + '/status/' : 'i/web/status/';
  const originalUrl = post.isRepost && postIdFromUrl(post.permalink) === post.originalPostId
    && post.originalPostId ? webUrl(post.permalink) : undefined;
  return { id: post.id, handle, url: originalUrl ?? 'https://x.com/' + path + post.id, createdAt: post.createdAt };
}

function sourceForContext(evidence: ContextEvidence, hint: string): Source | undefined {
  const url = evidence.url && webUrl(evidence.url);
  if (!url || !['complete', 'partial'].includes(evidence.status)) return;
  if (!evidence.text && !evidence.title && !evidence.handle && !evidence.visual && !evidence.moments?.length
    && evidence.transcription?.status !== 'ready' && !evidence.alt) return;
  const labels = { post: 'Post relacionado', article: 'Artículo', link: 'Página enlazada', image: 'Imagen', video: 'Video o GIF' };
  return {
    id: evidence.id, url, handle: evidence.handle ?? '', createdAt: evidence.createdAt ?? '',
    title: readText(evidence.title, 160) || (evidence.handle ? '@' + evidence.handle : labels[evidence.kind]),
    method: evidence.method,
    moments: evidence.moments,
    transcript: evidence.transcription?.status === 'ready' ? pickTranscriptSegments(evidence.transcription, hint) : undefined,
  };
}

function collectionPeriod(range: DateRangeInfo): string {
  const options = { zone: range.timezone, locale: 'es' };
  const start = DateTime.fromISO(range.start, options);
  const end = DateTime.fromISO(range.end, options).minus({ milliseconds: 1 });
  if (!start.isValid || !end.isValid) return range.label;
  return start.hasSame(end, 'day')
    ? start.toFormat('d MMM yyyy')
    : `${start.toFormat('d MMM yyyy')} – ${end.toFormat('d MMM yyyy')}`;
}

function summarizeActivity(days: RunStats['days']): Activity[] {
  const first = DateTime.fromISO(days[0]?.day ?? '', { zone: 'utc', locale: 'es' });
  const last = DateTime.fromISO(days.at(-1)?.day ?? '', { zone: 'utc' });
  if (!first.isValid || !last.isValid) return [];

  const span = last.diff(first, 'days').days + 1;
  const bucketSize = Math.ceil(span / 12);
  const counts = Array.from({ length: Math.ceil(span / bucketSize) }, () => 0);
  for (const day of days) {
    const date = DateTime.fromISO(day.day, { zone: 'utc' });
    const index = Math.floor(date.diff(first, 'days').days / bucketSize);
    counts[index] = (counts[index] ?? 0) + day.count;
  }

  return counts.map((count, index) => {
    const start = first.plus({ days: index * bucketSize });
    const end = first.plus({ days: Math.min((index + 1) * bucketSize, span) - 1 });
    const startLabel = start.toFormat('d MMM yyyy');
    return {
      label: start.toFormat('d MMM'),
      range: start.equals(end) ? startLabel : `${startLabel} – ${end.toFormat('d MMM yyyy')}`,
      count,
    };
  });
}

export function buildInfographic(
  text: string,
  data: RunData,
  evidence: ReadonlyMap<string, ContextEvidence> = new Map(),
): Infographic {
  const json = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error('El proveedor no devolvió JSON válido para la infografía.');
  }
  if (!isRecord(payload) || !Array.isArray(payload.findings)) {
    throw new Error('El proveedor no devolvió los hallazgos de la infografía.');
  }

  const title = readText(payload.title, 160);
  const takeaway = readText(payload.takeaway, 550);
  if (!title || !takeaway || payload.findings.length === 0) {
    throw new Error('El proveedor devolvió una infografía incompleta.');
  }

  const sourcesById = new Map<string, Source>();
  for (const post of data.posts) {
    const source = sourceForPost(post);
    if (source && !sourcesById.has(post.id)) sourcesById.set(post.id, source);
  }
  const findings = payload.findings.slice(0, 6).map((item: unknown): Finding => {
    if (!isRecord(item)) {
      throw new Error('El proveedor devolvió un hallazgo sin referencias.');
    }
    const idsInput = item.sourceIds ?? item.postIds;
    if (!Array.isArray(idsInput)) throw new Error('El proveedor devolvió un hallazgo sin referencias.');
    const findingTitle = readText(item.title, 160);
    const detail = readText(item.detail, 550);
    const ids = new Set(idsInput.filter((id): id is string => typeof id === 'string').map(id => id.trim()));
    const sources = [...ids].flatMap(id => {
      const context = evidence.get(id);
      const source = sourcesById.get(id) ?? (context && sourceForContext(context, findingTitle + ' ' + detail));
      return source ? [source] : [];
    }).slice(0, 4);

    if (!findingTitle || !detail || !sources.length) {
      throw new Error('El proveedor devolvió un hallazgo incompleto o sin respaldo en la recolección.');
    }
    return { title: findingTitle, detail, sources };
  });

  const { config } = data.run;
  const { total, authors, byType, days } = data.stats;
  const transcriptNotes = [...evidence.values()].flatMap(source => {
    const url = source.url && webUrl(source.url);
    const transcript = source.transcription;
    if (!url || !transcript || transcript.status === 'skipped'
      || (transcript.status === 'ready' && transcript.complete !== false)) return [];
    return [{ url, label: source.title || 'Video o GIF', detail: transcriptLabel(transcript) }];
  });
  return {
    title,
    takeaway,
    findings,
    limitation: readText(payload.limitation, 550),
    transcriptNotes: transcriptNotes.length ? transcriptNotes : undefined,
    collection: {
      name: config.listName,
      period: collectionPeriod(config.range),
      timezone: config.range.timezone,
      total,
      authors,
      activeDays: days.length,
      byType,
      activity: summarizeActivity(days),
    },
  };
}

function markdownText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
    .replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
    .replace(/[\\`*_{}\[\]()#+.!|~]/g, '\\$&');
}

export function infographicMarkdown(report: Infographic, coverage?: ContextCoverage): string {
  const scope = [report.limitation, contextCoverageText(coverage)].filter(Boolean).map(markdownText);
  for (const note of report.transcriptNotes ?? []) {
    scope.push(`[${markdownText(note.label)}](<${note.url}>) · ${markdownText(note.detail)}`);
  }
  return [
    '# ' + markdownText(report.title),
    markdownText(report.takeaway),
    ...report.findings.map(finding => [
      '## ' + markdownText(finding.title),
      markdownText(finding.detail),
      finding.sources.map(source => {
        const label = (source.title ?? '@' + source.handle) + (source.method ? ' · ' + source.method : '');
        return `[${markdownText(label)}](<${source.url}>)`;
      }).join(' · '),
      ...finding.sources.flatMap(source => source.moments?.length ? [[
        'Fotogramas · ' + markdownText(source.title ?? 'Video o GIF'),
        '',
        ...source.moments.map(moment => `- ${moment.seconds} s · ${markdownText(moment.text)}`),
      ].join('\n')] : []),
      ...finding.sources.flatMap(source => source.transcript?.length ? [[
        'Transcripción · ' + markdownText(source.title ?? 'Video'),
        '',
        ...source.transcript.map(segment => {
          const time = transcriptTime(segment.start);
          const url = transcriptLink(source.url, segment.start);
          return `- ${url ? `[${time}](<${url}>)` : time} · ${markdownText(segment.text)}`;
        }),
      ].join('\n')] : []),
    ].join('\n\n')),
    ...(scope.length ? ['## Alcance del análisis\n\n' + scope.join('\n\n')] : []),
  ].join('\n\n') + '\n';
}
