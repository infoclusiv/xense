import {
  makeAnalysisPrompts, makeSynthesisPrompt, SYNTHESIS_BATCH_SIZE,
  type AiAnalysis, type AiAnalysisType, type AiProvider,
} from './analysis';
import { buildInfographic, infographicMarkdown } from './infographic';
import { collectAnalysisContext } from './context';
import type { ContextEvidence } from './evidence';
import type { Transcription } from './transcript';
import { nativeRequest } from './native';
import type { RunData } from '../types';

interface AnalysisOptions {
  provider: AiProvider;
  model: string;
  kind: AiAnalysisType;
  instruction: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
  enrich?: boolean;
  transcriptImports?: ReadonlyMap<string, Transcription>;
}

export async function analyzeCollection(data: RunData, options: AnalysisOptions): Promise<AiAnalysis> {
  const { provider, kind, instruction, signal, onProgress } = options;
  const model = options.model.trim();
  if (kind === 'custom' && !instruction.trim()) throw new Error('Escribe qué quieres analizar.');
  const { posts, evidence } = await collectAnalysisContext(data.posts, { ...options, model, runId: data.run.id });
  const { prompts, processed, skipped } = makeAnalysisPrompts(posts, kind, instruction, evidence);
  if (!prompts.length) throw new Error('No hay publicaciones para analizar.');
  const sources = new Map<string, ContextEvidence>();
  for (const entries of evidence.values()) {
    for (const { source } of entries) sources.set(source.id, source);
  }
  const contextCoverage = { complete: 0, partial: 0, unavailable: 0, skipped: 0 };
  for (const source of sources.values()) contextCoverage[source.status] += 1;
  const reportData = { ...data, posts };

  const ask = async (prompt: string) => {
    signal.throwIfAborted();
    const response = await nativeRequest({ type: 'ANALYZE', provider, model, prompt });
    signal.throwIfAborted();
    if (!response.text?.trim()) throw new Error('El proveedor no devolvió un resultado.');
    return response.text;
  };

  let finalPrompt = prompts[0]!;
  if (prompts.length > 1) {
    let notes: string[] = [];
    for (const [index, prompt] of prompts.entries()) {
      onProgress(`Analizando lote ${index + 1} de ${prompts.length}…`);
      notes.push(await ask(prompt));
    }

    while (notes.length > SYNTHESIS_BATCH_SIZE) {
      const condensed: string[] = [];
      const groups = Math.ceil(notes.length / SYNTHESIS_BATCH_SIZE);
      for (let start = 0; start < notes.length; start += SYNTHESIS_BATCH_SIZE) {
        const group = notes.slice(start, start + SYNTHESIS_BATCH_SIZE);
        if (group.length === 1) {
          condensed.push(group[0]!);
          continue;
        }
        onProgress(`Consolidando grupo ${condensed.length + 1} de ${groups}…`);
        condensed.push(await ask(makeSynthesisPrompt(group, kind, instruction, false)));
      }
      notes = condensed;
    }

    finalPrompt = makeSynthesisPrompt(notes, kind, instruction);
  }

  onProgress('Preparando la infografía…');
  const answer = await ask(finalPrompt);
  let infographic;
  try {
    infographic = buildInfographic(answer, reportData, sources);
  } catch {
    onProgress('Volviendo a solicitar el formato de la infografía…');
    const correction = 'Devuelve únicamente el JSON solicitado. Usa IDs exactos de publicaciones o fuentes recuperadas del material suministrado.\n\n';
    infographic = buildInfographic(await ask(correction + finalPrompt), reportData, sources);
  }

  return {
    id: crypto.randomUUID(),
    runId: data.run.id,
    createdAt: new Date().toISOString(),
    provider,
    model,
    kind,
    prompt: kind === 'custom' ? instruction.trim() : '',
    result: infographicMarkdown(infographic, contextCoverage),
    infographic,
    processedPosts: processed,
    skippedPosts: skipped,
    chunkCount: prompts.length,
    contextCoverage,
  };
}
