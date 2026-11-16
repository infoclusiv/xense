import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const VIDEO_LIMIT = 120;
export const MEDIA_INPUT = ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-threads', '2'];

const rounded = value => Math.round(value * 1000) / 1000;

export function framePlan(duration, scenes = []) {
  if (!(duration > 0)) return [0, 0.125, 0.4, 1, 3, 12];
  const end = Math.max(0, duration - Math.min(duration / 12, 0.35));
  const base = [0, 0.25, 0.5, 0.75, 1].map(fraction => rounded(end * fraction));
  const gap = Math.min(1.5, duration / 16);
  const remaining = scenes.filter(time => time > 0 && time < end);
  while (base.length < 8 && remaining.length) {
    const distance = time => Math.min(...base.map(frame => Math.abs(frame - time)));
    remaining.sort((a, b) => distance(b) - distance(a));
    const candidate = remaining.shift();
    if (distance(candidate) < gap) break;
    base.push(rounded(candidate));
  }
  return [...new Set(base)].sort((a, b) => a - b);
}

export async function chooseFrames(asset, offsets, execute, folder) {
  const samples = [];
  for (const offset of offsets) {
    const name = `frame-${Math.round(offset * 1000)}.jpg`;
    let log;
    try {
      log = await execute(asset.ffmpeg, [
        ...MEDIA_INPUT, '-copyts', '-ss', String(offset), '-f', asset.format, '-i', asset.input,
        '-frames:v', '1', '-vf', 'scale=min(1280\\,iw):-2,metadata=add:key=xense.frame:value=1,metadata=print:key=xense.frame:file=-',
        '-an', name,
      ], { cwd: folder, shell: false, timeout: 15_000 });
      if (!(await stat(join(folder, name))).size) continue;
    } catch {
      continue;
    }
    const timestamp = Number(/(?:^|\s)pts_time:(-?[\d.]+)/m.exec(log)?.[1]);
    const time = rounded(Number.isFinite(timestamp) ? Math.max(0, timestamp - asset.startTime) : offset);
    if (time < asset.limit && !samples.some(frame => Math.abs(frame.time - time) < 0.002)) samples.push({ name, time });
  }
  return samples;
}

export async function probeMedia(input, format, ffmpeg, execute, folder) {
  const ffprobe = process.env.XENSE_FFPROBE_PATH || (process.env.XENSE_FFMPEG_PATH
    ? join(dirname(process.env.XENSE_FFMPEG_PATH), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
  try {
    const probe = JSON.parse(await execute(ffprobe, [
      '-v', 'error', '-protocol_whitelist', 'file', '-f', format,
      '-show_entries', 'format=duration,start_time:stream=duration,codec_type', '-of', 'json', input,
    ], { cwd: folder, shell: false, timeout: 16_000 }));
    const lengths = [probe.format?.duration, ...(probe.streams ?? []).map(stream => stream.duration)].map(Number);
    return {
      duration: lengths.find(length => Number.isFinite(length) && length > 0),
      startTime: Number(probe.format?.start_time) || 0,
      hasAudio: probe.streams?.some(stream => stream.codec_type === 'audio'),
      hasSubtitles: probe.streams?.some(stream => stream.codec_type === 'subtitle'),
    };
  } catch { return undefined; }
}

export async function sampleMotion({ input, format, durationHint, ffmpeg }, execute, folder) {
  const options = { cwd: folder, shell: false, timeout: 16_000 };
  const probe = await probeMedia(input, format, ffmpeg, execute, folder);
  const duration = probe?.duration ?? (Number(durationHint) || 0);
  const startTime = probe?.startTime ?? 0;
  const limit = duration > 0 ? Math.min(VIDEO_LIMIT, duration) : VIDEO_LIMIT;
  const asset = { input, format, ffmpeg, limit, startTime };
  let scenes = [];
  try {
    const log = await execute(ffmpeg, [
      ...MEDIA_INPUT, '-f', format, '-i', input, '-t', String(limit),
      '-an', '-vf', 'fps=8,scale=320:-2,scdet=t=10,metadata=print:key=lavfi.scd.time:file=-', '-f', 'null', '-',
    ], options);
    scenes = [...log.matchAll(/lavfi\.scd\.time=([\d.]+)/g)].map(match => Number(match[1]));
  } catch { /* El muestreo a intervalos sigue disponible. */ }
  const samples = await chooseFrames(asset, framePlan(duration > 0 ? limit : 0, scenes), execute, folder);
  return { asset, samples, duration: duration || undefined, probe };
}

export async function reviewMotion(asset, requestedTime, existing, execute, folder) {
  if (!(requestedTime >= 0 && requestedTime < asset.limit)) return [];
  const window = Math.min(0.6, asset.limit / 8);
  const offsets = [requestedTime - window, requestedTime, requestedTime + window]
    .map(rounded).filter(time => time >= 0 && time < asset.limit
      && existing.every(frame => Math.abs(frame.time - time) > 0.025));
  const samples = await chooseFrames(asset, offsets, execute, folder);
  return samples.filter(sample => existing.every(frame => Math.abs(frame.time - sample.time) >= 0.002));
}
