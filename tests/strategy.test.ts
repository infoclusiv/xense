import { describe, expect, it } from 'vitest';
import {
  buildWindows,
  findWindowIndex,
  firstPendingWindowIndex,
  listPassCoveredIndices,
  listPassReachedStart,
  nextPendingWindowIndex,
  resolveStartStrategy,
} from '../lib/x/strategy';
import type { DateRangeInfo } from '../lib/types';

const START = '2026-11-10T05:00:00.000Z';
const END = '2026-11-13T05:00:00.000Z';

function makeRange(start = START, end = END): DateRangeInfo {
  return {
    start,
    end,
    timezone: 'UTC',
    expression: 'rango',
    label: 'Rango',
    partial: false,
    rolling: false,
  };
}

describe('estrategia inicial', () => {
  const now = new Date('2026-11-14T05:00:00.000Z');

  it('usa lista para rangos recientes en automático', () => {
    expect(resolveStartStrategy('auto', makeRange(), now)).toBe('list');
  });

  it('usa búsqueda para rangos antiguos en automático', () => {
    expect(resolveStartStrategy('auto', makeRange('2026-08-01T00:00:00.000Z'), now)).toBe(
      'search',
    );
  });

  it('usa búsqueda si el rango terminó hace varios días', () => {
    expect(
      resolveStartStrategy(
        'auto',
        makeRange('2026-11-01T00:00:00.000Z', '2026-11-05T00:00:00.000Z'),
        now,
      ),
    ).toBe('search');
  });

  it('respeta los modos explícitos', () => {
    expect(resolveStartStrategy('list', makeRange('2020-01-01T00:00:00.000Z'), now)).toBe('list');
    expect(resolveStartStrategy('search', makeRange(), now)).toBe('search');
  });
});

describe('ventanas diarias', () => {
  it('divide el rango en días consecutivos', () => {
    const windows = buildWindows(makeRange());
    expect(windows).toHaveLength(4);
    expect(windows[0]!.start).toBe(START);
    expect(windows[0]!.end).toBe('2026-11-11T00:00:00.000Z');
    expect(windows[3]!.end).toBe(END);
    expect(windows.every((window) => window.status === 'pending')).toBe(true);
  });

  it('encuentra la ventana que contiene cada fecha', () => {
    const windows = buildWindows(makeRange());
    expect(findWindowIndex(windows, Date.parse(START))).toBe(0);
    expect(findWindowIndex(windows, Date.parse('2026-11-12T00:00:00.000Z'))).toBe(2);
    expect(findWindowIndex(windows, Date.parse(END))).toBe(-1);
    expect(findWindowIndex(windows, Date.parse('2020-01-01T00:00:00.000Z'))).toBe(-1);
  });
});

describe('cobertura del recorrido de lista', () => {
  const windows = buildWindows(makeRange());

  it('marca como cubiertas las ventanas más nuevas que la fecha confirmada', () => {
    // La fecha confirmada cae dentro de la ventana 1: las ventanas 2 y 3 ya se recorrieron.
    expect(listPassCoveredIndices(windows, Date.parse('2026-11-11T12:00:00.000Z'))).toEqual([
      2, 3,
    ]);
  });

  it('marca todo cuando se alcanza el inicio del rango', () => {
    expect(listPassCoveredIndices(windows, Date.parse(START))).toEqual([0, 1, 2, 3]);
  });

  it('no marca nada si la fecha confirmada es más nueva que el rango', () => {
    expect(listPassCoveredIndices(windows, Date.parse('2026-11-14T00:00:00.000Z'))).toEqual([]);
  });

  it('exige margen bajo la fecha objetivo para confirmar el inicio', () => {
    const target = Date.parse(START);
    expect(listPassReachedStart(target - 1, target, 0)).toBe(true);
    expect(listPassReachedStart(target + 1, target, 0)).toBe(false);
    expect(listPassReachedStart(target, target, 60_000)).toBe(false);
    expect(listPassReachedStart(target - 60_000, target, 60_000)).toBe(true);
  });

  it('encuentra la siguiente ventana pendiente aunque haya huecos cubiertos', () => {
    const mixed = windows.map((window, index) => ({
      ...window,
      status: index === 1 ? ('pending' as const) : ('done' as const),
    }));
    expect(firstPendingWindowIndex(mixed)).toBe(1);
    expect(nextPendingWindowIndex(mixed, 1)).toBe(-1);
  });
});
