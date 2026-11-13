const LIST_ID_PATTERNS = [
  /(?:^|\/)i\/lists\/(\d+)/i,
  /(?:^|\/)lists\/(\d+)/i,
  /(?:^|\s)list:(\d+)/i,
  /[?&]list_id=(\d+)/i,
];

export function extractListId(input: string): string | null {
  const value = input.trim();
  if (/^\d+$/.test(value)) return value;
  for (const pattern of LIST_ID_PATTERNS) {
    const match = pattern.exec(value);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function buildListUrl(listId: string): string {
  return `https://x.com/i/lists/${encodeURIComponent(listId)}`;
}

function formatUtcBoundary(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha inválida: ${iso}`);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `_${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}_UTC`
  );
}

export function buildSearchQuery(listId: string, startIso: string, endIso: string): string {
  return `list:${listId} since:${formatUtcBoundary(startIso)} until:${formatUtcBoundary(endIso)}`;
}

export function buildSearchUrl(listId: string, startIso: string, endIso: string): string {
  const query = buildSearchQuery(listId, startIso, endIso);
  return `https://x.com/search?q=${encodeURIComponent(query).replace(/%20/g, '%20')}&src=typed_query&f=live`;
}

export function buildWindowUrl(
  listId: string,
  startIso: string,
  endIso: string,
  mode: 'search' | 'timeline',
): string {
  return mode === 'timeline' ? buildListUrl(listId) : buildSearchUrl(listId, startIso, endIso);
}

export function operationFromGraphqlUrl(url: string): string | null {
  const match = /\/i\/api\/graphql\/[^/]+\/([^/?#]+)/.exec(url);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
