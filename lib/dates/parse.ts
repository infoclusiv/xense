import { DateTime } from 'luxon';
import { BROWSER_TIMEZONE } from '../defaults';
import type { DateRangeInfo } from '../types';

const MONTHS: Record<string, number> = {
  enero: 1,
  ene: 1,
  febrero: 2,
  feb: 2,
  marzo: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  jun: 6,
  julio: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  septiembre: 9,
  setiembre: 9,
  sept: 9,
  sep: 9,
  set: 9,
  octubre: 10,
  oct: 10,
  noviembre: 11,
  nov: 11,
  diciembre: 12,
  dic: 12,
};

const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export class DateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateParseError';
  }
}

export function normalizeTimezone(input: string | undefined | null): string {
  const candidate = (input ?? '').trim();
  if (!candidate) return BROWSER_TIMEZONE;
  try {
    return DateTime.now().setZone(candidate).isValid ? candidate : BROWSER_TIMEZONE;
  } catch {
    return BROWSER_TIMEZONE;
  }
}

export function getTimezoneOptions(): string[] {
  const zones = new Set<string>();
  zones.add('UTC');
  zones.add(BROWSER_TIMEZONE);
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    supported?.forEach((zone) => zones.add(zone));
  } catch {
    // Intl.supportedValuesOf is not available in every Chromium version.
  }
  return [...zones].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function cleanExpression(raw: string): string {
  let value = stripAccents(raw)
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  value = value.replace(/^(?:xense[,:\s]+|por favor[,:\s]+)/, '');
  value = value.replace(
    /^(?:analiza(?:r)?|analisis|obten(?:er)?|obtiene|recopila(?:r)?|recupera(?:r)?|descarga(?:r)?|busca(?:r)?|dame|muestra(?:me)?)\s+/,
    '',
  );
  value = value.replace(/^(?:la\s+)?informacion\s+(?:de\s+|del\s+)?/, '');
  value = value.replace(
    /^(?:los\s+|las\s+)?(?:posts?|tweets?|publicaciones?|mensajes?)\s+(?:de\s+|del\s+|que\s+)?/,
    '',
  );
  value = value.replace(/^del\s+dia\s+(?:de\s+)?/, '');
  value = value.replace(/^dia\s+(?:de\s+)?/, '');
  value = value.replace(/^(?:correspondientes?\s+)?(?:a|al)\s+/, '');
  value = value.replace(/^la\s+fecha\s+(?:de\s+)?/, '');
  value = value.replace(/\s+(?:por\s+favor|gracias)$/, '');
  value = value.replace(/[.?!,;]+$/g, '').trim();
  return value;
}

interface DateParts {
  day?: number;
  month?: number;
  year?: number;
}

