import { describe, expect, it } from 'vitest';
import {
  HUMANIZE_PROFILES,
  humanizeProfile,
  humanizedDelay,
  nextBlankClickDelay,
  planBoundary,
  planPointerPath,
  planReadingPause,
  planScrollStep,
  randomBetween,
} from '../lib/x/humanize';

function seeded(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0.5;
    index += 1;
    return value;
  };
}

describe('perfiles de humanización', () => {
  it('desactiva todo en el nivel off', () => {
    const profile = humanizeProfile('off');
    expect(profile.enabled).toBe(false);
    expect(profile.blankClickBudget).toBe(0);
    expect(planReadingPause(profile)).toBe(0);
    expect(nextBlankClickDelay(profile)).toBe(Number.POSITIVE_INFINITY);
    expect(planBoundary(profile)).toEqual({ marginMs: 0, requiredStreak: 2 });
  });

  it('escala las pausas y los límites por nivel', () => {
    expect(HUMANIZE_PROFILES.light.blankClickBudget).toBeLessThan(
      HUMANIZE_PROFILES.careful.blankClickBudget,
    );
    expect(HUMANIZE_PROFILES.careful.delayScale).toBeGreaterThan(
      HUMANIZE_PROFILES.light.delayScale,
    );
    expect(humanizeProfile(undefined).level).toBe('off');
  });
});

describe('planificación del scroll', () => {
  it('nunca supera el recorrido restante', () => {
    const profile = humanizeProfile('balanced');
    const step = planScrollStep(700, 120, profile, seeded([0.9, 0.5, 0.5]));
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(120);
  });

  it('devuelve 0 cuando ya no queda recorrido', () => {
    expect(planScrollStep(700, 0, humanizeProfile('balanced'))).toBe(0);
  });

  it('varía el avance entre pasos', () => {
    const profile = humanizeProfile('balanced');
    const small = planScrollStep(700, 10_000, profile, seeded([0.01, 0.1, 0.5]));
    const large = planScrollStep(700, 10_000, profile, seeded([0.99, 0.99, 0.5]));
    expect(large).toBeGreaterThan(small);
  });
});

describe('pausas y clics', () => {
  it('produce pausas de lectura solo cuando el perfil lo permite', () => {
    const profile = humanizeProfile('balanced');
    expect(planReadingPause(profile, seeded([0.99]))).toBe(0);
    const pause = planReadingPause(profile, seeded([0.01, 0.5]));
    expect(pause).toBeGreaterThanOrEqual(profile.readingPauseMinMs);
    expect(pause).toBeLessThanOrEqual(profile.readingPauseMaxMs);
  });

  it('calcula un margen de frontera y una racha de confirmación', () => {
    const plan = planBoundary(humanizeProfile('balanced'), seeded([0.4, 0.9]));
    expect(plan.marginMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(plan.marginMs).toBeLessThanOrEqual(120 * 60_000);
    expect(plan.requiredStreak).toBeGreaterThanOrEqual(2);
    expect(plan.requiredStreak).toBeLessThanOrEqual(3);
  });

  it('espacia los clics dentro del presupuesto', () => {
    const profile = humanizeProfile('careful');
    const delay = nextBlankClickDelay(profile, seeded([0.5]));
    expect(delay).toBeGreaterThanOrEqual(profile.blankClickMinMs);
    expect(delay).toBeLessThanOrEqual(profile.blankClickMaxMs);
  });

  it('genera enteros dentro del intervalo', () => {
    for (let index = 0; index < 20; index += 1) {
      const value = randomBetween(5, 9);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(9);
    }
    expect(randomBetween(5, 9, seeded([0.999]))).toBe(9);
  });
});

describe('trayectoria del puntero', () => {
  it('termina cerca del destino con varios pasos', () => {
    const path = planPointerPath({ x: 10, y: 10 }, { x: 300, y: 200 }, seeded([0.5]), 5);
    expect(path).toHaveLength(5);
    const last = path[path.length - 1]!;
    expect(Math.abs(last.x - 300)).toBeLessThanOrEqual(4);
    expect(Math.abs(last.y - 200)).toBeLessThanOrEqual(4);
  });
});
