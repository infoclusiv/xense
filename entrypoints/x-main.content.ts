import { extractListsFromPayload, extractTweetsFromPayload } from '../lib/x/normalize';
import { operationFromGraphqlUrl } from '../lib/x/urls';

declare global {
  interface Window {
    __xenseHookInstalled?: boolean;
  }
}

const SOURCE = 'xense-page';

function shouldForward(operation: string | null): boolean {
  if (!operation) return false;
  const lower = operation.toLowerCase();
  return lower.includes('searchtimeline') || lower.includes('list');
}

function hasTweetTimeline(operation: string): boolean {
  const lower = operation.toLowerCase();
  return lower.includes('searchtimeline') || (lower.includes('list') && lower.includes('timeline'));
}

function forward(operation: string, data: unknown): void {
  try {
    if (hasTweetTimeline(operation)) {
      const posts = extractTweetsFromPayload(data);
      if (posts.length > 0) {
        window.postMessage({ source: SOURCE, kind: 'tweets', operation, posts }, '*');
      }
    }
    if (operation.toLowerCase().includes('list')) {
      const lists = extractListsFromPayload(data);
      if (lists.length > 0) {
        window.postMessage({ source: SOURCE, kind: 'lists', operation, lists }, '*');
      }
    }
  } catch (error) {
    console.warn('[Xense] No se pudo procesar una respuesta de X.', error);
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '';
}

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    if (window.__xenseHookInstalled) return;
    window.__xenseHookInstalled = true;

    const originalFetch = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const response = await originalFetch.apply(window, args);
      try {
        const url = requestUrl(args[0]);
        const operation = operationFromGraphqlUrl(url);
        if (shouldForward(operation) && response.ok) {
          response
            .clone()
            .json()
            .then((data: unknown) => {
              if (operation) forward(operation, data);
            })
            .catch(() => {
              // Algunas respuestas no son JSON o el body ya se consumió.
            });
        }
      } catch {
        // Nunca interrumpir la aplicación de X por un fallo de captura.
      }
      return response;
    };

    try {
      const xhrPrototype = XMLHttpRequest.prototype as any;
      const originalOpen = xhrPrototype.open;
      const originalSend = xhrPrototype.send;

      xhrPrototype.open = function (method: string, url: string | URL, ...rest: any[]) {
        this.__xenseUrl = String(url);
        return originalOpen.call(this, method, url, ...rest);
      };

      xhrPrototype.send = function (...args: any[]) {
        this.addEventListener('load', () => {
          try {
            const operation = operationFromGraphqlUrl(String(this.__xenseUrl ?? ''));
            if (!shouldForward(operation) || this.status < 200 || this.status >= 300) return;
            const data = JSON.parse(this.responseText);
            if (operation) forward(operation, data);
          } catch {
            // Respuesta no JSON o inaccesible.
          }
        });
        return originalSend.apply(this, args);
      };
    } catch (error) {
      console.warn('[Xense] No se pudo instalar el interceptor de XHR.', error);
    }
  },
});