function parseDatePart(raw: string): DateParts | null {
  let part = stripAccents(raw)
    .toLowerCase()
    .replace(/[.]/g, '')
    .trim();
  part = part.replace(/^(?:del|de|el|la)\s+/, '');
  part = part.replace(/\s+(?:de|del)$/, '');
  part = part.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(part);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  const numeric = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(part);
  if (numeric) {
    const rawYear = numeric[3];
    let year: number | undefined;
    if (rawYear) year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    return { day: Number(numeric[1]), month: Number(numeric[2]), year };
  }

  const dayMonthYear =
    /^(\d{1,2})(?:\s+de)?\s+([a-z]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?$/.exec(part);
  if (dayMonthYear) {
    const month = MONTHS[dayMonthYear[2] ?? ''];
    if (!month) return null;
    return {
      day: Number(dayMonthYear[1]),
      month,
      year: dayMonthYear[3] ? Number(dayMonthYear[3]) : undefined,
    };
  }

  const monthYear = /^([a-z]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?$/.exec(part);
  if (monthYear) {
    const month = MONTHS[monthYear[1] ?? ''];
    if (!month) return null;
    return { month, year: monthYear[2] ? Number(monthYear[2]) : undefined };
  }

  const dayOnly = /^(\d{1,2})$/.exec(part);
  if (dayOnly) return { day: Number(dayOnly[1]) };

  return null;
}

function splitRange(expression: string): [string, string] | null {
  const iso = /^(\d{4}-\d{1,2}-\d{1,2})\s*(?:al?|hasta|[-–—])\s*(\d{4}-\d{1,2}-\d{1,2})$/.exec(
    expression,
  );
  if (iso) return [iso[1]!, iso[2]!];

  const between = /^entre\s+(?:el\s+)?(.+?)\s+y\s+(?:el\s+)?(.+)$/.exec(expression);
  if (between) return [between[1]!, between[2]!];

  const withWord = /^(.+?)\s+(?:al|a|hasta)\s+(.+)$/.exec(expression);
  if (withWord) return [withWord[1]!, withWord[2]!];

  const isSingleNumericDate = /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(expression);
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(expression) && !isSingleNumericDate) {
    const withDash = /^(.+?)\s*[-–—]\s*(.+)$/.exec(expression);
    if (withDash) return [withDash[1]!, withDash[2]!];
  }

  return null;
}

function makeDate(parts: DateParts, zone: string): DateTime {
  if (parts.day == null || parts.month == null || parts.year == null) {
    throw new DateParseError('La fecha está incompleta. Indica día, mes y año.');
  }
  const date = DateTime.fromObject(
    { year: parts.year, month: parts.month, day: parts.day },
    { zone },
  );
  if (!date.isValid) {
    throw new DateParseError(
      `La fecha ${parts.day}/${parts.month}/${parts.year} no existe en el calendario.`,
    );
  }
  return date.startOf('day');
}

function formatDay(date: DateTime): string {
  return date.setLocale('es').toFormat('d MMM yyyy');
}

function formatRangeLabel(start: DateTime, lastDay: DateTime): string {
  if (start.hasSame(lastDay, 'day')) return formatDay(start);
  return `${formatDay(start)} – ${formatDay(lastDay)}`;
}

function resolveYear(
  parts: DateParts,
  other: DateParts,
  role: 'start' | 'end',
  currentYear: number,
): number {
  if (parts.year != null) return parts.year;
  if (other.year != null) {
    if (role === 'start' && parts.month != null && other.month != null && parts.month > other.month) {
      return other.year - 1;
    }
    if (role === 'end' && parts.month != null && other.month != null && parts.month < other.month) {
      return other.year + 1;
    }
    return other.year;
  }
  return currentYear;
}

function finishRange(
  start: DateTime,
  endDateInclusive: DateTime,
  zone: string,
  expression: string,
  now: DateTime,
  options: { partial?: boolean; rolling?: boolean; label?: string } = {},
): DateRangeInfo {
  const requestedLastDay = endDateInclusive.startOf('day');
  let endExclusive = requestedLastDay.plus({ days: 1 });
  let partial = options.partial ?? false;

  if (start.toMillis() > now.toMillis()) {
    throw new DateParseError('La fecha indicada está en el futuro. Elige una fecha pasada.');
  }

  let clampedToNow = false;
  if (endExclusive.toMillis() > now.toMillis()) {
    endExclusive = now;
    clampedToNow = true;
    partial = true;
  }

  if (endExclusive.toMillis() <= start.toMillis()) {
    throw new DateParseError('El rango termina antes de empezar.');
  }

  const labelLastDay = clampedToNow ? now.startOf('day') : requestedLastDay;

  return {
    start: start.toUTC().toISO()!,
    end: endExclusive.toUTC().toISO()!,
    timezone: zone,
    expression,
    label: options.label ?? formatRangeLabel(start, labelLastDay),
    partial,
    rolling: options.rolling ?? false,
  };
}

function rangeFromParts(
  startPart: DateParts,
  endPart: DateParts,
  zone: string,
  expression: string,
  now: DateTime,
): DateRangeInfo {
  const currentYear = now.year;
  const startFilled: DateParts = { ...startPart, month: startPart.month ?? endPart.month };
  const endFilled: DateParts = { ...endPart, month: endPart.month ?? startPart.month };
  const startYear = resolveYear(startFilled, endFilled, 'start', currentYear);
  let endYear = resolveYear(endFilled, startFilled, 'end', currentYear);

  if (
    startFilled.year == null &&
    endFilled.year == null &&
    startFilled.month != null &&
    endFilled.month != null &&
    endFilled.month < startFilled.month
  ) {
    // “28 dic – 2 ene” cruza el cambio de año.
    endYear = startYear + 1;
  } else if (
    endFilled.year == null &&
    startFilled.year != null &&
    startFilled.month != null &&
    endFilled.month != null &&
    endFilled.month < startFilled.month
  ) {
    // “28 dic 2025 – 2 ene” termina en enero del año siguiente.
    endYear = startFilled.year + 1;
  }

  const start = makeDate({ ...startFilled, year: startYear }, zone);
  const endDate = makeDate({ ...endFilled, year: endYear }, zone);

  if (endDate.toMillis() < start.toMillis()) {
    throw new DateParseError('El rango termina antes de empezar.');
  }

  let adjustedStart = start;
  let adjustedEndDate = endDate;
  if (startFilled.year == null && endFilled.year == null && start > now) {
    adjustedStart = start.minus({ years: 1 });
    adjustedEndDate = endDate.minus({ years: 1 });
  }

  return finishRange(adjustedStart, adjustedEndDate, zone, expression, now);
}

function parseSingleDate(parts: DateParts, zone: string, expression: string, now: DateTime): DateRangeInfo {
  // A month without a day means the full month.
  if (parts.day == null && parts.month != null) {
    let year = parts.year ?? now.year;
    let start = DateTime.fromObject({ year, month: parts.month, day: 1 }, { zone }).startOf('day');
    let endDate = start.endOf('month').startOf('day');
    if (parts.year == null && start > now) {
      year -= 1;
      start = DateTime.fromObject({ year, month: parts.month, day: 1 }, { zone }).startOf('day');
      endDate = start.endOf('month').startOf('day');
    }
    return finishRange(start, endDate, zone, expression, now, {
      label: start.setLocale('es').toFormat("MMMM 'de' yyyy"),
    });
  }

  if (parts.day == null || parts.month == null) {
    throw new DateParseError('La fecha está incompleta. Indica al menos el día y el mes.');
  }

  let year = parts.year ?? now.year;
  let start = makeDate({ ...parts, year }, zone);
  if (parts.year == null && start > now) {
    year -= 1;
    start = makeDate({ ...parts, year }, zone);
  }

  return finishRange(start, start, zone, expression, now, {
    label: formatDay(start),
  });
}

interface RollingMatch {
  amount: number;
  unit: 'hours' | 'days' | 'weeks' | 'months';
}

function matchRolling(expression: string): RollingMatch | null {
  const match =
    /^(?:(?:los|las)\s+)?(?:ultimas?|ultimos?)?\s*(\d+)\s+(horas?|h|dias?|d|semanas?|sem|meses?|mes)$/.exec(
      expression,
    );
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const rawUnit = match[2] ?? '';
  let unit: RollingMatch['unit'];
  if (rawUnit.startsWith('h')) unit = 'hours';
  else if (rawUnit.startsWith('sem')) unit = 'weeks';
  else if (rawUnit.startsWith('mes')) unit = 'months';
  else unit = 'days';
  return { amount, unit };
}

export function parseDateExpression(
  rawExpression: string,
  timezone: string,
  nowInput?: Date | DateTime,
): DateRangeInfo {
  const zone = normalizeTimezone(timezone);
  const now = (
    nowInput instanceof DateTime
      ? nowInput
      : nowInput
        ? DateTime.fromJSDate(nowInput)
        : DateTime.now()
  ).setZone(zone);
  const original = rawExpression.trim();
  const expression = cleanExpression(rawExpression);

  if (!expression) {
    throw new DateParseError(
      'Escribe una fecha o un rango. Ejemplos: “ayer”, “hoy”, “últimos 7 días”, “1–10 nov 2026”.',
    );
  }

  const todayStart = now.startOf('day');

  if (expression === 'hoy' || expression === 'el dia de hoy') {
    return {
      start: todayStart.toUTC().toISO()!,
      end: now.toUTC().toISO()!,
      timezone: zone,
      expression: original,
      label: 'Hoy (parcial)',
      partial: true,
      rolling: false,
    };
  }

  if (expression === 'ayer' || expression === 'el dia de ayer') {
    const start = todayStart.minus({ days: 1 });
    return finishRange(start, start, zone, original, now, { label: 'Ayer' });
  }

  if (expression === 'anteayer' || expression === 'antes de ayer') {
    const start = todayStart.minus({ days: 2 });
    return finishRange(start, start, zone, original, now, { label: 'Anteayer' });
  }

  if (expression === 'ayer y hoy' || expression === 'de ayer a hoy') {
    return finishRange(todayStart.minus({ days: 1 }), todayStart, zone, original, now, {
      label: 'Ayer y hoy (parcial)',
      partial: true,
    });
  }

  if (expression === 'esta semana' || expression === 'la semana actual') {
    const start = now.startOf('week');
    return finishRange(start, todayStart, zone, original, now, {
      label: 'Esta semana (parcial)',
      partial: true,
    });
  }

  if (expression === 'semana pasada' || expression === 'la semana pasada') {
    const thisWeek = now.startOf('week');
    return finishRange(thisWeek.minus({ weeks: 1 }), thisWeek.minus({ days: 1 }), zone, original, now, {
      label: 'Semana pasada',
    });
  }

  if (expression === 'este mes' || expression === 'el mes actual') {
    return finishRange(now.startOf('month'), todayStart, zone, original, now, {
      label: 'Este mes (parcial)',
      partial: true,
    });
  }

  if (expression === 'mes pasado' || expression === 'el mes pasado') {
    const thisMonth = now.startOf('month');
    return finishRange(thisMonth.minus({ months: 1 }), thisMonth.minus({ days: 1 }), zone, original, now, {
      label: 'Mes pasado',
    });
  }

  const rolling = matchRolling(expression);
  if (rolling) {
    const start = now.minus({ [rolling.unit]: rolling.amount });
    const label =
      rolling.unit === 'hours'
        ? `Últimas ${rolling.amount} horas`
        : rolling.unit === 'days'
          ? `Últimos ${rolling.amount} días`
          : rolling.unit === 'weeks'
            ? `Últimas ${rolling.amount} semanas`
            : `Últimos ${rolling.amount} meses`;
    return {
      start: start.toUTC().toISO()!,
      end: now.toUTC().toISO()!,
      timezone: zone,
      expression: original,
      label,
      partial: true,
      rolling: true,
    };
  }

  const range = splitRange(expression);
  if (range) {
    const startPart = parseDatePart(range[0]);
    const endPart = parseDatePart(range[1]);
    if (!startPart || !endPart) {
      throw new DateParseError(
        `No pude interpretar “${original}”. Prueba con “1–10 nov 2026” o “del 1 al 10 de noviembre de 2026”.`,
      );
    }
    if (startPart.day == null || endPart.day == null) {
      throw new DateParseError('En un rango debes indicar el día de inicio y el día de fin.');
    }
    return rangeFromParts(startPart, endPart, zone, original, now);
  }

  const parts = parseDatePart(expression);
  if (parts) {
    return parseSingleDate(parts, zone, original, now);
  }

  throw new DateParseError(
    `No pude interpretar “${original}”. Prueba con “ayer”, “hoy”, “últimos 7 días”, “12 nov 2026” o “1–10 nov 2026”.`,
  );
}

export function parseExplicitDateRange(
  startYmd: string,
  endYmd: string,
  timezone: string,
  nowInput?: Date | DateTime,
): DateRangeInfo {
  const zone = normalizeTimezone(timezone);
  const now = (
    nowInput instanceof DateTime
      ? nowInput
      : nowInput
        ? DateTime.fromJSDate(nowInput)
        : DateTime.now()
  ).setZone(zone);

  const start = DateTime.fromISO(startYmd, { zone }).startOf('day');
  const endDate = DateTime.fromISO(endYmd, { zone }).startOf('day');
  if (!start.isValid || !endDate.isValid) {
    throw new DateParseError('Indica una fecha de inicio y una de fin válidas.');
  }
  if (endDate.toMillis() < start.toMillis()) {
    throw new DateParseError('La fecha de fin no puede ser anterior a la de inicio.');
  }
  if (start.toMillis() > now.startOf('day').toMillis()) {
    throw new DateParseError('La fecha de inicio está en el futuro.');
  }
  if (endDate.toMillis() > now.startOf('day').toMillis()) {
    throw new DateParseError('La fecha de fin está en el futuro.');
  }

  return finishRange(start, endDate, zone, `${startYmd} → ${endYmd}`, now, {
    label: formatRangeLabel(start, endDate),
  });
}

export function dateInputValue(date: DateTime): string {
  return date.toISODate() ?? '';
}

export function todayInputValue(timezone: string): string {
  return dateInputValue(DateTime.now().setZone(normalizeTimezone(timezone)));
}

export function yesterdayInputValue(timezone: string): string {
  return dateInputValue(DateTime.now().setZone(normalizeTimezone(timezone)).minus({ days: 1 }));
}

export function formatLocalDateTime(iso: string, timezone: string): string {
  const date = DateTime.fromISO(iso, { setZone: true }).setZone(normalizeTimezone(timezone));
  if (!date.isValid) return iso;
  return date.setLocale('es').toFormat('d MMM yyyy, HH:mm');
}

export function formatDateForInput(iso: string, timezone: string): string {
  const date = DateTime.fromISO(iso, { setZone: true }).setZone(normalizeTimezone(timezone));
  return date.toISODate() ?? '';
}

export function getMonthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? '';
}
