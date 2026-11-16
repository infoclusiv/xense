import { createReadStream } from 'node:fs';
import { access, open, readFile, stat, unlink } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { MEDIA_INPUT } from './motion.mjs';

const MAX_CAPTION_BYTES = 160_000;

export async function findExecutable(value) {
  if (typeof value !== 'string' || !value.trim()) return;
  const executable = process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(value) ? value + '.exe' : value;
  if (!isAbsolute(executable) && /[\\/]/.test(executable)) return;
  const locations = isAbsolute(executable) ? [executable] : (process.env.PATH ?? '').split(delimiter)
    .filter(isAbsolute).map(directory => join(directory, executable));
  for (const candidate of locations) {
    try {
      await access(candidate);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Probar el siguiente directorio. */ }
  }
}

export async function transcriptionTools() {
  const [whisperx, ytDlp] = await Promise.all([
    findExecutable(process.env.XENSE_WHISPERX_PATH || process.env.XENSE_WHISPERX_PYTHON || 'whisperx'),
    findExecutable(process.env.XENSE_YTDLP_PATH || 'yt-dlp'),
  ]);
  return { whisperx: Boolean(whisperx), youtube: Boolean(ytDlp) };
}

export async function readCaptions(folder, name) {
  const file = await open(join(folder, name), 'r');
  try {
    const bytes = Buffer.alloc(MAX_CAPTION_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const truncated = bytesRead > MAX_CAPTION_BYTES;
    let text = bytes.subarray(0, Math.min(MAX_CAPTION_BYTES, bytesRead)).toString('utf8');
    if (truncated) text = text.slice(0, Math.max(text.lastIndexOf('\n\n'), text.lastIndexOf('\r\n\r\n')));
    return { text: text.trim(), truncated };
  } finally {
    await file.close();
  }
}

async function* captionParts(file) {
  await stat(file);
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let error;
  input.on('error', cause => {
    error = cause;
    lines.close();
  });
  let buffer = '';
  try {
    for await (const line of lines) {
      buffer += line + '\n';
      if (buffer.length > 100_000) throw new Error('Una entrada de subtítulos supera el tamaño permitido.');
      if (!line.trim() && buffer.length >= 32_000) {
        yield buffer;
        buffer = '';
      }
    }
    if (error) throw error;
    if (buffer.trim()) yield buffer;
  } finally {
    input.destroy();
    lines.close();
  }
}

async function emitCaptions(folder, file, offset, onPart, signal) {
  let found = false;
  for await (const text of captionParts(join(folder, file))) {
    signal?.throwIfAborted();
    onPart({ offset, text });
    found = true;
  }
  return found;
}

function listAudioChunks(csv) {
  return csv.split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^(audio-\d+\.wav),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(line);
    if (!match) throw new Error('No se pudo leer la duración de los tramos de audio.');
    return { input: match[1], start: Number(match[2]), end: Number(match[3]) };
  });
}

