import type { HumanizeLevel } from '../types';

export interface HumanizeProfile {
  level: HumanizeLevel;
  enabled: boolean;
  /** Multiplica las pausas configuradas entre scrolls. */
  delayScale: number;
  /** Probabilidad de una pausa larga de lectura tras un pequeño ráfaga. */
  readingPauseChance: number;
  readingPauseMinMs: number;
  readingPauseMaxMs: number;
  /** Fracción de la ventana visible que se avanza en cada paso. */
  scrollFractionMin: number;
  scrollFractionMax: number;
  /** Probabilidad de mover el puntero durante una pausa. */
  pointerMoveChance: number;
  blankClickMinMs: number;
  blankClickMaxMs: number;
  blankClickBudget: number;
  /** Margen extra bajo la fecha objetivo antes de detener el recorrido. */
  boundaryMarginMinMs: number;
  boundaryMarginMaxMs: number;
}

export interface Point {
  x: number;
  y: number;
}

const MINUTE = 60_000;

export const HUMANIZE_PROFILES: Record<HumanizeLevel, HumanizeProfile> = {
  off: {
    level: 'off',
    enabled: false,
    delayScale: 1,
    readingPauseChance: 0,
    readingPauseMinMs: 0,
    readingPauseMaxMs: 0,
    scrollFractionMin: 0.9,
    scrollFractionMax: 1,
    pointerMoveChance: 0,
    blankClickMinMs: 0,
    blankClickMaxMs: 0,
    blankClickBudget: 0,
    boundaryMarginMinMs: 0,
    boundaryMarginMaxMs: 0,
  },
  light: {
    level: 'light',
    enabled: true,
    delayScale: 1,
    readingPauseChance: 0.12,
    readingPauseMinMs: 900,
    readingPauseMaxMs: 2_400,
    scrollFractionMin: 0.55,
    scrollFractionMax: 0.95,
    pointerMoveChance: 0.25,
    blankClickMinMs: 60 * MINUTE,
    blankClickMaxMs: 150 * MINUTE,
    blankClickBudget: 3,
    boundaryMarginMinMs: 30 * MINUTE,
    boundaryMarginMaxMs: 60 * MINUTE,
  },
  balanced: {
    level: 'balanced',
    enabled: true,
    delayScale: 1.08,
    readingPauseChance: 0.22,
    readingPauseMinMs: 1_800,
    readingPauseMaxMs: 4_800,
    scrollFractionMin: 0.4,
    scrollFractionMax: 0.85,
    pointerMoveChance: 0.45,
    blankClickMinMs: 45 * MINUTE,
    blankClickMaxMs: 120 * MINUTE,
    blankClickBudget: 8,
    boundaryMarginMinMs: 30 * MINUTE,
    boundaryMarginMaxMs: 120 * MINUTE,
  },
  careful: {
    level: 'careful',
    enabled: true,
    delayScale: 1.3,
    readingPauseChance: 0.38,
    readingPauseMinMs: 3_200,
    readingPauseMaxMs: 8_000,
    scrollFractionMin: 0.3,
    scrollFractionMax: 0.7,
    pointerMoveChance: 0.65,
    blankClickMinMs: 30 * MINUTE,
    blankClickMaxMs: 90 * MINUTE,
    blankClickBudget: 14,
    boundaryMarginMinMs: 45 * MINUTE,
    boundaryMarginMaxMs: 150 * MINUTE,
  },
};

export function humanizeProfile(level: HumanizeLevel | undefined): HumanizeProfile {
  return HUMANIZE_PROFILES[level ?? 'off'] ?? HUMANIZE_PROFILES.off;
}

export function randomFloat(min: number, max: number, rng: () => number = Math.random): number {
  if (max <= min) return min;
  return min + rng() * (max - min);
}

export function randomBetween(min: number, max: number, rng: () => number = Math.random): number {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  if (high <= low) return low;
  return Math.floor(randomFloat(low, high + 1, rng));
}

export function humanizedDelay(
  baseMinMs: number,
  baseMaxMs: number,
  profile: HumanizeProfile,
  rng: () => number = Math.random,
): number {
  const base = randomBetween(baseMinMs, Math.max(baseMinMs + 1, baseMaxMs), rng);
  return Math.max(400, Math.round(base * profile.delayScale));
}

/** Avance de scroll en píxeles. Devuelve 0 si ya no queda recorrido. */
export function planScrollStep(
  viewportHeight: number,
  remaining: number,
  profile: HumanizeProfile,
  rng: () => number = Math.random,
): number {
  if (remaining <= 0 || viewportHeight <= 0) return 0;
  const small = rng() < 0.12;
  const fraction = small
    ? randomFloat(0.12, 0.3, rng)
    : randomFloat(profile.scrollFractionMin, profile.scrollFractionMax, rng);
  const jitter = randomFloat(0.92, 1.08, rng);
  return Math.max(32, Math.min(remaining, Math.round(viewportHeight * fraction * jitter)));
}

export function planReadingPause(
  profile: HumanizeProfile,
  rng: () => number = Math.random,
): number {
  if (!profile.enabled || profile.readingPauseChance <= 0) return 0;
  if (rng() >= profile.readingPauseChance) return 0;
  return randomBetween(profile.readingPauseMinMs, profile.readingPauseMaxMs, rng);
}

export function nextBlankClickDelay(
  profile: HumanizeProfile,
  rng: () => number = Math.random,
): number {
  if (!profile.enabled || profile.blankClickBudget <= 0) return Number.POSITIVE_INFINITY;
  return randomBetween(profile.blankClickMinMs, profile.blankClickMaxMs, rng);
}

export interface BoundaryPlan {
  marginMs: number;
  requiredStreak: number;
}

export function planBoundary(
  profile: HumanizeProfile,
  rng: () => number = Math.random,
): BoundaryPlan {
  if (!profile.enabled) return { marginMs: 0, requiredStreak: 2 };
  return {
    marginMs: randomBetween(
      profile.boundaryMarginMinMs,
      profile.boundaryMarginMaxMs,
      rng,
    ),
    requiredStreak: randomBetween(2, 3, rng),
  };
}

/** Curva suave con algo de ruido para que el puntero no salte en línea recta. */
export function planPointerPath(
  from: Point,
  to: Point,
  rng: () => number = Math.random,
  steps?: number,
): Point[] {
  const count = Math.max(2, steps ?? randomBetween(3, 6, rng));
  const controlX = (from.x + to.x) / 2 + randomFloat(-90, 90, rng);
  const controlY = (from.y + to.y) / 2 + randomFloat(-60, 60, rng);
  const path: Point[] = [];
  for (let index = 1; index <= count; index += 1) {
    const t = index / count;
    const oneMinus = 1 - t;
    const x = oneMinus * oneMinus * from.x + 2 * oneMinus * t * controlX + t * t * to.x;
    const y = oneMinus * oneMinus * from.y + 2 * oneMinus * t * controlY + t * t * to.y;
    path.push({
      x: Math.round(x + randomFloat(-3, 3, rng)),
      y: Math.round(y + randomFloat(-3, 3, rng)),
    });
  }
  return path;
}
