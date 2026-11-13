import type { AiProvider } from './analysis';

export const XENSE_NATIVE_HOST = 'com.infoclusiv.xense';

export interface NativeReply {
  ok: boolean;
  error?: string;
  text?: string;
  version?: string;
  providers?: Record<AiProvider, { installed: boolean; label: string; version?: string }>;
}

export async function nativeRequest(message: Record<string, unknown>): Promise<NativeReply> {
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