export async function transcribeMedia({ input, format, ffmpeg, probe }, folder, execute, callbacks) {
  const { signal, onPart, onProgress } = callbacks;
  const clip = [...MEDIA_INPUT, '-f', format, '-i', input];
  const options = { cwd: folder, timeout: Math.max(300_000, Math.ceil((probe?.duration ?? 0) * 100)), shell: false };
  const duration = probe?.duration;
  if (probe?.hasSubtitles !== false) {
    try {
      await execute(ffmpeg, [...clip, '-map', '0:s:0', 'subtitles.srt'], options);
      if (await emitCaptions(folder, 'subtitles.srt', 0, onPart, signal)) {
        return { status: 'ready', origin: 'embedded', seconds: duration, duration, complete: true };
      }
    } catch {
      signal?.throwIfAborted();
      // El audio sigue disponible cuando falla la pista de subtítulos.
    }
  }
  if (probe?.hasAudio === false) return { status: 'no-audio' };
  const python = !process.env.XENSE_WHISPERX_PATH && process.env.XENSE_WHISPERX_PYTHON;
  const whisperx = await findExecutable(process.env.XENSE_WHISPERX_PATH || python || 'whisperx');
  const model = process.env.XENSE_WHISPER_MODEL;
  const whisperCpp = model && await findExecutable(process.env.XENSE_WHISPER_PATH);
  if (!whisperx && !whisperCpp) return { status: 'engine-unavailable' };
  let chunks;
  try {
    onProgress?.('Extrayendo el audio completo…');
    await execute(ffmpeg, [...clip, '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '1',
      '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', '300', '-segment_format', 'wav',
      '-reset_timestamps', '1', '-segment_list', 'audio-chunks.csv', 'audio-%05d.wav'], options);
    chunks = listAudioChunks(await readFile(join(folder, 'audio-chunks.csv'), 'utf8'));
  } catch {
    signal?.throwIfAborted();
    return { status: 'audio-unavailable' };
  }
  if (!chunks.length) return { status: 'audio-unavailable' };
  let origin;
  let hasTranscript = false;
  let seconds = 0;
  const engines = [whisperx && 'whisperx', whisperCpp && 'whisper-cpp'].filter(Boolean);
  for (const [index, chunk] of chunks.entries()) {
    signal?.throwIfAborted();
    onProgress?.(`Transcribiendo audio localmente · tramo ${index + 1} de ${chunks.length}…`);
    let done = false;
    const stem = chunk.input.slice(0, -4);
    for (const engine of engines) {
      const output = engine === 'whisperx' ? stem + '.srt' : stem + '-cpp.srt';
      try {
        if (engine === 'whisperx') {
          const device = process.env.XENSE_WHISPERX_DEVICE === 'cuda' ? 'cuda' : 'cpu';
          await execute(whisperx, [
            ...(python ? ['-m', 'whisperx'] : []),
            chunk.input, '--model', process.env.XENSE_WHISPERX_MODEL || 'small',
            '--device', device, '--compute_type', device === 'cuda' ? 'float16' : 'int8',
            '--output_dir', '.', '--output_format', 'srt',
          ], { ...options, timeout: 900_000 });
        } else {
          await execute(whisperCpp, [
            '-m', model, '-f', chunk.input, '-l', 'auto', '-osrt', '-of', stem + '-cpp',
          ], { ...options, timeout: 900_000 });
        }
        hasTranscript = await emitCaptions(folder, output, chunk.start, onPart, signal) || hasTranscript;
        origin = origin && origin !== engine ? 'local-mixed' : engine;
        seconds = chunk.end;
        done = true;
        break;
      } catch {
        signal?.throwIfAborted();
      }
    }
    if (!done) return { status: hasTranscript ? 'ready' : 'failed', origin, seconds, duration, complete: false };
    await unlink(join(folder, chunk.input)).catch(() => undefined);
  }
  return { status: hasTranscript ? 'ready' : 'no-speech', origin, seconds, duration, complete: true };
}

function captionTracks(output) {
  const tracks = [];
  let origin;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      origin = line.includes('Available automatic captions') ? 'youtube-automatic'
        : line.includes('Available subtitles') ? 'youtube-manual' : undefined;
      continue;
    }
    const row = /^([\w-]+)\s+(.+)$/.exec(line);
    if (origin && row && !['Language', 'live_chat'].includes(row[1]) && /(?:^|[,\s])(?:srt|vtt)(?:[,\s]|$)/.test(row[2])) {
      tracks.push({ language: row[1], origin, original: row[1].endsWith('-orig') || /\(Original\)/i.test(row[2]) });
    }
  }
  return tracks;
}

export async function readYouTubeCaptions(id, preferred, folder, execute) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) return { status: 'unavailable' };
  const executable = await findExecutable(process.env.XENSE_YTDLP_PATH || 'yt-dlp');
  if (!executable) return { status: 'tool-unavailable' };
  const url = 'https://www.youtube.com/watch?v=' + id;
  const args = ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--skip-download',
    '--js-runtimes', 'node:' + process.execPath, '--no-remote-components',
    '--no-cache-dir', '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0'];
  const options = { cwd: folder, shell: false, timeout: 30_000 };
  try {
    const listing = await execute(executable, [...args, '--list-subs', '--', url], options);
    const language = typeof preferred === 'string' ? preferred.toLowerCase().split('-')[0] : undefined;
    const tracks = captionTracks(listing);
    const ranked = tracks.sort((a, b) => {
      const score = track => Number(track.origin === 'youtube-manual') * 8
        + Number(track.original) * 4 + Number(track.language.toLowerCase().split('-')[0] === language) * 2
        + Number(/^(es|en)(-|$)/i.test(track.language));
      return score(b) - score(a);
    });
    for (const track of ranked.slice(0, 2)) {
      const escaped = track.language.replace(/[^\w-]/g, '');
      try {
        await execute(executable, [...args, track.origin === 'youtube-manual' ? '--write-subs' : '--write-auto-subs',
          '--sub-langs', '^' + escaped + '$', '--sub-format', 'vtt/srt', '-o', 'caption.%(ext)s', '--', url], options);
        for (const format of ['vtt', 'srt']) {
          const file = await readCaptions(folder, `caption.${escaped}.${format}`).catch(() => undefined);
          if (file?.text) return { status: 'ready', origin: track.origin, language: track.language, ...file };
        }
      } catch { /* Probar otra pista antes de indicar que la descarga no funcionó. */ }
    }
    return { status: tracks.length ? 'unavailable' : 'no-captions' };
  } catch {
    return { status: 'unavailable' };
  }
}
