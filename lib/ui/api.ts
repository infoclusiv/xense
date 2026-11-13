import type { RunStatus } from '../types';

export async function bg<T = any>(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  let response: any;
  try {
    response = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    if (String(error).includes('Extension context invalidated')) {
      throw new Error('La extensión se recargó. Cierra y vuelve a abrir el panel.');
    }
    throw error;
  }
  if (!response) throw new Error('No hubo respuesta de la extensión.');
  if (response.ok === false) throw new Error(response.error || 'La operación falló.');
  return response as T;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'starting':
      return 'Preparando';
    case 'running':
      return 'Recolectando';
    case 'paused':
      return 'Pausada';
    case 'navigating':
      return 'Cambiando ventana';
    case 'completed':
      return 'Completada';
    case 'partial':
      return 'Con avisos';
    case 'failed':
      return 'Fallida';
    case 'cancelled':
      return 'Cancelada';
    default:
      return status;
  }
}

export function statusTone(status: RunStatus): string {
  switch (status) {
    case 'running':
    case 'starting':
      return 'status-running';
    case 'paused':
    case 'navigating':
      return 'status-paused';
    case 'completed':
      return 'status-ok';
    case 'partial':
      return 'status-warn';
    case 'failed':
      return 'status-error';
    case 'cancelled':
      return 'status-muted';
    default:
      return 'status-muted';
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function isActiveStatus(status: RunStatus): boolean {
  return ['starting', 'running', 'paused', 'navigating'].includes(status);
}

export function shortRunDate(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString('es');
  }
}
