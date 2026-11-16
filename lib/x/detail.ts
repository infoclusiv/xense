import type { NormalizedPost, PostArticle } from '../types';
import { articleIdFromPath } from './urls';

export function xArticleId(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (!/^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname)) return;
    return articleIdFromPath(url.pathname);
  } catch {
    return undefined;
  }
}

interface DetailResponse {
  limited?: boolean;
  captured?: boolean;
  post?: NormalizedPost;
  related?: NormalizedPost[];
  article?: PostArticle;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function readXDetail(
  kind: 'post' | 'article',
  id: string,
  signal: AbortSignal,
): Promise<DetailResponse> {
  signal.throwIfAborted();
  if (!/^\d{1,30}$/.test(id)) return {};
  const request = kind === 'post' ? { postId: id } : { articleId: id };
  const path = kind === 'post' ? 'i/status' : 'i/article';
  const tab = await chrome.tabs.create({ active: false, url: `https://x.com/${path}/${id}#xense-context` });
  if (tab.id === undefined) return {};
  let fallback: DetailResponse = {};
  let articleSignature = '';
  let articleStableSince = 0;
  try {
    const deadline = Date.now() + 7_000;
    while (Date.now() < deadline) {
      await pause(450, signal);
      const reply: DetailResponse | undefined = await chrome.tabs.sendMessage(tab.id, {
        type: 'READ_X_CONTEXT', ...request,
      }).catch(() => undefined);
      signal.throwIfAborted();
      if (reply?.limited) return { ...fallback, limited: true };
      if (reply?.post?.id === id && reply.captured) return reply;
      if (reply?.article) {
        const signature = JSON.stringify(reply.article);
        if (signature !== articleSignature) {
          fallback = reply;
          articleSignature = signature;
          articleStableSince = Date.now();
        } else if (Date.now() - articleStableSince >= 950) return reply;
      }
      if (reply?.post?.id === id) fallback = reply;
    }
    return fallback;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}
