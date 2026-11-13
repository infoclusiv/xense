import { describe, expect, it } from 'vitest';
import {
  DateParseError,
  parseDateExpression,
  parseExplicitDateRange,
} from '../lib/dates/parse';

const NOW_UTC = new Date('2026-11-13T15:00:00.000Z');
const NOW_BOGOTA = new Date('2026-11-13T15:00:00.000Z'); // 10:00 en America/Bogota

describe('parseDateExpression — expresiones relativas', () => {
  it('interpreta “ayer” como el día completo en la zona local', () => {
    const range = parseDateExpression('ayer', 'America/Bogota', NOW_BOGOTA);

    expect(range.start).toBe('2026-11-12T05:00:00.000Z');
    expect(range.end).toBe('2026-11-13T05:00:00.000Z');
    expect(range.label).toBe('Ayer');
    expect(range.partial).toBe(false);
    expect(range.timezone).toBe('America/Bogota');
  });

  it('interpreta “hoy” como un rango parcial hasta el momento actual', () => {
    const range = parseDateExpression('hoy', 'UTC', NOW_UTC);

    expect(range.start).toBe('2026-11-13T00:00:00.000Z');
    expect(range.end).toBe('2026-11-13T15:00:00.000Z');
    expect(range.partial).toBe(true);
    expect(range.label).toContain('Hoy');
  });

  it('interpreta “ayer y hoy” sin solaparse con el futuro', () => {
    const range = parseDateExpression('ayer y hoy', 'UTC', NOW_UTC);

    expect(range.start).toBe('2026-11-12T00:00:00.000Z');
    expect(range.end).toBe('2026-11-13T15:00:00.000Z');
    expect(range.partial).toBe(true);
  });

  it('interpreta “últimos 7 días” como ventana móvil', () => {
    const range = parseDateExpression('últimos 7 días', 'UTC', NOW_UTC);

    expect(range.start).toBe('2026-11-06T15:00:00.000Z');
    expect(range.end).toBe('2026-11-13T15:00:00.000Z');
    expect(range.rolling).toBe(true);
    expect(range.label).toBe('Últimos 7 días');
  });

  it('interpreta “semana pasada” de lunes a domingo', () => {
    const range = parseDateExpression('semana pasada', 'UTC', NOW_UTC);

    expect(range.start).toBe('2026-11-02T00:00:00.000Z');
    expect(range.end).toBe('2026-11-09T00:00:00.000Z');
    expect(range.label).toBe('Semana pasada');
  });

  it('acepta tildes ausentes y mayúsculas', () => {
    const range = parseDateExpression('AYER', 'America/Bogota', NOW_BOGOTA);
    expect(range.start).toBe('2026-11-12T05:00:00.000Z');
  });

  it('limpia prefijos conversacionales', () => {
    const range = parseDateExpression(
      'Xense, obtén los posts de ayer por favor',
      'UTC',
      NOW_UTC,
    );
    expect(range.start).toBe('2026-11-12T00:00:00.000Z');
    expect(range.end).toBe('2026-11-13T00:00:00.000Z');
  });
});

