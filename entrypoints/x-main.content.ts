import { extractListsFromPayload, extractTweetsFromPayload } from '../lib/x/normalize';
import { articleIdFromPath, operationFromGraphqlUrl, postIdFromPath } from '../lib/x/urls';

declare global {
  interface Window {
    __xenseHookInstalled?: boolean;
  }
}

const SOURCE = 'xense-page';
let detailPage = false;

function readOperation(method: string, requestUrl: string): string | null {
  if (method.toUpperCase() !== 'GET') return null;
  const url = new URL(requestUrl, location.href);
  if (url.origin !== 'https://x.com' && url.origin !== 'https://twitter.com') return null;
  const operation = operationFromGraphqlUrl(url.pathname);
  const lower = operation?.toLowerCase();
  if (!lower) return null;

  const path = location.pathname.replace(/\/+$/, '');
  if (detailPage && (postIdFromPath(path) || articleIdFromPath(path))
    && ['tweetdetail', 'tweetresultbyrestid'].includes(lower)) return operation;
  if (lower.includes('searchtimeline')) {
    const query = new URLSearchParams(location.search).get('q') ?? '';
    return path === '/search' && /^list:\d+\s/i.test(query) ? operation : null;
  }
  const isListPage = /^\/i\/lists(?:\/\d+)?$/.test(path) || /^\/[^/]+\/lists$/.test(path);
  return isListPage && lower.includes('list') ? operation : null;
}

function hasTweetTimeline(operation: string): boolean {
  const lower = operation.toLowerCase();
  return lower.includes('searchtimeline') || (lower.includes('list') && lower.includes('timeline'));
}

function reportRateLimit(operation: string): void {
  if (hasTweetTimeline(operation)) {
    window.postMessage({ source: SOURCE, kind: 'rate_limited', operation }, location.origin);
  }
  if (detailPage && !hasTweetTimeline(operation)) {
    window.postMessage({ source: SOURCE, kind: 'detail_limited' }, location.origin);
  }
}

function forward(operation: string, data: unknown): void {
  try {
    if (detailPage && !hasTweetTimeline(operation) && !operation.toLowerCase().includes('list')) {
      const posts = extractTweetsFromPayload(data);
      window.postMessage({ source: SOURCE, kind: 'detail', posts }, location.origin);
      return;
    }
    if (hasTweetTimeline(operation)) {
      const posts = extractTweetsFromPayload(data);
      if (posts.length > 0) {
        window.postMessage({ source: SOURCE, kind: 'tweets', operation, posts }, location.origin);
      }
    }
    if (operation.toLowerCase().includes('list')) {
      const lists = extractListsFromPayload(data);
      if (lists.length > 0) {
        window.postMessage({ source: SOURCE, kind: 'lists', operation, lists }, location.origin);
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
    detailPage = location.hash === '#xense-context';

    const originalFetch = window.fetch;
    window.fetch = (...args: Parameters<typeof fetch>): Promise<Response> => {
      const result = originalFetch.apply(window, args);
      try {
        const [input, init] = args;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const operation = readOperation(method, requestUrl(input));
        if (operation) {
          void result
            .then(async (response) => {
              if (response.status === 429) reportRateLimit(operation);
              if (response.ok) forward(operation, await response.clone().json());
            })
            .catch(() => {
              // Algunas respuestas no son JSON o el body ya se consumió.
            });
        }
      } catch {
        // Nunca interrumpir la aplicación de X por un fallo de captura.
      }
      return result;
    };

    try {
      const xhrPrototype = XMLHttpRequest.prototype;
      const originalOpen = xhrPrototype.open;
      const observed = new WeakMap<XMLHttpRequest, string | null>();

      xhrPrototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        Reflect.apply(originalOpen, this, [method, url, ...rest]);
        try {
          const operation = readOperation(method, String(url));
          const alreadyListening = observed.has(this);
          if (!operation && !alreadyListening) return;
          observed.set(this, operation);
          if (alreadyListening) return;

          this.addEventListener('load', () => {
            const operation = observed.get(this);
            if (!operation) return;
            try {
              if (this.status === 429) reportRateLimit(operation);
              if (this.status < 200 || this.status >= 300) return;
              const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              forward(operation, data);
            } catch {
              // Respuesta no JSON o inaccesible.
            }
          });
        } catch {
          observed.set(this, null);
        }
      };
    } catch (error) {
      console.warn('[Xense] No se pudo instalar el interceptor de XHR.', error);
    }
  },
});
