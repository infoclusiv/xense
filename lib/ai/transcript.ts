export type TranscriptOrigin = 'embedded' | 'whisperx' | 'whisper-cpp' | 'local-mixed' | 'youtube-manual' | 'youtube-automatic' | 'imported';
export type TranscriptStatus = 'ready' | 'no-audio' | 'no-speech' | 'engine-unavailable' | 'audio-unavailable'
  | 'failed' | 'tool-unavailable' | 'no-captions' | 'unavailable' | 'skipped';

export interface RawTranscription {
  status: TranscriptStatus;
  origin?: TranscriptOrigin;
  text?: string;
  language?: string;
  seconds?: number;
  duration?: number;
  complete?: boolean;
  truncated?: boolean;
  parts?: TranscriptionPart[];
}

export interface TranscriptionPart {
  offset: number;
  text: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcription extends Omit<RawTranscription, 'text' | 'parts'> {
  segments: TranscriptSegment[];
}

export function youtubeVideoId(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return;
    const [route, item] = url.pathname.split('/').filter(Boolean);
    const id = /^(www\.)?youtu\.be$/.test(url.hostname) ? route
      : /^(?:(?:www|m|music)\.)?youtube(?:-nocookie)?\.com$/.test(url.hostname)
        ? route === 'watch' ? url.searchParams.get('v')
          : route && ['shorts', 'embed', 'live'].includes(route) ? item : undefined
        : undefined;
    return id && /^[\w-]{11}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

export function youtubeUrl(id: string): string {
  return 'https://www.youtube.com/watch?v=' + id;
}

function parseTime(value: string): number | undefined {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match) return;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60
    + Number(match[3]) + Number(match[4]) / 1000;
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function parseTranscription(raw: RawTranscription): Transcription {
  const segments: TranscriptSegment[] = [];
  for (const part of raw.parts?.length ? raw.parts : [{ text: raw.text ?? '', offset: 0 }]) {
    addCaptionCues(segments, part);
  }
  return {
    status: raw.status === 'ready' && !segments.length ? 'failed' : raw.status,
    origin: raw.origin, language: raw.language, seconds: raw.seconds, duration: raw.duration,
    complete: raw.complete, truncated: raw.truncated,
    segments: segments.sort((a, b) => a.start - b.start),
  };
}

function addCaptionCues(segments: TranscriptSegment[], { text: input, offset }: TranscriptionPart) {
  if (!Number.isFinite(offset) || offset < 0) return;
  const cues = input.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/);
  for (const cue of cues) {
    const lines = cue.split('\n');
    const timing = lines.findIndex(line => /^\s*[\d:.,]+\s+-->\s+[\d:.,]+/.test(line));
    if (timing < 0) continue;
    const parts = /^\s*(\S+)\s+-->\s+(\S+)/.exec(lines[timing] ?? '');
    const localStart = parseTime(parts?.[1] ?? '');
    const localEnd = parseTime(parts?.[2] ?? '');
    const text = lines.slice(timing + 1).join(' ').replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|nbsp|quot|#39);/g,
      value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'" })[value] ?? value,
    ).replace(/\s+/g, ' ').trim().slice(0, 650);
    if (localStart === undefined || localEnd === undefined || localEnd < localStart || !text) continue;
    const start = Math.round((localStart + offset) * 1000) / 1000;
    const end = Math.round((localEnd + offset) * 1000) / 1000;
    const previous = segments.at(-1);
    if (previous?.text === text && start - previous.end < 1 && start >= previous.start) {
      previous.end = Math.max(previous.end, end);
    } else {
      segments.push({ start, end, text });
    }
  }
}

export function transcriptLabel(value: Transcription): string {
  const origin = {
    embedded: 'subtítulos incrustados', whisperx: 'transcrito con WhisperX',
    'whisper-cpp': 'transcrito con whisper.cpp', 'local-mixed': 'transcrito con WhisperX y whisper.cpp',
    'youtube-manual': 'subtítulos del canal de YouTube',
    'youtube-automatic': 'subtítulos automáticos de YouTube', imported: 'subtítulos importados',
  };
  const time = value.seconds === undefined ? '' : ` (${transcriptTime(value.seconds)})`;
  const duration = value.complete === true ? (value.origin === 'embedded' ? ' · pista completa' : ' · audio completo') + time
    : value.complete === false ? ' · procesamiento parcial' + (value.seconds ? ` hasta ${transcriptTime(value.seconds)}` : '')
      : value.seconds === undefined ? '' : ` · primeros ${Math.ceil(value.seconds)} s procesados`;
  if (value.status !== 'ready') {
    return {
      'no-audio': 'sin pista de audio', 'no-speech': 'sin voz detectada',
      'engine-unavailable': 'motor local de transcripción no configurado',
      'audio-unavailable': 'audio no accesible', failed: 'error de transcripción',
      'tool-unavailable': 'yt-dlp no disponible', 'no-captions': 'sin subtítulos accesibles en YouTube',
      unavailable: 'no se pudo consultar la transcripción', skipped: 'transcripción pendiente',
    }[value.status] + (['no-speech', 'failed'].includes(value.status) ? duration : '');
  }
  return (value.origin ? origin[value.origin] : 'transcripción')
    + (value.language ? ` · ${value.language}` : '') + duration
    + (value.truncated ? ' · archivo parcial' : '');
}

export function pickTranscriptSegments(transcription: Transcription, hint: string): TranscriptSegment[] {
  const matches = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\d]{4,}|\d+/gu)?.slice(0, 100));
  const keywords = matches(hint);
  const segments = transcription.segments;
  const ranked = segments.map((segment, index) => ({
    index,
    score: [...matches(segment.text)].filter(word => keywords.has(word)).length,
  })).sort((a, b) => b.score - a.score);
  const selected = new Set<number>();
  for (const { index, score } of ranked.slice(0, 6)) {
    if (!score) break;
    selected.add(index);
  }
  for (const fraction of [0, 0.5, 1]) {
    if (segments.length) selected.add(Math.round((segments.length - 1) * fraction));
  }
  return [...selected].sort((a, b) => a - b).map(index => ({
    ...segments[index]!, text: segments[index]!.text.slice(0, 200),
  }));
}

export function transcriptLink(url: string, seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const id = youtubeVideoId(url);
  if (id) return youtubeUrl(id) + `&t=${Math.floor(seconds)}s`;
  const source = new URL(url);
  if (source.hostname === 'video.twimg.com' || /\.(mp4|webm)$/i.test(source.pathname)) {
    source.hash = `t=${seconds}`;
    return source.href;
  }
}

export function transcriptTime(seconds: number): string {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