describe('parseDateExpression — fechas explícitas y rangos', () => {
  it('interpreta un rango con guion y mes abreviado', () => {
    const range = parseDateExpression('1–10 nov 2026', 'UTC', NOW_UTC);

    expect(range.start).toBe('2026-11-01T00:00:00.000Z');
    expect(range.end).toBe('2026-11-11T00:00:00.000Z');
    expect(range.label).toBe('1 nov 2026 – 10 nov 2026');
  });

  it('interpreta “del 1 al 10 de noviembre de 2026”', () => {
    const range = parseDateExpression('del 1 al 10 de noviembre de 2026', 'UTC', NOW_UTC);

    expect(range.start).toBe('2026-11-01T00:00:00.000Z');
    expect(range.end).toBe('2026-11-11T00:00:00.000Z');
  });

  it('hereda el mes del final cuando el inicio solo indica el día', () => {
    const range = parseDateExpression('1–10 nov 2026', 'UTC', NOW_UTC);
    expect(range.label).toBe('1 nov 2026 – 10 nov 2026');
  });

  it('resuelve un rango que cruza el cambio de año', () => {
    const range = parseDateExpression('28 dic – 2 ene', 'UTC', NOW_UTC);

    expect(range.start).toBe('2025-12-28T00:00:00.000Z');
    expect(range.end).toBe('2026-01-03T00:00:00.000Z');
  });

  it('interpreta un mes completo cuando ya terminó', () => {
    const range = parseDateExpression(
      'noviembre 2026',
      'UTC',
      new Date('2026-12-05T12:00:00.000Z'),
    );

    expect(range.start).toBe('2026-11-01T00:00:00.000Z');
    expect(range.end).toBe('2026-12-01T00:00:00.000Z');
    expect(range.label).toBe('noviembre de 2026');
    expect(range.partial).toBe(false);
  });

  it('interpreta una fecha ISO suelta', () => {
    const range = parseDateExpression('2026-10-31', 'UTC', NOW_UTC);

    expect(range.start).toBe('2026-10-31T00:00:00.000Z');
    expect(range.end).toBe('2026-11-01T00:00:00.000Z');
  });

  it('elige el año anterior si la fecha sin año aún no ha ocurrido', () => {
    const range = parseDateExpression('25 dic', 'UTC', NOW_UTC);

    expect(range.start).toBe('2025-12-25T00:00:00.000Z');
    expect(range.end).toBe('2025-12-26T00:00:00.000Z');
  });
});

describe('parseExplicitDateRange — zonas horarias y DST', () => {
  it('respeta la duración real de un día con cambio de horario (23 h)', () => {
    const range = parseExplicitDateRange(
      '2026-03-08',
      '2026-03-08',
      'America/New_York',
      new Date('2026-03-10T16:00:00.000Z'),
    );

    expect(range.start).toBe('2026-03-08T05:00:00.000Z');
    expect(range.end).toBe('2026-03-09T04:00:00.000Z');
    expect(Date.parse(range.end) - Date.parse(range.start)).toBe(23 * 60 * 60 * 1000);
  });

  it('respeta un día normal de 24 h', () => {
    const range = parseExplicitDateRange('2026-11-12', '2026-11-12', 'America/Bogota', NOW_UTC);

    expect(Date.parse(range.end) - Date.parse(range.start)).toBe(24 * 60 * 60 * 1000);
  });

  it('recorta el final si el rango incluye hoy', () => {
    const range = parseExplicitDateRange('2026-11-12', '2026-11-13', 'UTC', NOW_UTC);

    expect(range.start).toBe('2026-11-12T00:00:00.000Z');
    expect(range.end).toBe('2026-11-13T15:00:00.000Z');
    expect(range.partial).toBe(true);
  });

  it('rechaza una fecha inexistente', () => {
    expect(() => parseDateExpression('31 feb 2026', 'UTC', NOW_UTC)).toThrow(DateParseError);
  });

  it('rechaza un rango invertido', () => {
    expect(() =>
      parseExplicitDateRange('2026-11-10', '2026-11-01', 'UTC', NOW_UTC),
    ).toThrow(/anterior/);
  });

  it('rechaza una fecha de fin futura en el calendario', () => {
    expect(() =>
      parseExplicitDateRange('2026-11-12', '2026-11-14', 'UTC', NOW_UTC),
    ).toThrow(/futuro/);
  });

  it('rechaza fechas futuras', () => {
    expect(() => parseDateExpression('1 ene 2030', 'UTC', NOW_UTC)).toThrow(/futuro/);
  });

  it('rechaza una expresión vacía', () => {
    expect(() => parseDateExpression('   ', 'UTC', NOW_UTC)).toThrow(DateParseError);
  });
});
