import { useCallback, useEffect, useRef, useState } from 'react';
import { nativeRequest, type AiModelOption } from '../../lib/ai/native';
import { getErrorMessage } from '../../lib/ui/api';

const CATALOG_KEY = 'xense.codexModelCatalog';
const PREFERENCE_KEY = 'xense.codexDefaultModel';
const REFRESH_INTERVAL = 60 * 60 * 1000;

export function useCodexModels(active: boolean) {
  const [models, setModels] = useState<AiModelOption[] | null>(null);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [preferenceError, setPreferenceError] = useState('');
  const lastAttempt = useRef(0);
  const refreshing = useRef(false);
  const model = selection ?? preferred ?? '';

  useEffect(() => {
    let mounted = true;
    let preferenceChanged = false;
    const onStorageChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes[PREFERENCE_KEY]) return;
      preferenceChanged = true;
      const value = changes[PREFERENCE_KEY].newValue;
      setPreferred(typeof value === 'string' ? value : '');
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    void chrome.storage.local.get([CATALOG_KEY, PREFERENCE_KEY]).then(stored => {
      if (!mounted) return;
      const cached = stored[CATALOG_KEY];
      if (Array.isArray(cached)) setModels(current => current ?? cached);
      if (!preferenceChanged) {
        const value = stored[PREFERENCE_KEY];
        setPreferred(typeof value === 'string' ? value : '');
      }
    }).catch(() => {
      if (!mounted || preferenceChanged) return;
      setPreferred('');
      setPreferenceError('No se pudo leer el modelo predeterminado guardado.');
    });
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onStorageChange);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    lastAttempt.current = Date.now();
    setLoading(true);
    setCatalogError('');
    try {
      const reply = await nativeRequest({ type: 'LIST_CODEX_MODELS' });
      if (!Array.isArray(reply.models)) throw new Error('El puente local no devolvió un catálogo de modelos.');
      setModels(reply.models);
      void chrome.storage.local.set({ [CATALOG_KEY]: reply.models }).catch(() => {});
    } catch (error) {
      setCatalogError(getErrorMessage(error));
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const refreshIfDue = () => {
      if (!document.hidden && Date.now() - lastAttempt.current >= REFRESH_INTERVAL) void refresh();
    };
    const timer = window.setInterval(refreshIfDue, 60 * 1000);
    document.addEventListener('visibilitychange', refreshIfDue);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfDue);
    };
  }, [active, refresh]);

  const select = (id: string) => {
    setSelection(id === preferred ? null : id);
    setPreferenceError('');
  };

  const saveDefault = async () => {
    setSaving(true);
    setPreferenceError('');
    try {
      await chrome.storage.local.set({ [PREFERENCE_KEY]: model });
      setPreferred(model);
      setSelection(current => current === model ? null : current);
    } catch {
      setPreferenceError('No se pudo guardar el modelo predeterminado. Vuelve a intentarlo.');
    } finally {
      setSaving(false);
    }
  };

  return { models, preferred, model, loading, saving, catalogError, preferenceError, refresh, select, saveDefault };
}
