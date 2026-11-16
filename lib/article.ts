import type { ArticleBlock, MediaItem } from './types';

export const MAX_ARTICLE_BLOCKS = 220;

export function articleText(blocks: ArticleBlock[]): string {
  return blocks.flatMap(block => block.kind === 'heading' || block.kind === 'text' ? [block.text] : [])
    .join('\n\n').slice(0, 40_000);
}

export function articleUrl(value: string | null | undefined, page: string): string | undefined {
  if (!value?.trim() || value.startsWith('#') || value.length > 4096) return;
  try {
    const url = new URL(value, page);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function cleanText(value: string | null | undefined, max = 1600): string | undefined {
  return value?.replace(/\s+/g, ' ').trim().slice(0, max) || undefined;
}

export function readArticleBlocks(root: ParentNode, pageUrl: string): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  const ignored = 'script, style, noscript, template, nav, header, footer, aside, form, dialog, [hidden], [aria-hidden="true"]';
  const visit = (element: Element, insideText = false): void => {
    if (blocks.length >= MAX_ARTICLE_BLOCKS || element.matches(ignored)) return;
    const tag = element.localName;
    const figure = element.closest('figure');
    const caption = cleanText(figure?.querySelector('figcaption')?.textContent, 400);
    if (tag === 'img' || tag === 'video') {
      const image = tag === 'img';
      const active = (element as HTMLImageElement | HTMLVideoElement).currentSrc;
      const source = articleUrl(active, pageUrl)
        ?? articleUrl(element.getAttribute('data-src'), pageUrl)
        ?? articleUrl(element.getAttribute('src'), pageUrl)
        ?? articleUrl(element.querySelector('source[src]')?.getAttribute('src'), pageUrl);
      const thumbnail = image ? undefined : articleUrl(element.getAttribute('poster'), pageUrl);
      const url = source ?? thumbnail;
      if (!url) return;
      const kind = /\.gif$/i.test(new URL(url).pathname) || /[?&]format=gif(?:&|$)/i.test(url)
        ? 'gif' : image ? 'photo' : 'video';
      const alt = cleanText(element.getAttribute('alt'), 500);
      const media: MediaItem = { type: kind, url, thumbnail, alt };
      blocks.push({ kind: 'media', media, caption });
      return;
    }
    if (tag === 'a' || tag === 'iframe') {
      const url = articleUrl(element.getAttribute(tag === 'a' ? 'href' : 'src'), pageUrl);
      const label = cleanText(element.textContent || element.getAttribute('title'), 400);
      if (url) {
        const extension = /\.(gif|mp4|webm|png|jpe?g|webp)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
        if (extension) {
          const type = extension === 'gif' ? 'gif' : /mp4|webm/.test(extension) ? 'video' : 'photo';
          blocks.push({ kind: 'media', media: { type, url }, caption: caption ?? label });
        } else {
          blocks.push({ kind: tag === 'iframe' || element.closest('blockquote.twitter-tweet') ? 'embed' : 'link', url, text: label });
        }
      }
    }
    const heading = /^h[1-6]$/.test(tag);
    const textBlock = heading || element.matches('p, li, blockquote, pre, figcaption, [data-block="true"]');
    if (heading || (textBlock && !insideText)) {
      const text = cleanText(element.textContent);
      if (text) blocks.push({ kind: heading ? 'heading' : 'text', text });
    }
    for (const child of element.children) visit(child, insideText || textBlock);
  };
  for (const element of root.children) visit(element);
  return blocks;
}
