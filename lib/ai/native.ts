import type { AiProvider } from './analysis';
import type { RawTranscription, TranscriptionPart } from './transcript';

export const XENSE_NATIVE_HOST = 'com.infoclusiv.xense';

export interface AiModelOption {
  id: string;
  label: string;
}

export interface NativeReply {
  ok: boolean;
  error?: string;
  text?: string;
  version?: string;
  models?: AiModelOption[];
  page?: { url: string; html: string; type: string };
  transcription?: RawTranscription;
  transcripts?: { whisperx: boolean; youtube: boolean };
  media?: {
    description?: string;
    transcription?: RawTranscription;
    frames: number[];
    moments?: Array<{ seconds: number; text: string }>;
    duration?: number;
    seconds?: number;
    thumbnailOnly?: boolean;
  };
  providers?: Record<AiProvider, { installed: boolean; label: string; version?: string }>;
}

interface StreamingOptions {
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

function requestStreamingMedia(message: Record<string, unknown>, options: StreamingOptions): Promise<NativeReply> {
  const { signal, onProgress } = options;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const parts: TranscriptionPart[] = [];
    const port = chrome.runtime.connectNative(XENSE_NATIVE_HOST);
    let done = false;
    const finish = (response?: NativeReply, error?: string) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', cancel);
      port.disconnect();
      if (signal.aborted) reject(signal.reason);
      else if (response?.ok) resolve(response);
      else reject(new Error(error ?? response?.error ?? 'El puente local no respondió correctamente.'));
    };
    const cancel = () => {
      try { port.postMessage({ type: 'CANCEL' }); }
      catch { finish(); }
    };
    port.onMessage.addListener((reply: NativeReply & { type?: string; part?: TranscriptionPart; message?: string }) => {
      if (reply.type === 'TRANSCRIPTION_PART') {
        if (reply.part && typeof reply.part.text === 'string') parts.push(reply.part);
        return;
      }
      if (reply.type === 'TRANSCRIPTION_PROGRESS') {
        if (!signal.aborted && typeof reply.message === 'string') onProgress(reply.message);
        return;
      }
      if (reply.media?.transcription && parts.length) reply.media.transcription.parts = parts;
      finish(reply);
    });
    port.onDisconnect.addListener(() => finish(undefined, chrome.runtime.lastError?.message));
    signal.addEventListener('abort', cancel, { once: true });
    try { port.postMessage({ ...message, streamTranscription: true }); }
    catch { finish(); }
  });
}

export async function nativeRequest(message: Record<string, unknown>, streaming?: StreamingOptions): Promise<NativeReply> {
  if (streaming) return requestStreamingMedia(message, streaming);
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(XENSE_NATIVE_HOST, message, (response: NativeReply | undefined) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error('No se encontró el puente local de Xense. Instala companion/install-windows.ps1 y vuelve a probar. (' + error.message + ')'));
          return;
        }
        if (!response || response.ok === false) {
          reject(new Error(response?.error || 'El puente local no respondió correctamente.'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}
