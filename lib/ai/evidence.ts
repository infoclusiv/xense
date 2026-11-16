import type { Transcription } from './transcript';

export type EvidenceKind = 'post' | 'article' | 'link' | 'image' | 'video';
export type EvidenceStatus = 'complete' | 'partial' | 'unavailable' | 'skipped';

export interface ContextEvidence {
  id: string;
  kind: EvidenceKind;
  url?: string;
  handle?: string;
  createdAt?: string;
  title?: string;
  text?: string;
  visual?: string;
  moments?: Array<{ seconds: number; text: string }>;
  transcription?: Transcription;
  alt?: string;
  status: EvidenceStatus;
  method: string;
}

export interface PostEvidence {
  relation: string;
  source: ContextEvidence;
  placement?: ArticlePlacement;
}

export interface ArticlePlacement {
  articleId: string;
  section?: string;
  nearby?: string;
  caption?: string;
}

export type EvidenceByPost = ReadonlyMap<string, PostEvidence[]>;
export type ContextCoverage = Record<EvidenceStatus, number>;

export function contextCoverageText(coverage?: ContextCoverage): string {
  if (!coverage || Object.values(coverage).every(count => count === 0)) return '';
  const format = new Intl.NumberFormat('es');
  return `Fuentes de contexto · Leídas ${format.format(coverage.complete)} · Parciales ${format.format(coverage.partial)} · No disponibles ${format.format(coverage.unavailable)} · Sin recuperar ${format.format(coverage.skipped)}`;
}

export function webUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 4096) return;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function relevantExcerpt(text: string, hint: string, limit: number): string {
  if (text.length <= limit) return text;
  const words = new Set(hint.toLowerCase().match(/[\p{L}\d]{4,}/gu)?.slice(0, 60));
  const paragraphs = text.split(/\n\n+/);
  let best = paragraphs[0] ?? '';
  let highest = 0;
  for (const paragraph of paragraphs) {
    const matches = new Set(paragraph.toLowerCase().match(/[\p{L}\d]{4,}/gu)?.filter(word => words.has(word)));
    if (matches.size > highest) {
      highest = matches.size;
      best = paragraph;
    }
  }
  const lead = (paragraphs[0] ?? '').slice(0, Math.floor(limit / 3));
  if (best === paragraphs[0]) return text.slice(0, limit) + '…';
  return lead + '\n\n[…] ' + best.slice(0, limit - lead.length - 10) + '…';
}
