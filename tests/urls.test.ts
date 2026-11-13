import { describe, expect, it } from 'vitest';
import {
  buildListUrl,
  buildSearchQuery,
  buildSearchUrl,
  buildWindowUrl,
  extractListId,
  operationFromGraphqlUrl,
} from '../lib/x/urls';

describe('extractListId', () => {
  it('acepta un ID numérico', () => {
    expect(extractListId('123456789')).toBe('123456789');
  });

  it('extrae el ID de una URL de lista', () => {
    expect(extractListId('https://x.com/i/lists/987654321')).toBe('987654321');
    expect(extractListId('https://x.com/i/lists/987654321?foo=bar')).toBe('987654321');
    expect(extractListId('https://twitter.com/i/lists/42')).toBe('42');
  });

  it('extrae el ID de una consulta list:', () => {
    expect(extractListId('list:555 since:2026-11-01')).toBe('555');
  });

  it('devuelve null si no hay ID', () => {
    expect(extractListId('https://x.com/home')).toBeNull();
    expect(extractListId('')).toBeNull();
    expect(extractListId('list:abc')).toBeNull();
  });
});

describe('URLs de búsqueda', () => {
  const start = '2026-11-12T05:00:00.000Z';
  const end = '2026-11-13T05:00:00.000Z';

  it('construye la consulta con límites UTC', () => {
    expect(buildSearchQuery('42', start, end)).toBe(
      'list:42 since:2026-11-12_05:00:00_UTC until:2026-11-13_05:00:00_UTC',
    );
  });

  it('codifica la consulta en la URL de búsqueda live', () => {
    const url = new URL(buildSearchUrl('42', start, end));
    expect(url.origin).toBe('https://x.com');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe(
      'list:42 since:2026-11-12_05:00:00_UTC until:2026-11-13_05:00:00_UTC',
    );
    expect(url.searchParams.get('f')).toBe('live');
  });

  it('elige búsqueda o timeline según el modo de ventana', () => {
    expect(buildWindowUrl('42', start, end, 'search')).toContain('/search?q=');
    expect(buildWindowUrl('42', start, end, 'timeline')).toBe(buildListUrl('42'));
  });

  it('rechaza fechas inválidas', () => {
    expect(() => buildSearchQuery('42', 'no-es-fecha', end)).toThrow();
  });
});

describe('operationFromGraphqlUrl', () => {
  it('extrae el nombre de la operación de una URL de GraphQL', () => {
    expect(
      operationFromGraphqlUrl(
        'https://x.com/i/api/graphql/AbCdEf/SearchTimeline?variables=%7B%7D&features=%7B%7D',
      ),
    ).toBe('SearchTimeline');
    expect(
      operationFromGraphqlUrl('https://x.com/i/api/graphql/xyz/ListLatestTweetsTimeline'),
    ).toBe('ListLatestTweetsTimeline');
  });

  it('devuelve null si no es una URL de GraphQL', () => {
    expect(operationFromGraphqlUrl('https://x.com/home')).toBeNull();
  });

  it('decodifica nombres codificados', () => {
    expect(operationFromGraphqlUrl('https://x.com/i/api/graphql/abc/Search%20Timeline')).toBe(
      'Search Timeline',
    );
  });
});
