import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatLocalDateTime } from '../../lib/dates/parse';
import {
  buildAiDigest,
  buildCsvExport,
  buildJsonExport,
  buildMarkdownExport,
  buildNdjsonExport,
  copyToClipboard,
  downloadTextFile,
  exportBaseName,
} from '../../lib/export/exporters';
import type { NormalizedPost, PostType, RunData } from '../../lib/types';
import {
  bg,
  getErrorMessage,
  isActiveStatus,
  statusLabel,
  statusTone,
} from '../../lib/ui/api';

type TypeFilter = 'all' | PostType;
type SortOrder = 'newest' | 'oldest';
type Notice = { tone: 'success' | 'info' | 'error'; text: string };

const TYPE_LABEL: Record<PostType, string> = {
  original: 'Original',
  reply: 'Respuesta',
  quote: 'Cita',
  repost: 'Repost',
};

const MODE_LABEL: Record<string, string> = {
  auto: 'Automático',
  search: 'Solo búsqueda',
  timeline: 'Solo timeline',
};

export default function App() {
  const runId = useMemo(() => new URLSearchParams(window.location.search).get('runId') ?? '', []);
  const [data, setData] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deleted, setDeleted] = useState(false);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sort, setSort] = useState<SortOrder>('newest');
  const [onlyMedia, setOnlyMedia] = useState(false);
  const [visibleCount, setVisibleCount] = useState(200);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const load = useCallback(
    async (silent = false) => {
      if (!runId) {
        setError('No se indicó qué recolección abrir. Vuelve al panel de Xense y abre los resultados desde allí.');
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const response = await bg<{ data: RunData }>('GET_RUN_DATA', { runId });
        setData(response.data);
        setError(null);
      } catch (loadError) {
        if (!silent) setError(getErrorMessage(loadError));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data) return;
    document.title = `Xense — ${data.run.config.listName}`;
  }, [data]);

  useEffect(() => {
    if (!data || !isActiveStatus(data.run.status) || deleted) return;
    const timer = window.setInterval(() => void load(true), 4000);
    return () => window.clearInterval(timer);
  }, [data, deleted, load]);

  useEffect(() => {
    const listener = (message: any) => {
      if (message?.run?.id && message.run.id !== runId) return;
      if (message?.type === 'RUN_UPDATED' || message?.type === 'RUN_FINISHED') {
        void load(true);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [load, runId]);

  useEffect(() => {
    setVisibleCount(200);
  }, [query, typeFilter, sort, onlyMedia]);

  const posts = data?.posts ?? [];
  const timezone = data?.run.config.range.timezone ?? 'UTC';

  const filteredPosts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const result = posts.filter((post) => {
      if (typeFilter !== 'all' && post.type !== typeFilter) return false;
      if (onlyMedia && post.media.length === 0) return false;
      if (!needle) return true;
      const haystack = [
        post.text,
        post.author.name,
        post.author.handle,
        post.quoted?.text ?? '',
        post.quoted?.handle ?? '',
        ...post.hashtags,
        ...post.mentions,
        ...post.urls,
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(needle);
    });

    result.sort((a, b) =>
      sort === 'newest'
        ? b.createdAt.localeCompare(a.createdAt)
        : a.createdAt.localeCompare(b.createdAt),
    );
    return result;
  }, [onlyMedia, posts, query, sort, typeFilter]);

  const handleExport = (format: 'json' | 'csv' | 'md' | 'ndjson') => {
    if (!data) return;
    try {
      const base = exportBaseName(data);
      if (format === 'json') {
        downloadTextFile(`${base}.json`, buildJsonExport(data), 'application/json');
      } else if (format === 'csv') {
        downloadTextFile(`${base}.csv`, buildCsvExport(data), 'text/csv');
      } else if (format === 'md') {
        downloadTextFile(`${base}.md`, buildMarkdownExport(data), 'text/markdown');
      } else {
        downloadTextFile(`${base}.ndjson`, buildNdjsonExport(data), 'application/x-ndjson');
      }
      setNotice({ tone: 'success', text: `Exportación ${format.toUpperCase()} descargada.` });
    } catch (exportError) {
      setNotice({ tone: 'error', text: `No se pudo exportar: ${getErrorMessage(exportError)}` });
    }
  };

  const handleCopyDigest = async () => {
    if (!data) return;
    try {
      await copyToClipboard(buildAiDigest(data));
      setCopyState('copied');
      setNotice({
        tone: 'success',
        text: 'Digest copiado. Pégalo en tu herramienta de IA como contexto.',
      });
      window.setTimeout(() => setCopyState('idle'), 2500);
    } catch (copyError) {
      setCopyState('error');
      setNotice({ tone: 'error', text: `No se pudo copiar: ${getErrorMessage(copyError)}` });
    }
  };

  const handleDelete = async () => {
    if (!runId) return;
    if (
      !window.confirm(
        '¿Eliminar esta recolección y todos sus posts guardados? Esta acción no se puede deshacer.',
      )
    ) {
      return;
    }
    try {
      await bg('DELETE_RUN', { runId });
      setData(null);
      setDeleted(true);
      setNotice({ tone: 'success', text: 'Recolección eliminada de este navegador.' });
    } catch (deleteError) {
      setNotice({ tone: 'error', text: getErrorMessage(deleteError) });
    }
  };

  const maxDay = data ? Math.max(1, ...data.stats.days.map((day) => day.count)) : 1;
  const visiblePosts = filteredPosts.slice(0, visibleCount);

  if (loading) {
    return (
      <div className="dashboard">
        <div className="loading-state full-page">
          <span className="spinner" />
          Cargando resultados…
        </div>
      </div>
    );
  }

  if (deleted) {
    return (
      <div className="dashboard">
        <div className="full-page empty-state">
          <div className="empty-icon">◎</div>
          <h1>Recolección eliminada</h1>
          <p className="hint">Los datos de esta recolección ya no están en el navegador.</p>
          <button className="btn btn-secondary" onClick={() => window.close()}>
            Cerrar pestaña
          </button>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="dashboard">
        <div className="full-page">
          <div className="card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Xense</span>
                <h2>No se pudieron abrir los resultados</h2>
              </div>
            </div>
            <p className="field-error">{error ?? 'No hay datos disponibles.'}</p>
            <div className="button-row">
              <button className="btn btn-primary" onClick={() => void load()}>
                Reintentar
              </button>
              <button className="btn btn-ghost" onClick={() => window.close()}>
                Cerrar pestaña
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { run, stats } = data;

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="dash-brand">
          <span className="brand-mark">X</span>
          <div className="dash-title">
            <span className="eyebrow">Xense · Resultados</span>
            <h1>{run.config.listName}</h1>
            <div className="dash-meta">
              <span className={`status-chip ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
              {run.config.origin === 'continuation' && (
                <span className="badge badge-continuation">Novedades</span>
              )}
              <span>{run.config.range.label}</span>
              <span>{timezone}</span>
            </div>
          </div>
        </div>
        <div className="dash-actions">
          <button className="btn btn-small btn-ghost" onClick={() => void load()}>
            Actualizar
          </button>
          <button className="btn btn-small btn-ghost" onClick={() => window.close()}>
            Cerrar
          </button>
        </div>
      </header>

      <main className="dash-main">
        {notice && (
          <div className={`alert alert-${notice.tone}`} role="status">
            <span>{notice.text}</span>
            <button className="alert-close" onClick={() => setNotice(null)} aria-label="Cerrar">
              ×
            </button>
          </div>
        )}

        {isActiveStatus(run.status) && (
          <div className="alert alert-info">
            <span>
              La recolección sigue en curso ({run.progress.message}). Esta página se actualiza sola.
            </span>
          </div>
        )}

        <section className="stat-cards" aria-label="Resumen">
          <div className="stat-card">
            <strong>{stats.total.toLocaleString('es')}</strong>
            <span>posts</span>
          </div>
          <div className="stat-card">
            <strong>{stats.authors.toLocaleString('es')}</strong>
            <span>autores</span>
          </div>
          <div className="stat-card">
            <strong>{stats.byType.original.toLocaleString('es')}</strong>
            <span>originales</span>
          </div>
          <div className="stat-card">
            <strong>
              {(stats.byType.reply + stats.byType.quote).toLocaleString('es')}
            </strong>
            <span>respuestas y citas</span>
          </div>
          <div className="stat-card">
            <strong>{stats.byType.repost.toLocaleString('es')}</strong>
            <span>reposts</span>
          </div>
          <div className="stat-card">
            <strong>{run.windows.length.toLocaleString('es')}</strong>
            <span>ventanas</span>
          </div>
        </section>

        <section className="card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Exportar</span>
              <h2>Datos listos para analizar</h2>
            </div>
          </div>
          <div className="export-grid">
            <button className="btn btn-primary" onClick={() => void handleCopyDigest()}>
              {copyState === 'copied' ? '✓ Digest copiado' : 'Copiar digest para IA'}
            </button>
            <button className="btn btn-secondary" onClick={() => handleExport('json')}>
              JSON
            </button>
            <button className="btn btn-secondary" onClick={() => handleExport('csv')}>
              CSV
            </button>
            <button className="btn btn-secondary" onClick={() => handleExport('md')}>
              Markdown
            </button>
            <button className="btn btn-secondary" onClick={() => handleExport('ndjson')}>
              NDJSON
            </button>
          </div>
          <p className="hint">
            Esta vista muestra {filteredPosts.length.toLocaleString('es')} de{' '}
            {stats.total.toLocaleString('es')} posts. Las exportaciones incluyen siempre el total
            recolectado, no el filtro de esta vista. El digest está pensado para pegarse en un chat
            de IA.
          </p>
        </section>

        <div className="dash-columns">
          <section className="card chart-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Distribución</span>
                <h2>Posts por día</h2>
              </div>
              <span className="hint">
                {stats.days.length} {stats.days.length === 1 ? 'día' : 'días'}
              </span>
            </div>
            {stats.days.length === 0 ? (
              <p className="hint">No hay datos para graficar.</p>
            ) : (
              <div className="day-bars">
                {stats.days.map((day) => (
                  <div className="day-bar" key={day.day} title={`${day.day}: ${day.count} posts`}>
                    <span className="day-bar-count">{day.count}</span>
                    <div className="day-bar-track">
                      <div
                        className="day-bar-fill"
                        style={{ height: `${Math.max(3, Math.round((day.count / maxDay) * 100))}%` }}
                      />
                    </div>
                    <span className="day-bar-label">{day.day?.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Voces</span>
                <h2>Autores más activos</h2>
              </div>
            </div>
            {stats.topAuthors.length === 0 ? (
              <p className="hint">Sin autores.</p>
            ) : (
              <ol className="author-list">
                {stats.topAuthors.map((author, index) => (
                  <li key={author.handle}>
                    <span className="author-rank">{index + 1}</span>
                    <span className="author-name">
                      <strong>{author.name}</strong>
                      <span className="hint">@{author.handle}</span>
                    </span>
                    <span className="author-count">{author.count}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <details className="card options-card run-details">
          <summary>
            <span>Detalles de la recolección</span>
            <span className="summary-hint">Rango, ventanas y diagnóstico</span>
          </summary>
          <div className="detail-grid">
            <div>
              <span>Rango</span>
              <strong>{run.config.range.label}</strong>
            </div>
            <div>
              <span>Desde</span>
              <strong>{formatLocalDateTime(run.config.range.start, timezone)}</strong>
            </div>
            <div>
              <span>Hasta</span>
              <strong>{formatLocalDateTime(run.config.range.end, timezone)} (exclusivo)</strong>
            </div>
            <div>
              <span>Modo</span>
              <strong>{MODE_LABEL[run.config.mode] ?? run.config.mode}</strong>
            </div>
            <div>
              <span>Origen</span>
              <strong>
                {run.config.origin === 'continuation' ? 'Novedades' : 'Rango personalizado'}
              </strong>
            </div>
            <div>
              <span>Ventanas completadas</span>
              <strong>
                {run.windows.filter((window) => window.status === 'done').length} /{' '}
                {run.windows.length}
              </strong>
            </div>
            <div>
              <span>Creada</span>
              <strong>{formatLocalDateTime(run.createdAt, timezone)}</strong>
            </div>
          </div>
          {run.errors.length > 0 && (
            <div className="alert alert-error compact">
              {run.errors.map((message, index) => (
                <span key={`${message}-${index}`}>{message}</span>
              ))}
            </div>
          )}
          {run.diagnostics.length > 0 && (
            <details className="diagnostics">
              <summary>Diagnóstico ({run.diagnostics.length})</summary>
              <ul>
                {run.diagnostics.slice(-30).map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className={`diag-${entry.level}`}>
                    {entry.operation ? `${entry.operation}: ` : ''}
                    {entry.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </details>

        <section className="results-section">
          <div className="results-head">
            <div>
              <span className="eyebrow">Contenido</span>
              <h2>Posts recolectados</h2>
            </div>
            <span className="results-count">
              {filteredPosts.length.toLocaleString('es')} en vista
            </span>
          </div>

          <div className="card filter-card">
            <div className="filters-row">
              <label className="filter-field grow">
                Buscar
                <input
                  className="input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Texto, autor, hashtag, enlace…"
                />
              </label>
              <label className="filter-field">
                Tipo
                <select
                  className="input"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
                >
                  <option value="all">Todos</option>
                  <option value="original">Originales</option>
                  <option value="reply">Respuestas</option>
                  <option value="quote">Citas</option>
                  <option value="repost">Reposts</option>
                </select>
              </label>
              <label className="filter-field">
                Orden
                <select
                  className="input"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortOrder)}
                >
                  <option value="newest">Más recientes primero</option>
                  <option value="oldest">Más antiguos primero</option>
                </select>
              </label>
              <label className="toggle filter-toggle">
                <input
                  type="checkbox"
                  checked={onlyMedia}
                  onChange={(event) => setOnlyMedia(event.target.checked)}
                />
                <span>Solo con media</span>
              </label>
            </div>
          </div>

          {filteredPosts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">◎</div>
              <p>No hay posts que coincidan con el filtro.</p>
              <p className="hint">Prueba a limpiar la búsqueda o cambiar el tipo.</p>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setQuery('');
                  setTypeFilter('all');
                  setOnlyMedia(false);
                }}
              >
                Limpiar filtros
              </button>
            </div>
          ) : (
            <>
              <div className="post-list">
                {visiblePosts.map((post) => (
                  <PostCard key={post.id} post={post} timezone={timezone} />
                ))}
              </div>
              {visibleCount < filteredPosts.length && (
                <button
                  className="btn btn-secondary btn-block"
                  onClick={() => setVisibleCount((count) => count + 200)}
                >
                  Mostrar más ({Math.min(200, filteredPosts.length - visibleCount)} de{' '}
                  {(filteredPosts.length - visibleCount).toLocaleString('es')} restantes)
                </button>
              )}
            </>
          )}
        </section>

        <section className="card danger-zone">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Datos locales</span>
              <h2>Eliminar esta recolección</h2>
            </div>
          </div>
          <p className="hint">
            Borra esta recolección y sus {stats.total.toLocaleString('es')} posts de IndexedDB en
            este navegador. No afecta a tu cuenta de X.
          </p>
          <button className="btn btn-danger" onClick={() => void handleDelete()}>
            Eliminar recolección
          </button>
        </section>
      </main>
    </div>
  );
}

function PostCard({ post, timezone }: { post: NormalizedPost; timezone: string }) {
  return (
    <article className="post-card">
      <div className="post-head">
        <div className="post-avatar" aria-hidden="true">
          {initials(post.author.name, post.author.handle)}
        </div>
        <div className="post-author">
          <div className="post-author-line">
            <strong>{post.author.name}</strong>
            {post.author.verified && (
              <span className="verified" title="Cuenta verificada">
                ✓
              </span>
            )}
            <span className="hint">@{post.author.handle}</span>
          </div>
          <div className="post-subline">
            <span>{formatLocalDateTime(post.createdAt, timezone)}</span>
            <span className={`post-type type-${post.type}`}>{TYPE_LABEL[post.type]}</span>
            {post.isReply && post.replyToHandle && (
              <span className="hint">en respuesta a @{post.replyToHandle}</span>
            )}
            {post.isRepost && post.repostedBy && (
              <span className="hint">reposteado por @{post.repostedBy.handle}</span>
            )}
          </div>
        </div>
      </div>

      {post.originalCreatedAt && (
        <p className="post-original-date">
          Publicado originalmente: {formatLocalDateTime(post.originalCreatedAt, timezone)}
        </p>
      )}

      {post.text && <p className="post-text">{post.text}</p>}

      {post.quoted && (
        <blockquote className="post-quote">
          <div className="post-quote-head">
            <strong>{post.quoted.name ?? 'Cita'}</strong>
            {post.quoted.handle && <span>@{post.quoted.handle}</span>}
            {post.quoted.createdAt && (
              <span className="hint">{formatLocalDateTime(post.quoted.createdAt, timezone)}</span>
            )}
          </div>
          <p>{post.quoted.text || '[sin texto]'}</p>
          {post.quoted.permalink && (
            <a href={post.quoted.permalink} target="_blank" rel="noreferrer">
              Ver post citado
            </a>
          )}
        </blockquote>
      )}

      {post.media.length > 0 && (
        <div className="post-media">
          {post.media.map((item, index) => (
            <a
              key={`${item.url}-${index}`}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              title={item.alt || item.type}
            >
              <img src={item.thumbnail ?? item.url} alt={item.alt ?? `Media ${index + 1}`} loading="lazy" />
              {item.type !== 'photo' && <span className="media-badge">{item.type}</span>}
            </a>
          ))}
        </div>
      )}

      {(post.hashtags.length > 0 || post.mentions.length > 0) && (
        <div className="post-tags">
          {post.hashtags.map((tag) => (
            <span key={`tag-${tag}`}>#{tag}</span>
          ))}
          {post.mentions.map((mention) => (
            <span key={`mention-${mention}`}>@{mention}</span>
          ))}
        </div>
      )}

      <div className="post-footer">
        <div className="post-metrics" aria-label="Métricas">
          <span title="Me gusta">❤️ {formatMetric(post.metrics.likes)}</span>
          <span title="Reposts">🔁 {formatMetric(post.metrics.reposts)}</span>
          <span title="Respuestas">💬 {formatMetric(post.metrics.replies)}</span>
          <span title="Citas">💭 {formatMetric(post.metrics.quotes)}</span>
          <span title="Vistas">👁️ {formatMetric(post.metrics.views)}</span>
        </div>
        <a className="post-link" href={post.permalink} target="_blank" rel="noreferrer">
          Ver en X ↗
        </a>
      </div>
    </article>
  );
}

function initials(name: string, handle: string): string {
  const source = name.trim() || handle;
  return (
    source
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

function formatMetric(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.0', '')} M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace('.0', '')} mil`;
  return String(value);
}
