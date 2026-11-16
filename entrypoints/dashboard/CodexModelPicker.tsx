import type { useCodexModels } from './useCodexModels';

interface Props {
  catalog: ReturnType<typeof useCodexModels>;
  disabled: boolean;
}

export default function CodexModelPicker({ catalog, disabled }: Props) {
  const { models, preferred, model, loading, saving, preferenceError, catalogError, refresh, select, saveDefault } = catalog;
  const preferredIsMissing = preferred && !models?.some(option => option.id === preferred);
  const selectionIsMissing = model && model !== preferred && !models?.some(option => option.id === model);
  const canChange = !disabled && preferred !== null && !saving;

  return (
    <div className="ai-model-picker">
      <label>
        Modelo
        <select className="input" value={model} disabled={!canChange} onChange={event => select(event.target.value)}>
          <option value="">Predeterminado del CLI</option>
          {models?.map(option => (
            <option key={option.id} value={option.id}>
              {option.label}{option.id === preferred ? ' · guardado' : ''}
            </option>
          ))}
          {preferredIsMissing && (
            <option value={preferred}>{preferred} · guardado{models && !catalogError ? ' (fuera del catálogo)' : ''}</option>
          )}
          {selectionIsMissing && (
            <option value={model}>{model}{models && !catalogError ? ' (fuera del catálogo)' : ''}</option>
          )}
        </select>
      </label>
      <div className="ai-model-actions">
        <button type="button" className="btn btn-small btn-ghost" disabled={disabled || loading}
          onClick={() => void refresh()}>
          Actualizar modelos
        </button>
        {preferred !== null && model !== preferred && (
          <button type="button" className="btn btn-small btn-secondary" disabled={!canChange}
            onClick={() => void saveDefault()}>
            {saving ? 'Guardando…' : model ? 'Guardar como predeterminado' : 'Restablecer al modelo del CLI'}
          </button>
        )}
      </div>
      {loading && <p className="hint" role="status">Consultando modelos de Codex CLI…</p>}
      {catalogError && (
        <p className="hint" role="status">
          {models?.length ? 'Mostrando el último catálogo guardado. ' : ''}{catalogError}
        </p>
      )}
      {models?.length === 0 && !loading && !catalogError && (
        <p className="hint" role="status">Codex CLI no devolvió modelos elegibles.</p>
      )}
      {preferenceError && <p className="field-error" role="alert">{preferenceError}</p>}
    </div>
  );
}
