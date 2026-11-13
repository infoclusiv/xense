import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BROWSER_TIMEZONE, DEFAULT_SETTINGS, LAST_LIST_KEY } from '../../lib/defaults';
import {
  formatLocalDateTime,
  getTimezoneOptions,
  parseDateExpression,
  parseExplicitDateRange,
  yesterdayInputValue,
} from '../../lib/dates/parse';
import { getWindowProgress } from '../../lib/runs';
import { buildContinuationRange } from '../../lib/tracking';
import type {
  BootstrapData,
  DateRangeInfo,
  ListInfo,
  ListTracking,
  RunRecord,
  RunSummary,
  ScrapeConfig,
  Settings,
  StorageInfo,
} from '../../lib/types';
import {
  bg,
  formatBytes,
  getErrorMessage,
  isActiveStatus,
  shortRunDate,
  statusLabel,
  statusTone,
} from '../../lib/ui/api';

type Tab = 'collect' | 'history' | 'settings';
type Notice = { tone: 'success' | 'info' | 'error'; text: string };
type RangeResult = { range: DateRangeInfo | null; error: string | null };
type StorageCounts = { lists: number; runs: number; posts: number };

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [lists, setLists] = useState<ListInfo[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null);
  const [latestRun, setLatestRun] = useState<RunRecord | null>(null);
  const [recentRuns, setRecentRuns] = useState<RunSummary[]>([]);
  const [tracking, setTracking] = useState<ListTracking[]>([]);
  const [selectedListId, setSelectedListId] = useState('');
  const [tab, setTab] = useState<Tab>('collect');

  const [collectMode, setCollectMode] = useState<'continue' | 'custom'>('custom');
  const [dateMode, setDateMode] = useState<'text' | 'dates'>('text');
  const [command, setCommand] = useState('ayer');
  const [startDate, setStartDate] = useState(yesterdayInputValue(BROWSER_TIMEZONE));
  const [endDate, setEndDate] = useState(yesterdayInputValue(BROWSER_TIMEZONE));

  const [showManual, setShowManual] = useState(false);
  const [manualUrl, setManualUrl] = useState('');
  const [waitingLists, setWaitingLists] = useState(false);
  const [historyListFilter, setHistoryListFilter] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [counts, setCounts] = useState<StorageCounts | null>(null);

  const saveTimer = useRef<number | null>(null);
  const datesInitialized = useRef(false);
  const modeListRef = useRef<string | null>(null);
  const timezones = useMemo(() => getTimezoneOptions(), []);

  const notify = useCallback((tone: Notice['tone'], text: string) => {
    setNotice({ tone, text });
  }, []);

  const applyBootstrap = useCallback((boot: BootstrapData, includeSettings: boolean) => {
    setLists(boot.lists);
    setActiveRun(boot.activeRun);
    setLatestRun(boot.latestRun);
    setRecentRuns(boot.recentRuns);
    setTracking(boot.tracking);
    if (includeSettings) {
      setSettings(boot.settings);
      settingsRef.current = boot.settings;
    }
    setSelectedListId((current) =>
      current && boot.lists.some((list) => list.id === current)
        ? current
        : (boot.lists[0]?.id ?? ''),
    );
  }, []);

  const refreshLists = useCallback(async () => {
    try {
      const boot = await bg<BootstrapData & { ok: true }>('GET_BOOTSTRAP');
      setLists(boot.lists);
      setSelectedListId((current) =>
        current && boot.lists.some((list) => list.id === current)
          ? current
          : (boot.lists[0]?.id ?? ''),
      );
    } catch {
      // La extensión puede estar recargándose.
    }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const state = await bg<{
        activeRun: RunRecord | null;
        latestRun: RunRecord | null;
        recentRuns: RunSummary[];
        tracking: ListTracking[];
      }>('GET_STATE');
      setActiveRun(state.activeRun);
      setLatestRun(state.latestRun);
      setRecentRuns(state.recentRuns);
      setTracking(state.tracking);
    } catch {
      // Silencioso durante el polling.
    }
  }, []);

  const refreshStorage = useCallback(async () => {
    try {
      const response = await bg<{ storage: StorageInfo; counts: StorageCounts }>('GET_STORAGE');
      setStorage(response.storage);
      setCounts(response.counts);
    } catch {
      // Sin bloqueo.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const boot = await bg<BootstrapData & { ok: true }>('GET_BOOTSTRAP');
        if (cancelled) return;
        applyBootstrap(boot, true);
        const stored = await chrome.storage.local.get(LAST_LIST_KEY);
        const lastListId = stored[LAST_LIST_KEY];
        const last = boot.lists.find((list) => list.id === lastListId);
        setSelectedListId(last?.id ?? boot.lists[0]?.id ?? '');
      } catch (loadError) {
        if (!cancelled) setError(getErrorMessage(loadError));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyBootstrap]);

  useEffect(() => {
    if (!loaded) return;
    void refreshState();
    const interval = window.setInterval(() => void refreshState(), 1800);
    return () => window.clearInterval(interval);
  }, [loaded, refreshState]);

  useEffect(() => {
    if (!waitingLists) return;
    let attempts = 0;
    let cancelled = false;
    const tick = async () => {
      attempts += 1;
      try {
        const boot = await bg<BootstrapData & { ok: true }>('GET_BOOTSTRAP');
        if (cancelled) return;
        setLists(boot.lists);
        setSelectedListId((current) =>
          current && boot.lists.some((list) => list.id === current)
            ? current
            : (boot.lists[0]?.id ?? ''),
        );
        if (boot.lists.length > 0) setWaitingLists(false);
      } catch {
        // Seguimos esperando.
      }
      if (attempts >= 20) setWaitingLists(false);
    };
    void tick();
    const interval = window.setInterval(() => void tick(), 1600);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [waitingLists]);

  useEffect(() => {
    const listener = (message: any) => {
      if (message?.type === 'RUN_UPDATED' && message.run) {
        setActiveRun(message.run);
        if (!isActiveStatus(message.run.status)) void refreshState();
      }
      if (message?.type === 'RUN_FINISHED') void refreshState();
      if (message?.type === 'LISTS_UPDATED') void refreshLists();
      if (message?.type === 'TRACKING_UPDATED' && Array.isArray(message.tracking)) {
        setTracking(message.tracking);
      }
      if (message?.type === 'DATA_CLEARED') setTracking([]);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refreshLists, refreshState]);

  useEffect(() => {
    if (!loaded || datesInitialized.current) return;
    datesInitialized.current = true;
    setStartDate(yesterdayInputValue(settings.timezone));
    setEndDate(yesterdayInputValue(settings.timezone));
  }, [loaded, settings.timezone]);

  useEffect(() => {
    if (!selectedListId) return;
    chrome.storage.local.set({ [LAST_LIST_KEY]: selectedListId }).catch(() => {
      // Sin bloqueo.
    });
  }, [selectedListId]);

  useEffect(() => {
    if (tab !== 'settings') return;
    void refreshStorage();
  }, [tab, refreshStorage]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  const selectedList = lists.find((list) => list.id === selectedListId) ?? null;
  const active = activeRun && isActiveStatus(activeRun.status) ? activeRun : null;
  const selectedTracking =
    tracking.find((item) => item.listId === selectedListId) ?? null;
  const trackingByList = useMemo(() => {
    const map = new Map<string, ListTracking>();
    for (const item of tracking) map.set(item.listId, item);
    return map;
  }, [tracking]);

  useEffect(() => {
    if (!loaded) return;
    if (modeListRef.current === selectedListId) return;
    modeListRef.current = selectedListId;
    setCollectMode(trackingByList.has(selectedListId) ? 'continue' : 'custom');
  }, [loaded, selectedListId, trackingByList]);

  const continuationResult = useMemo<RangeResult>(() => {
    if (!selectedTracking) return { range: null, error: null };
    try {
      return { range: buildContinuationRange(selectedTracking, settings.timezone), error: null };
    } catch (continuationError) {
      return { range: null, error: getErrorMessage(continuationError) };
    }
    // Se recalcula con cada actualización del seguimiento y de la zona horaria.
  }, [selectedTracking, settings.timezone, tracking]);

  const rangeResult = useMemo<RangeResult>(() => {
    try {
      if (dateMode === 'text') {
        return { range: parseDateExpression(command, settings.timezone), error: null };
      }
      return { range: parseExplicitDateRange(startDate, endDate, settings.timezone), error: null };
    } catch (rangeError) {
      return { range: null, error: getErrorMessage(rangeError) };
    }
  }, [command, dateMode, endDate, settings.timezone, startDate]);

  const customSkipsTrackingGap = Boolean(
    selectedTracking &&
      rangeResult.range &&
      Date.parse(rangeResult.range.start) > Date.parse(selectedTracking.cursor),
  );

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = window.setTimeout(async () => {
      try {
        const response = await bg<{ settings: Settings }>('SAVE_SETTINGS', { settings: next });
        if (settingsRef.current === next) {
          settingsRef.current = response.settings;
          setSettings(response.settings);
        }
        setSaveState('saved');
        window.setTimeout(() => setSaveState('idle'), 1600);
      } catch (saveError) {
        setSaveState('error');
        setError(getErrorMessage(saveError));
      }
    }, 550);
  }, []);

  const handleLoadLists = async () => {
    setError(null);
    setBusy('lists');
    try {
      await bg('OPEN_LISTS_TAB');
      setWaitingLists(true);
      notify('info', 'Se abrió x.com/i/lists. Esperando a que carguen tus listas…');
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setBusy(null);
    }
  };

  const handleManualAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = manualUrl.trim();
    if (!value) return;
    setError(null);
    setBusy('manual');
    try {
      const response = await bg<{ list?: ListInfo }>('RESOLVE_LIST_URL', { url: value });
      if (response.list) {
        setSelectedListId(response.list.id);
        setLists((current) => {
          const without = current.filter((list) => list.id !== response.list!.id);
          return [...without, response.list!].sort((a, b) => a.name.localeCompare(b.name, 'es'));
        });
        setManualUrl('');
        setShowManual(false);
        notify('success', `Lista “${response.list.name}” añadida.`);
        window.setTimeout(() => void refreshLists(), 2800);
        if (response.list.name.toLowerCase().startsWith('lista ')) setWaitingLists(true);
      }
    } catch (addError) {
      setError(getErrorMessage(addError));
    } finally {
      setBusy(null);
    }
  };

  const handleStart = async () => {
    if (!selectedList) {
      setError('Selecciona una lista o añade una por URL.');
      return;
    }
    const isContinuation = collectMode === 'continue';
    const continuationRange = continuationResult.range;
    const customRange = rangeResult.range;
    if (isContinuation) {
      if (!selectedTracking) {
        setError('Esta lista aún no tiene seguimiento. Haz primero una recolección con un rango personalizado.');
        return;
      }
      if (!continuationRange) {
        setError(continuationResult.error || 'No se pudo calcular el punto de continuación.');
        return;
      }
    } else if (!customRange) {
      setError(rangeResult.error || 'Indica un rango de fechas válido.');
      return;
    }
    setError(null);
    setBusy('start');
    try {
      const base = {
        listId: selectedList.id,
        listName: selectedList.name,
        mode: settings.mode,
        includeReplies: settings.includeReplies,
        includeReposts: settings.includeReposts,
        includeQuotes: settings.includeQuotes,
        maxPosts: settings.maxPosts,
        minDelayMs: settings.minDelayMs,
        maxDelayMs: settings.maxDelayMs,
        idleScrolls: settings.idleScrolls,
        maxScrolls: settings.maxScrolls,
      };
      const response = isContinuation
        ? await bg<{ run: RunRecord }>('START_CONTINUE_RUN', { config: base })
        : await bg<{ run: RunRecord }>('START_RUN', {
            config: { ...base, range: customRange! } satisfies ScrapeConfig,
          });
      setActiveRun(response.run);
      setLatestRun(response.run);
      notify(
        'success',
        isContinuation
          ? 'Recolección de novedades iniciada. La pestaña de X está trabajando.'
          : 'Recolección iniciada. La pestaña de X está trabajando.',
      );
      void refreshState();
    } catch (startError) {
      setError(getErrorMessage(startError));
    } finally {
      setBusy(null);
    }
  };

  const handleResetTracking = async (listId: string) => {
    const item = trackingByList.get(listId);
    const name = item?.listName ?? 'esta lista';
    if (
      !window.confirm(
        `¿Reiniciar el seguimiento de “${name}”? Se borrará el punto de continuación, pero las recolecciones y los posts guardados se conservan.`,
      )
    ) {
      return;
    }
    setBusy(`reset:${listId}`);
    setError(null);
    try {
      const response = await bg<{ tracking: ListTracking[] }>('RESET_TRACKING', { listId });
      setTracking(response.tracking);
      if (selectedListId === listId) setCollectMode('custom');
      notify('success', 'Seguimiento reiniciado. El próximo rango personalizado establecerá un nuevo punto de partida.');
    } catch (resetError) {
      setError(getErrorMessage(resetError));
    } finally {
      setBusy(null);
    }
  };

  const handleContinueList = (listId: string) => {
    setSelectedListId(listId);
    setCollectMode('continue');
    setTab('collect');
    setError(null);
  };

  const handlePauseResume = async () => {
    if (!active) return;
    setBusy('pause');
    setError(null);
    try {
      await bg(active.status === 'paused' ? 'RESUME_RUN' : 'PAUSE_RUN');
      await refreshState();
    } catch (pauseError) {
      setError(getErrorMessage(pauseError));
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    if (!active) return;
    if (!window.confirm('¿Detener la recolección? Los posts ya capturados se conservan.')) return;
    setBusy('cancel');
    setError(null);
    try {
      await bg('CANCEL_RUN');
      await refreshState();
      notify('info', 'Recolección detenida.');
    } catch (cancelError) {
      setError(getErrorMessage(cancelError));
    } finally {
      setBusy(null);
    }
  };

  const handleOpenDashboard = async (runId: string) => {
    try {
      await bg('OPEN_DASHBOARD', { runId });
    } catch (openError) {
      setError(getErrorMessage(openError));
    }
  };

  const handleDeleteRun = async (runId: string) => {
    if (!window.confirm('¿Eliminar esta recolección y todos sus posts? Esta acción no se puede deshacer.')) {
      return;
    }
    setBusy(`delete:${runId}`);
    setError(null);
    try {
      await bg('DELETE_RUN', { runId });
      await refreshState();
      void refreshStorage();
      notify('success', 'Recolección eliminada.');
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    } finally {
      setBusy(null);
    }
  };

  const handleClearAll = async () => {
    if (
      !window.confirm(
        'Esto borrará las listas guardadas, las recolecciones y todos los posts de la extensión. No afecta a tu cuenta de X. ¿Continuar?',
      )
    ) {
      return;
    }
    setBusy('clear');
    setError(null);
    try {
      await bg('DELETE_ALL_DATA');
      setLists([]);
      setSelectedListId('');
      setActiveRun(null);
      setLatestRun(null);
      setRecentRuns([]);
      setTracking([]);
      setCollectMode('custom');
      setStorage({ usage: 0, quota: 0 });
      setCounts({ lists: 0, runs: 0, posts: 0 });
      notify('success', 'Todos los datos locales fueron eliminados.');
    } catch (clearError) {
      setError(getErrorMessage(clearError));
    } finally {
      setBusy(null);
    }
  };

  const setQuickRange = (expression: string) => {
    setDateMode('text');
    setCommand(expression);
  };

  const timezoneChoices = useMemo(() => {
    const all = new Set(timezones);
    all.add(settings.timezone);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [settings.timezone, timezones]);

  const latestFinished = latestRun && !isActiveStatus(latestRun.status) ? latestRun : null;
  const historyListOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of recentRuns) map.set(run.listId, run.listName);
    for (const item of tracking) map.set(item.listId, item.listName);
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [recentRuns, tracking]);
  const filteredRuns =
    historyListFilter === 'all'
      ? recentRuns
      : recentRuns.filter((run) => run.listId === historyListFilter);

  useEffect(() => {
    if (historyListFilter === 'all') return;
    if (!historyListOptions.some((list) => list.id === historyListFilter)) {
      setHistoryListFilter('all');
    }
  }, [historyListFilter, historyListOptions]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">X</span>
          <div className="brand-copy">
            <h1>Xense</h1>
            <p>Listas de X convertidas en datos</p>
          </div>
        </div>
        <div className="header-actions">
          {saveState === 'saving' && <span className="save-state">Guardando…</span>}
          {saveState === 'saved' && <span className="save-state ok">Guardado</span>}
          {saveState === 'error' && <span className="save-state error">Error al guardar</span>}
          <button className="icon-button" title="Actualizar estado" onClick={() => void refreshState()}>
            ↻
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Secciones">
        <button className={tab === 'collect' ? 'active' : ''} onClick={() => setTab('collect')}>
          Recolectar
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          Historial
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Ajustes
        </button>
      </nav>

      <main className="app-main">
        {error && (
          <div className="alert alert-error" role="alert">
            <span>{error}</span>
            <button className="alert-close" onClick={() => setError(null)} aria-label="Cerrar">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className={`alert alert-${notice.tone}`} role="status">
            <span>{notice.text}</span>
            <button className="alert-close" onClick={() => setNotice(null)} aria-label="Cerrar">
              ×
            </button>
          </div>
        )}

        {!loaded ? (
          <div className="loading-state">
            <span className="spinner" />
            Cargando Xense…
          </div>
        ) : tab === 'collect' ? (
          active ? (
            <ActiveRunPanel
              run={active}
              busy={busy}
              onPauseResume={handlePauseResume}
              onCancel={handleCancel}
              onOpen={() => void handleOpenDashboard(active.id)}
              onFocus={() => void bg('FOCUS_SCRAPER_TAB').catch(() => undefined)}
            />
          ) : (
            <>
              <section className="card">
                <div className="card-heading">
                  <div className="heading-with-step">
                    <span className="step">1</span>
                    <h2>Lista</h2>
                  </div>
                  <button className="link-button" onClick={() => void refreshLists()}>
                    Actualizar
                  </button>
                </div>

                {lists.length > 0 ? (
                  <select
                    className="input"
                    value={selectedListId}
                    onChange={(event) => setSelectedListId(event.target.value)}
                    aria-label="Seleccionar lista"
                  >
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                        {list.memberCount != null
                          ? ` · ${list.memberCount.toLocaleString('es')} miembros`
                          : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="empty-inline">
                    <p>No hay listas guardadas todavía.</p>
                    <p className="hint">Carga tus listas de X o añade una por URL.</p>
                  </div>
                )}

                <div className="button-row">
                  <button
                    className="btn btn-secondary"
                    onClick={() => void handleLoadLists()}
                    disabled={busy === 'lists' || waitingLists}
                  >
                    {waitingLists ? 'Esperando listas…' : 'Cargar mis listas'}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setShowManual((value) => !value)}>
                    {showManual ? 'Cancelar' : 'Añadir por URL'}
                  </button>
                </div>

                {waitingLists && (
                  <p className="hint waiting-hint">
                    <span className="spinner small" /> Se abrió x.com/i/lists. Esperando a que carguen
                    tus listas…
                  </p>
                )}

                {showManual && (
                  <form className="manual-form" onSubmit={handleManualAdd}>
                    <input
                      className="input"
                      value={manualUrl}
                      onChange={(event) => setManualUrl(event.target.value)}
                      placeholder="https://x.com/i/lists/123456789"
                      aria-label="URL de la lista"
                    />
                    <button className="btn btn-secondary" type="submit" disabled={busy === 'manual'}>
                      {busy === 'manual' ? 'Añadiendo…' : 'Añadir'}
                    </button>
                  </form>
                )}
              </section>

              {selectedList && (
                <section className="card tracking-card">
                  <div className="card-heading">
                    <div className="heading-with-step">
                      <span className="step">↺</span>
                      <h2>Seguimiento</h2>
                    </div>
                    {selectedTracking ? (
                      <span className="badge badge-ok">Activo</span>
                    ) : (
                      <span className="badge">Sin empezar</span>
                    )}
                  </div>
                  {selectedTracking ? (
                    <TrackingDetails
                      tracking={selectedTracking}
                      timezone={settings.timezone}
                    />
                  ) : (
                    <p className="hint">
                      Esta lista todavía no tiene un punto de continuación. Haz una recolección
                      con un rango personalizado y, a partir de ahí, podrás usar Novedades.
                    </p>
                  )}
                  {selectedTracking && (
                    <div className="button-row">
                      <button
                        className="btn btn-small btn-ghost danger-text"
                        onClick={() => void handleResetTracking(selectedTracking.listId)}
                        disabled={busy === `reset:${selectedTracking.listId}`}
                      >
                        {busy === `reset:${selectedTracking.listId}`
                          ? 'Reiniciando…'
                          : 'Reiniciar seguimiento'}
                      </button>
                    </div>
                  )}
                </section>
              )}

              <section className="card">
                <div className="card-heading">
                  <div className="heading-with-step">
                    <span className="step">2</span>
                    <h2>Fechas</h2>
                  </div>
                </div>

                <div className="segmented" role="group" aria-label="Tipo de rango">
                  <button
                    className={collectMode === 'continue' ? 'active' : ''}
                    onClick={() => setCollectMode('continue')}
                    disabled={!selectedTracking}
                    title={
                      selectedTracking
                        ? 'Recolectar desde el punto de continuación hasta ahora'
                        : 'Primero necesitas una recolección con rango personalizado'
                    }
                  >
                    Novedades
                  </button>
                  <button
                    className={collectMode === 'custom' ? 'active' : ''}
                    onClick={() => setCollectMode('custom')}
                  >
                    Rango personalizado
                  </button>
                </div>

                {collectMode === 'continue' ? (
                  selectedTracking ? (
                    <>
                      <div className="range-box">
                        <div className="range-title">Novedades desde el último análisis</div>
                        {continuationResult.range ? (
                          <>
                            <div className="range-dates">
                              {formatLocalDateTime(
                                continuationResult.range.start,
                                settings.timezone,
                              )}{' '}
                              → ahora
                            </div>
                            <div className="range-meta">
                              El límite final se calcula al iniciar · {settings.timezone}
                            </div>
                            <details className="utc-details">
                              <summary>Ver punto de partida UTC</summary>
                              <code>{continuationResult.range.start}</code>
                            </details>
                          </>
                        ) : (
                          <p className="field-error">
                            {continuationResult.error || 'No se pudo calcular el punto de continuación.'}
                          </p>
                        )}
                      </div>
                      <p className="hint">
                        Se recorre exactamente desde donde quedó el último análisis. Si una
                        recolección se cortó a mitad de un tramo, ese tramo se repite para no
                        dejar huecos.
                      </p>
                    </>
                  ) : (
                    <p className="hint">
                      Selecciona una lista con seguimiento o haz primero un rango personalizado.
                    </p>
                  )
                ) : (
                  <>
                    <div className="segmented segmented-sub" role="group" aria-label="Formato del rango">
                      <button
                        className={dateMode === 'text' ? 'active' : ''}
                        onClick={() => setDateMode('text')}
                      >
                        Texto
                      </button>
                      <button
                        className={dateMode === 'dates' ? 'active' : ''}
                        onClick={() => setDateMode('dates')}
                      >
                        Calendario
                      </button>
                    </div>

                    {dateMode === 'text' ? (
                      <>
                        <input
                          className="input"
                          value={command}
                          onChange={(event) => setCommand(event.target.value)}
                          placeholder="ayer, hoy, últimos 7 días, 1–10 nov 2026"
                          aria-label="Expresión de fechas"
                        />
                        <div className="chips">
                          <button onClick={() => setQuickRange('ayer')}>Ayer</button>
                          <button onClick={() => setQuickRange('hoy')}>Hoy</button>
                          <button onClick={() => setQuickRange('anteayer')}>Anteayer</button>
                          <button onClick={() => setQuickRange('últimos 7 días')}>Últimos 7 días</button>
                        </div>
                      </>
                    ) : (
                      <div className="date-grid">
                        <label>
                          Desde
                          <input
                            className="input"
                            type="date"
                            value={startDate}
                            onChange={(event) => setStartDate(event.target.value)}
                          />
                        </label>
                        <label>
                          Hasta
                          <input
                            className="input"
                            type="date"
                            value={endDate}
                            onChange={(event) => setEndDate(event.target.value)}
                          />
                        </label>
                      </div>
                    )}

                    {rangeResult.error ? (
                      <p className="field-error">{rangeResult.error}</p>
                    ) : rangeResult.range ? (
                      <div className="range-box">
                        <div className="range-title">{rangeResult.range.label}</div>
                        <div className="range-dates">
                          {formatLocalDateTime(rangeResult.range.start, settings.timezone)} →{' '}
                          {formatLocalDateTime(rangeResult.range.end, settings.timezone)}
                        </div>
                        <div className="range-meta">
                          {settings.timezone} · límite final exclusivo
                          {rangeResult.range.partial && <span className="badge badge-warn">Parcial</span>}
                          {rangeResult.range.rolling && <span className="badge">Ventana móvil</span>}
                        </div>
                        <details className="utc-details">
                          <summary>Ver límites UTC que se enviarán a X</summary>
                          <code>{rangeResult.range.start}</code>
                          <code>{rangeResult.range.end}</code>
                        </details>
                      </div>
                    ) : null}

                    {customSkipsTrackingGap && rangeResult.range && selectedTracking && (
                      <div className="inline-warning">
                        Este rango empieza después del punto de continuación (
                        {formatLocalDateTime(selectedTracking.cursor, settings.timezone)}). No
                        avanzará el seguimiento y quedará un hueco entre ambos. Usa Novedades para
                        continuar sin huecos.
                      </div>
                    )}

                    <p className="hint">
                      La fecha se interpreta en tu zona horaria y se convierte a UTC para delimitar
                      la búsqueda en X.
                    </p>
                  </>
                )}
              </section>

              <details className="card options-card">
                <summary>
                  <span>Opciones de recolección</span>
                  <span className="summary-hint">
                    {settings.mode === 'auto'
                      ? 'Automático'
                      : settings.mode === 'search'
                        ? 'Solo búsqueda'
                        : 'Solo timeline'}
                  </span>
                </summary>
                <div className="form-row">
                  <label>
                    Modo
                    <select
                      className="input"
                      value={settings.mode}
                      onChange={(event) =>
                        updateSettings({ mode: event.target.value as Settings['mode'] })
                      }
                    >
                      <option value="auto">Automático (búsqueda + timeline)</option>
                      <option value="search">Solo búsqueda por fechas</option>
                      <option value="timeline">Solo timeline de la lista</option>
                    </select>
                  </label>
                </div>
                <div className="toggle-grid">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.includeReplies}
                      onChange={(event) => updateSettings({ includeReplies: event.target.checked })}
                    />
                    <span>Incluir respuestas</span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.includeReposts}
                      onChange={(event) => updateSettings({ includeReposts: event.target.checked })}
                    />
                    <span>Incluir reposts</span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.includeQuotes}
                      onChange={(event) => updateSettings({ includeQuotes: event.target.checked })}
                    />
                    <span>Incluir citas</span>
                  </label>
                </div>
                <label className="field-label">
                  Máximo de posts
                  <input
                    className="input"
                    type="number"
                    min={50}
                    max={20000}
                    value={settings.maxPosts}
                    onChange={(event) =>
                      updateSettings({ maxPosts: Number(event.target.value) || settings.maxPosts })
                    }
                  />
                </label>
              </details>

              <button
                className="btn btn-primary btn-block"
                onClick={() => void handleStart()}
                disabled={
                  Boolean(busy) ||
                  !selectedList ||
                  (collectMode === 'continue' ? !continuationResult.range : !rangeResult.range)
                }
              >
                {busy === 'start'
                  ? 'Iniciando…'
                  : collectMode === 'continue'
                    ? 'Recolectar novedades'
                    : 'Recolectar posts'}
              </button>
              <p className="hint center">
                Se abrirá una pestaña de X. Mantenla abierta hasta que termine la recolección.
              </p>

              {latestFinished && (
                <LatestRunCard
                  run={latestFinished}
                  timezone={settings.timezone}
                  busy={busy}
                  onOpen={() => void handleOpenDashboard(latestFinished.id)}
                  onDelete={() => void handleDeleteRun(latestFinished.id)}
                />
              )}
            </>
          )
        ) : tab === 'history' ? (
          <section>
            {tracking.length > 0 && (
              <>
                <div className="section-heading">
                  <h2>Listas en seguimiento</h2>
                  <span className="hint">{tracking.length} activas</span>
                </div>
                <div className="tracking-list">
                  {tracking.map((item) => (
                    <TrackingCard
                      key={item.listId}
                      tracking={item}
                      timezone={settings.timezone}
                      busy={busy}
                      onContinue={() => handleContinueList(item.listId)}
                      onReset={() => void handleResetTracking(item.listId)}
                    />
                  ))}
                </div>
              </>
            )}

            <div className="section-heading history-heading">
              <h2>Recolecciones recientes</h2>
              <span className="hint">{filteredRuns.length} guardadas</span>
            </div>

            {historyListOptions.length > 1 && (
              <label className="filter-field">
                Filtrar por lista
                <select
                  className="input"
                  value={historyListFilter}
                  onChange={(event) => setHistoryListFilter(event.target.value)}
                >
                  <option value="all">Todas las listas</option>
                  {historyListOptions.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {filteredRuns.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">◎</div>
                <p>
                  {recentRuns.length === 0
                    ? 'Todavía no hay recolecciones.'
                    : 'No hay recolecciones para esta lista.'}
                </p>
                <p className="hint">
                  {recentRuns.length === 0
                    ? 'Empieza en la pestaña Recolectar.'
                    : 'Prueba con otra lista o quita el filtro.'}
                </p>
              </div>
            ) : (
              <div className="run-list">
                {filteredRuns.map((run) => (
                  <article className="run-row" key={run.id}>
                    <div className="run-row-top">
                      <div className="run-row-title">
                        <strong>{run.listName}</strong>
                        <span className="hint">{run.rangeLabel}</span>
                      </div>
                      <div className="run-row-badges">
                        {run.origin === 'continuation' && (
                          <span className="badge badge-continuation">Novedades</span>
                        )}
                        <span className={`status-chip ${statusTone(run.status)}`}>
                          {statusLabel(run.status)}
                        </span>
                      </div>
                    </div>
                    <div className="run-row-meta">
                      <span>{run.captured.toLocaleString('es')} posts</span>
                      <span>
                        {run.windowsDone}/{run.windowsTotal} ventanas
                      </span>
                      <span>{shortRunDate(run.createdAt, settings.timezone)}</span>
                      {run.lastPostAt && (
                        <span>Último post: {shortRunDate(run.lastPostAt, settings.timezone)}</span>
                      )}
                    </div>
                    <div className="button-row">
                      <button className="btn btn-small btn-secondary" onClick={() => void handleOpenDashboard(run.id)}>
                        Abrir resultados
                      </button>
                      <button
                        className="btn btn-small btn-ghost danger-text"
                        onClick={() => void handleDeleteRun(run.id)}
                        disabled={busy === `delete:${run.id}`}
                      >
                        Eliminar
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : (
          <SettingsPanel
            settings={settings}
            timezones={timezoneChoices}
            updateSettings={updateSettings}
            storage={storage}
            counts={counts}
            busy={busy}
            onClearAll={() => void handleClearAll()}
            onRefreshStorage={() => void refreshStorage()}
          />
        )}
      </main>

      <footer className="app-footer">
        <span>Xense 0.1 · datos locales</span>
        <span>Uso personal. X puede aplicar límites de acceso.</span>
      </footer>
    </div>
  );
}

function TrackingDetails({
  tracking,
  timezone,
}: {
  tracking: ListTracking;
  timezone: string;
}) {
  const lastAnalysis = tracking.lastFinishedAt ?? tracking.lastRunAt;
  return (
    <>
      <div className="tracking-facts">
        <div>
          <span>Último análisis</span>
          <strong>{formatLocalDateTime(lastAnalysis, timezone)}</strong>
          <small>
            <span className={`status-chip ${statusTone(tracking.lastStatus)}`}>
              {statusLabel(tracking.lastStatus)}
            </span>{' '}
            {tracking.lastCaptured.toLocaleString('es')} posts · {tracking.lastRangeLabel}
          </small>
        </div>
        <div>
          <span>Continuar desde</span>
          <strong>{formatLocalDateTime(tracking.cursor, timezone)}</strong>
          <small>{timezone}</small>
        </div>
      </div>

      {tracking.lastPost ? (
        <a
          className="last-post"
          href={tracking.lastPost.permalink}
          target="_blank"
          rel="noreferrer"
          title="Abrir el último post capturado en X"
        >
          <span className="last-post-head">
            <strong>@{tracking.lastPost.authorHandle}</strong>
            <span>{formatLocalDateTime(tracking.lastPost.createdAt, timezone)}</span>
          </span>
          <span className="last-post-text">{tracking.lastPost.text}</span>
        </a>
      ) : (
        <p className="hint">Aún no hay un último post registrado para esta lista.</p>
      )}

      {(tracking.lastStatus === 'partial' ||
        tracking.lastStatus === 'failed' ||
        tracking.lastStatus === 'cancelled') && (
        <p className="hint">
          La última recolección no completó todos los tramos. La próxima vez se repetirá el
          tramo incompleto para no dejar huecos; puede haber algunos posts duplicados.
        </p>
      )}
    </>
  );
}

function TrackingCard({
  tracking,
  timezone,
  busy,
  onContinue,
  onReset,
}: {
  tracking: ListTracking;
  timezone: string;
  busy: string | null;
  onContinue: () => void;
  onReset: () => void;
}) {
  return (
    <article className="tracking-item">
      <div className="tracking-item-top">
        <div>
          <span className="eyebrow">En seguimiento</span>
          <strong>{tracking.listName}</strong>
        </div>
        <span className="badge badge-ok">Activo</span>
      </div>
      <TrackingDetails tracking={tracking} timezone={timezone} />
      <div className="button-row">
        <button className="btn btn-small btn-primary" onClick={onContinue}>
          Recolectar novedades
        </button>
        <button
          className="btn btn-small btn-ghost danger-text"
          onClick={onReset}
          disabled={busy === `reset:${tracking.listId}`}
        >
          {busy === `reset:${tracking.listId}` ? 'Reiniciando…' : 'Reiniciar seguimiento'}
        </button>
      </div>
    </article>
  );
}

function ActiveRunPanel({
  run,
  busy,
  onPauseResume,
  onCancel,
  onOpen,
  onFocus,
}: {
  run: RunRecord;
  busy: string | null;
  onPauseResume: () => void;
  onCancel: () => void;
  onOpen: () => void;
  onFocus: () => void;
}) {
  const window = run.windows[run.currentWindowIndex];
  const progress = Math.round(getWindowProgress(run) * 100);
  const windowsDone = run.windows.filter((item) => item.status === 'done').length;
  const elapsed = formatElapsed(run);

  return (
    <section className="card active-run-card">
      <div className="run-top">
        <div>
          <span className="eyebrow">Recolección en curso</span>
          <h2>{run.config.listName}</h2>
        </div>
        <span className={`status-chip ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
      </div>
      <p className="run-range">
        {run.config.origin === 'continuation' && (
          <span className="badge badge-continuation">Novedades</span>
        )}{' '}
        {run.config.range.label} · {run.config.range.timezone}
      </p>

      <div className="progress-track" aria-label={`Progreso ${progress}%`}>
        <div className="progress-fill" style={{ width: `${Math.max(3, progress)}%` }} />
      </div>
      <div className="progress-caption">
        <span>
          Ventana {run.currentWindowIndex + 1} de {run.windows.length}
        </span>
        <span>{progress}%</span>
      </div>

      <div className="stat-grid">
        <div>
          <strong>{run.captured.toLocaleString('es')}</strong>
          <span>posts</span>
        </div>
        <div>
          <strong>
            {windowsDone}/{run.windows.length}
          </strong>
          <span>ventanas</span>
        </div>
        <div>
          <strong>{elapsed}</strong>
          <span>tiempo</span>
        </div>
      </div>

      <p className="run-message">{run.progress.message}</p>
      {window && (
        <p className="hint">
          Ventana actual: {formatLocalDateTime(window.start, run.config.range.timezone)} →{' '}
          {formatLocalDateTime(window.end, run.config.range.timezone)} · {run.progress.scrolls}{' '}
          desplazamientos
        </p>
      )}
      {run.progress.hidden && (
        <div className="inline-warning">
          La pestaña de X está en segundo plano. El navegador puede ralentizar los timers.
        </div>
      )}

      {run.errors.length > 0 && (
        <div className="alert alert-error compact">
          {run.errors.slice(-2).map((message, index) => (
            <span key={`${message}-${index}`}>{message}</span>
          ))}
        </div>
      )}

      <div className="button-row">
        <button
          className="btn btn-secondary"
          onClick={onPauseResume}
          disabled={Boolean(busy) || (run.status !== 'running' && run.status !== 'paused')}
        >
          {run.status === 'paused' ? 'Reanudar' : 'Pausar'}
        </button>
        <button className="btn btn-ghost danger-text" onClick={onCancel} disabled={Boolean(busy)}>
          Detener
        </button>
        <button className="btn btn-ghost" onClick={onFocus}>
          Ir a la pestaña
        </button>
        <button className="btn btn-secondary" onClick={onOpen}>
          Ver resultados
        </button>
      </div>

      <p className="hint">
        Puedes seguir usando el navegador, pero no cierres la pestaña de X. Los posts se guardan
        progresivamente.
      </p>

      {run.diagnostics.length > 0 && (
        <details className="diagnostics">
          <summary>Diagnóstico ({run.diagnostics.length})</summary>
          <ul>
            {run.diagnostics.slice(-8).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className={`diag-${entry.level}`}>
                <span>{entry.operation ? `${entry.operation}: ` : ''}</span>
                {entry.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function LatestRunCard({
  run,
  timezone,
  busy,
  onOpen,
  onDelete,
}: {
  run: RunRecord;
  timezone: string;
  busy: string | null;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <section className="card latest-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Última recolección</span>
          <h2>{run.config.listName}</h2>
        </div>
        <span className={`status-chip ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
      </div>
      <p className="run-range">
        {run.config.origin === 'continuation' && (
          <span className="badge badge-continuation">Novedades</span>
        )}{' '}
        {run.config.range.label} · {shortRunDate(run.createdAt, timezone)}
      </p>
      <div className="stat-grid compact-stats">
        <div>
          <strong>{run.captured.toLocaleString('es')}</strong>
          <span>posts</span>
        </div>
        <div>
          <strong>{run.windows.filter((window) => window.status === 'done').length}</strong>
          <span>ventanas</span>
        </div>
        <div>
          <strong>{formatElapsed(run)}</strong>
          <span>duración</span>
        </div>
      </div>
      {run.errors.length > 0 && <p className="field-error">{run.errors[run.errors.length - 1]}</p>}
      <div className="button-row">
        <button className="btn btn-primary" onClick={onOpen}>
          Abrir resultados
        </button>
        <button className="btn btn-ghost danger-text" onClick={onDelete} disabled={busy === `delete:${run.id}`}>
          Eliminar
        </button>
      </div>
    </section>
  );
}

function SettingsPanel({
  settings,
  timezones,
  updateSettings,
  storage,
  counts,
  busy,
  onClearAll,
  onRefreshStorage,
}: {
  settings: Settings;
  timezones: string[];
  updateSettings: (patch: Partial<Settings>) => void;
  storage: StorageInfo | null;
  counts: StorageCounts | null;
  busy: string | null;
  onClearAll: () => void;
  onRefreshStorage: () => void;
}) {
  return (
    <div className="settings-stack">
      <section className="card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Preferencias</span>
            <h2>Recolección</h2>
          </div>
        </div>
        <label className="field-label">
          Zona horaria
          <select
            className="input"
            value={settings.timezone}
            onChange={(event) => updateSettings({ timezone: event.target.value })}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          “Ayer” y las fechas del calendario se interpretan en esta zona. Se muestra la zona
          detectada por el navegador por defecto.
        </p>

        <label className="field-label">
          Modo de recolección
          <select
            className="input"
            value={settings.mode}
            onChange={(event) => updateSettings({ mode: event.target.value as Settings['mode'] })}
          >
            <option value="auto">Automático: búsqueda y, si falla, timeline</option>
            <option value="search">Solo búsqueda por fechas</option>
            <option value="timeline">Solo timeline de la lista</option>
          </select>
        </label>

        <div className="toggle-grid">
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.includeReplies}
              onChange={(event) => updateSettings({ includeReplies: event.target.checked })}
            />
            <span>Incluir respuestas</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.includeReposts}
              onChange={(event) => updateSettings({ includeReposts: event.target.checked })}
            />
            <span>Incluir reposts</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.includeQuotes}
              onChange={(event) => updateSettings({ includeQuotes: event.target.checked })}
            />
            <span>Incluir citas</span>
          </label>
        </div>

        <div className="date-grid">
          <label className="field-label">
            Máximo de posts
            <input
              className="input"
              type="number"
              min={50}
              max={20000}
              value={settings.maxPosts}
              onChange={(event) =>
                updateSettings({ maxPosts: Number(event.target.value) || settings.maxPosts })
              }
            />
          </label>
          <label className="field-label">
            Máximo de scrolls
            <input
              className="input"
              type="number"
              min={10}
              max={1000}
              value={settings.maxScrolls}
              onChange={(event) =>
                updateSettings({ maxScrolls: Number(event.target.value) || settings.maxScrolls })
              }
            />
          </label>
        </div>
      </section>

      <details className="card options-card">
        <summary>
          <span>Opciones avanzadas</span>
          <span className="summary-hint">Ritmo y detección de fin</span>
        </summary>
        <div className="date-grid">
          <label className="field-label">
            Pausa mínima (segundos)
            <input
              className="input"
              type="number"
              min={1}
              max={15}
              step={0.1}
              value={settings.minDelayMs / 1000}
              onChange={(event) =>
                updateSettings({
                  minDelayMs: Math.max(1000, Math.round(Number(event.target.value) * 1000)),
                })
              }
            />
          </label>
          <label className="field-label">
            Pausa máxima (segundos)
            <input
              className="input"
              type="number"
              min={1.2}
              max={20}
              step={0.1}
              value={settings.maxDelayMs / 1000}
              onChange={(event) =>
                updateSettings({
                  maxDelayMs: Math.max(1200, Math.round(Number(event.target.value) * 1000)),
                })
              }
            />
          </label>
          <label className="field-label">
            Scrolls sin novedades antes de terminar
            <input
              className="input"
              type="number"
              min={3}
              max={40}
              value={settings.idleScrolls}
              onChange={(event) =>
                updateSettings({ idleScrolls: Number(event.target.value) || settings.idleScrolls })
              }
            />
          </label>
        </div>
        <p className="hint">
          Pausas más largas reducen el riesgo de que X limite la carga, pero alargan la recolección.
        </p>
      </details>

      <section className="card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Almacenamiento local</span>
            <h2>Datos</h2>
          </div>
          <button className="link-button" onClick={onRefreshStorage}>
            Actualizar
          </button>
        </div>
        <div className="storage-grid">
          <div>
            <strong>{formatBytes(storage?.usage ?? 0)}</strong>
            <span>usados</span>
          </div>
          <div>
            <strong>{counts?.posts.toLocaleString('es') ?? 0}</strong>
            <span>posts</span>
          </div>
          <div>
            <strong>{counts?.runs.toLocaleString('es') ?? 0}</strong>
            <span>recolecciones</span>
          </div>
          <div>
            <strong>{counts?.lists.toLocaleString('es') ?? 0}</strong>
            <span>listas</span>
          </div>
        </div>
        <p className="hint">
          Todo se guarda en IndexedDB dentro de esta extensión. Nada se envía a un servidor propio.
        </p>
        <button className="btn btn-danger" onClick={onClearAll} disabled={busy === 'clear'}>
          {busy === 'clear' ? 'Borrando…' : 'Borrar todos los datos locales'}
        </button>
      </section>

      <section className="info-card">
        <h3>Sobre la recolección</h3>
        <p>
          Xense reutiliza tu sesión de x.com y lee los datos que la propia página carga. No pide tu
          contraseña ni llama a endpoints internos con tokens propios.
        </p>
        <p>
          Los Términos de X restringen el acceso automatizado fuera de sus interfaces publicadas. Usa
          la herramienta para análisis personal, con pausas conservadoras y sin republicar datasets
          completos. Existe riesgo de limitaciones temporales en la cuenta.
        </p>
        <p>
          X puede cambiar su estructura interna. Si algo deja de funcionar, revisa el diagnóstico de
          la recolección y actualiza la extensión.
        </p>
      </section>
    </div>
  );
}

function formatElapsed(run: RunRecord): string {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const total = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${minutes % 60} min`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
