import { useState } from 'react';
import { parseTranscription, youtubeUrl, youtubeVideoId, type Transcription } from '../../lib/ai/transcript';

interface Props {
  disabled: boolean;
  imports: ReadonlyMap<string, Transcription>;
  onChange: (id: string, transcript?: Transcription) => void;
}

export default function TranscriptImport({ disabled, imports, onChange }: Props) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [importing, setImporting] = useState(false);

  async function importFile(file: File) {
    const id = youtubeVideoId(url.trim());
    if (!id || !/\.(vtt|srt)$/i.test(file.name) || file.size > 1_000_000) {
      setStatus('Ingresa un enlace de YouTube y selecciona un archivo SRT o VTT de hasta 1 MB.');
      return;
    }
    setImporting(true);
    try {
      const transcript = parseTranscription({ status: 'ready', origin: 'imported', text: await file.text() });
      if (transcript.status !== 'ready') {
        setStatus('El archivo no contiene subtítulos con marcas de tiempo reconocibles.');
        return;
      }
      onChange(id, transcript);
      setStatus(`Subtítulos importados para ${id}. Se usarán si el video aparece en la recolección.`);
    } catch {
      setStatus('No se pudo leer el archivo de subtítulos.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <details className="options-card">
      <summary>Importar subtítulos de YouTube</summary>
      <div className="ai-form">
        <label>
          Enlace del video
          <input className="input" type="url" placeholder="https://www.youtube.com/watch?v=…" value={url}
            disabled={disabled || importing} onChange={event => setUrl(event.target.value)} />
        </label>
        <label>
          Archivo SRT o VTT
          <input className="input" type="file" accept=".srt,.vtt" disabled={disabled || importing} onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importFile(file);
          }} />
        </label>
      </div>
      {status && <p className="hint" role="status">{status}</p>}
      {imports.size > 0 && <ul>
        {[...imports].map(([id, transcript]) => <li key={id}>
          <a href={youtubeUrl(id)} target="_blank" rel="noopener noreferrer">{id}</a>
          {' · '}{transcript.segments.length} segmentos{' '}
          <button className="btn btn-ghost" type="button" disabled={disabled} onClick={() => onChange(id)}>Quitar</button>
        </li>)}
      </ul>}
    </details>
  );
}
