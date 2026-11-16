import type { Ref } from 'react';
import type { AiAnalysis } from '../../lib/ai/analysis';
import type { Infographic } from '../../lib/ai/infographic';
import { contextCoverageText } from '../../lib/ai/evidence';
import { transcriptLink, transcriptTime } from '../../lib/ai/transcript';
import type { PostType } from '../../lib/types';
import { shortRunDate } from '../../lib/ui/api';
import '../../assets/infographic.css';

const TYPES: ReadonlyArray<{ type: PostType; label: string }> = [
  { type: 'original', label: 'Originales' },
  { type: 'reply', label: 'Respuestas' },
  { type: 'quote', label: 'Citas' },
  { type: 'repost', label: 'Reposts' },
];
const number = new Intl.NumberFormat('es');

interface Props {
  report: Infographic;
  analysis: AiAnalysis;
  articleRef: Ref<HTMLElement>;
}

export default function InfographicView({ report, analysis, articleRef }: Props) {
  const { collection } = report;
  const activityPeak = Math.max(1, ...collection.activity.map(item => item.count));
  const provider = analysis.provider === 'chatgpt_codex' ? 'Codex CLI' : 'OpenCode CLI';
  const contextSummary = contextCoverageText(analysis.contextCoverage);

  return (
    <article className="infographic" aria-labelledby="infographic-title" ref={articleRef}>
      <header className="ig-hero">
        <div className="ig-hero-content">
          <p className="ig-kicker">{collection.name} <span aria-hidden="true">/</span> {collection.period}</p>
          <h3 id="infographic-title">{report.title}</h3>
          <p className="ig-takeaway">{report.takeaway}</p>
        </div>
      </header>

      <dl className="ig-metrics">
        <div><dt>Publicaciones</dt><dd>{number.format(collection.total)}</dd></div>
        <div><dt>Autores</dt><dd>{number.format(collection.authors)}</dd></div>
        <div><dt>Días con actividad</dt><dd>{number.format(collection.activeDays)}</dd></div>
      </dl>

      <div className="ig-body">
        <section className="ig-section" aria-labelledby="ig-findings-title">
          <h4 id="ig-findings-title">Hallazgos clave</h4>
          <ul className="ig-findings">
            {report.findings.map((finding, index) => (
              <li className="ig-finding" key={index}>
                <h5>{finding.title}</h5>
                <p>{finding.detail}</p>
                <div className="ig-sources">
                  {finding.sources.map(source => (
                    <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer">
                      {source.title ?? `@${source.handle}`}
                      {source.method ? ` · ${source.method}` : source.createdAt && ` · ${shortRunDate(source.createdAt, collection.timezone)}`}
                      {' '}<span aria-hidden="true">↗</span>
                    </a>
                  ))}
                </div>
                {finding.sources.map(source => source.moments?.length ? (
                  <details className="ig-frames" key={source.id}>
                    <summary>Fotogramas · {source.title ?? 'Video o GIF'}</summary>
                    <ul>
                      {source.moments.map((moment, index) => (
                        <li key={index}><strong>{number.format(moment.seconds)} s</strong> · {moment.text}</li>
                      ))}
                    </ul>
                  </details>
                ) : null)}
                {finding.sources.map(source => source.transcript?.length ? (
                  <details className="ig-frames" key={source.id + '-transcript'}>
                    <summary>Transcripción · {source.title ?? 'Video'}</summary>
                    <ul>
                      {source.transcript.map((segment, index) => {
                        const url = transcriptLink(source.url, segment.start);
                        const time = transcriptTime(segment.start);
                        return <li key={index}>
                          {url ? <a href={url} target="_blank" rel="noopener noreferrer">{time}</a> : <strong>{time}</strong>}
                          {' · '}{segment.text}
                        </li>;
                      })}
                    </ul>
                  </details>
                ) : null)}
              </li>
            ))}
          </ul>
        </section>

        <section className="ig-section" aria-labelledby="ig-stats-title">
          <h4 id="ig-stats-title">La recolección en cifras</h4>
          <div className="ig-charts">
            {collection.activity.length > 0 && (
              <figure className="ig-chart">
                <figcaption>Volumen de publicaciones</figcaption>
                <ul className="ig-activity" tabIndex={0} aria-label="Publicaciones por tramo de fechas">
                  {collection.activity.map(({ label, range, count }) => (
                    <li key={range} aria-label={`${range} · ${number.format(count)} publicaciones`}>
                      <span className="ig-volume" title={`${range} · ${number.format(count)} publicaciones`} aria-hidden="true">
                        <span className="ig-column" style={{ height: `${100 * count / activityPeak}%` }}>
                          <span className="ig-column-value">{number.format(count)}</span>
                        </span>
                      </span>
                      <span className="ig-date" aria-hidden="true">{label}</span>
                    </li>
                  ))}
                </ul>
                <p className="ig-chart-note">{collection.timezone}</p>
              </figure>
            )}
            <figure className="ig-chart">
              <figcaption>Tipos de publicación</figcaption>
              <ul className="ig-types">
                {TYPES.map(({ type, label }) => {
                  const count = collection.byType[type];
                  const share = count / Math.max(1, collection.total);
                  return (
                    <li key={type} className={`ig-type-${type}`}>
                      <div><span>{label}</span><strong>{number.format(count)}</strong></div>
                      <span className="ig-type-track" aria-hidden="true">
                        <span style={{ width: `${share * 100}%` }} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </figure>
          </div>
        </section>

        {(analysis.skippedPosts > 0 || report.limitation || contextSummary || !!report.transcriptNotes?.length) && (
          <aside className="ig-scope" aria-label="Alcance del análisis">
            <strong>Alcance del análisis</strong>
            {report.limitation && <p>{report.limitation}</p>}
            {contextSummary && <p>{contextSummary}</p>}
            {report.transcriptNotes?.map(note => (
              <p key={note.url}><a href={note.url} target="_blank" rel="noopener noreferrer">{note.label}</a> · {note.detail}</p>
            ))}
            {analysis.skippedPosts > 0 && (
              <p>Publicaciones sin identificador omitidas del análisis · {number.format(analysis.skippedPosts)}</p>
            )}
          </aside>
        )}

        <footer className="ig-footer">
          <span>Xense · {provider}{analysis.model && ` · ${analysis.model}`}</span>
          <span>{number.format(analysis.processedPosts)} publicaciones analizadas · {shortRunDate(analysis.createdAt, collection.timezone)}</span>
        </footer>
      </div>
    </article>
  );
}
