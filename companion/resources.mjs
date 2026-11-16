import { lookup } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createWriteStream } from 'node:fs';
import { rename as renameMedia, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { probeMedia, sampleMotion } from './motion.mjs';
import { transcribeMedia } from './transcription.mjs';

const nonPublic = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) nonPublic.addSubnet(network, prefix);

const mediaHosts = new Set(['pbs.twimg.com', 'video.twimg.com']);
const imageFormats = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif'],
]);

export function publicUrl(input, mediaOnly = false) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Enlace inválido.');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password
    || isIP(url.hostname.replace(/^\[|\]$/g, ''))
    || !url.hostname.includes('.') || url.hostname.endsWith('.')
    || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')
    || (mediaOnly && (url.protocol !== 'https:' || !mediaHosts.has(url.hostname)))) {
    throw new Error('El enlace no apunta a un recurso público admitido.');
  }
  url.hash = '';
  return url;
}

function readResponse(url, address, { accepts, maxBytes, signal, destination }) {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? requestHttps : requestHttp;
    const req = request(url, {
      agent: false,
      autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { Accept: accepts, 'Accept-Encoding': 'identity', 'User-Agent': 'Xense/0.1' },
      signal,
    }, response => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.destroy();
        try { resolve({ redirect: new URL(response.headers.location, url).href }); }
        catch (error) { reject(error); }
        return;
      }
      const type = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (status !== 200 || !accepts.split(', ').includes(type)
        || Number(response.headers['content-length']) > maxBytes) {
        response.destroy();
        reject(new Error('El recurso está restringido, supera el tamaño permitido o usa un formato incompatible.'));
        return;
      }
      if (destination) {
        let size = 0;
        const limit = new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > maxBytes) callback(new Error('Espacio insuficiente para descargar el video.'));
            else callback(null, chunk);
          },
        });
        pipeline(response, limit, createWriteStream(destination), { signal })
          .then(() => resolve({ type, url: url.href })).catch(reject);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error('El recurso supera el tamaño permitido.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('El servidor interrumpió la descarga.')));
      response.on('end', () => resolve({ type, body: Buffer.concat(chunks), url: url.href }));
    });
    if (destination) req.setTimeout(25_000, () => req.destroy(new Error('La descarga del video dejó de responder.')));
    req.on('error', reject);
    req.end();
  });
}

async function download(input, { accepts, maxBytes, mediaOnly = false, destination, signal: callerSignal }) {
  let location = input;
  const timeout = AbortSignal.timeout(12_000);
  const signal = destination && callerSignal ? callerSignal
    : callerSignal ? AbortSignal.any([callerSignal, timeout]) : destination ? undefined : timeout;
  for (let count = 0; count < 5; count++) {
    const url = publicUrl(location, mediaOnly);
    const { address } = await lookup(url.hostname, { family: 4 });
    if (nonPublic.check(address)) throw new Error('El recurso resuelve a una red no pública.');
    const result = await readResponse(url, address, { accepts, maxBytes, signal, destination });
    if (!result.redirect) return result;
    location = result.redirect;
  }
  throw new Error('El recurso redirigió demasiadas veces.');
}

export async function readPublicPage(url) {
  const result = await download(url, { accepts: 'text/html, application/xhtml+xml, text/plain', maxBytes: 380_000 });
  const html = result.body.toString('utf8');
  if (Buffer.byteLength(JSON.stringify(html)) > 850_000) throw new Error('La página supera el tamaño permitido.');
  return { ok: true, page: { url: result.url, html, type: result.type } };
}

async function availableVideoBytes(folder) {
  const { bavail, bsize } = await statfs(folder);
  // Leave working space for FFmpeg and the audio files beside the downloaded video.
  return Math.max(0, Math.floor((bavail * bsize - 128 * 1024 ** 2) * 0.75));
}

export async function prepareMedia(request, folder, execute, { signal, onPart, onProgress } = {}) {
  const moving = request.kind === 'video' || request.kind === 'gif';
  if (!moving && request.kind !== 'photo') throw new Error('Tipo de adjunto incompatible.');
  const limits = {
    accepts: [...imageFormats.keys(), ...(moving ? ['video/mp4', 'video/webm'] : [])].join(', '),
    maxBytes: moving ? await availableVideoBytes(folder) : 5 * 1024 * 1024,
    mediaOnly: request.publicArticle !== true,
    signal,
  };
  const input = 'media.input';
  const target = moving ? join(folder, input) : undefined;
  const original = moving && request.originalUrl !== request.url && request.originalUrl;
  let usedOriginal = false;
  let file;
  try {
    file = await download(request.url, { ...limits, destination: target });
  } catch (error) {
    signal?.throwIfAborted();
    if (!original) throw error;
    file = await download(original, { ...limits, destination: target });
    usedOriginal = true;
  }
  const extension = imageFormats.get(file.type) ?? (file.type === 'video/webm' ? 'webm' : 'mp4');
  const attachmentName = `media.${extension}`;
  if (file.body) await writeFile(join(folder, attachmentName), file.body);
  if (!['mp4', 'webm', 'gif'].includes(extension)) {
    if (moving) await renameMedia(target, join(folder, attachmentName));
    return { attachments: [attachmentName], frames: moving ? [0] : [], thumbnailOnly: moving,
      transcription: moving ? { status: 'audio-unavailable' } : undefined };
  }

  const ffmpeg = process.env.XENSE_FFMPEG_PATH || 'ffmpeg';
  const format = { mp4: 'mov', webm: 'matroska', gif: 'gif' }[extension];
  const { asset, samples, duration, probe } = await sampleMotion({
    ffmpeg, input: moving ? input : attachmentName, format, durationHint: Number(request.durationMs) / 1000,
  }, execute, folder);
  const attachments = samples.map(sample => sample.name);
  const frames = samples.map(sample => sample.time);
  const result = { attachments, frames, asset, samples, duration, seconds: asset.limit };
  if (extension === 'gif') {
    const motion = { ...result, transcription: { status: 'no-audio' } };
    if (attachments.length) return motion;
    if (moving) await renameMedia(target, join(folder, attachmentName));
    return { ...motion, attachments: [attachmentName], thumbnailOnly: true };
  }
  if (request.skipTranscription === true) return result;
  const transcriptOptions = { signal, onPart, onProgress };
  let transcription = await transcribeMedia({ input, format, probe, ffmpeg }, folder, execute, transcriptOptions);
  if (original && !usedOriginal && ['no-audio', 'audio-unavailable'].includes(transcription.status)) {
    try {
      const audioInput = 'original.input';
      const audio = await download(original, {
        ...limits, accepts: 'video/mp4, video/webm', destination: join(folder, audioInput),
        maxBytes: await availableVideoBytes(folder),
      });
      const audioFormat = audio.type === 'video/webm' ? 'matroska' : 'mov';
      const audioProbe = await probeMedia(audioInput, audioFormat, ffmpeg, execute, folder);
      transcription = await transcribeMedia({
        input: audioInput, format: audioFormat, probe: audioProbe, ffmpeg,
      }, folder, execute, transcriptOptions);
    } catch {
      signal?.throwIfAborted();
      transcription = { status: 'audio-unavailable' };
    }
  }
  return { ...result, transcription };
}
