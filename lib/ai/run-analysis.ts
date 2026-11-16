import {
  makeAnalysisPrompts, makeSynthesisPrompt, SYNTHESIS_BATCH_SIZE,
  type AiAnalysis, type AiAnalysisType, type AiProvider,
} from './analysis';
import { buildInfographic, infographicMarkdown } from './infographic';
import { nativeRequest } from './native';
import type { RunData } from '../types';

interface AnalysisOptions {
  provider: AiProvider;
  model: string;
  kind: AiAnalysisType;
  instruction: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export async function analyzeCollection(data: RunData, options: AnalysisOptions): Promise<AiAnalysis> {
  const { provider, kind, instruction, signal, onProgress } = options;
  const model = options.model.trim();
  const { prompts, processed, skipped } = makeAnalysisPrompts(data.posts, kind, instruction);
  if (!prompts.length) throw new Error('No hay publicaciones para analizar.');

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
    infographic = buildInfographic(answer, data);
  } catch {
    onProgress('Volviendo a solicitar el formato de la infografía…');
    const correction = 'Devuelve únicamente el JSON solicitado. Comprueba que cada hallazgo cite IDs exactos de las publicaciones de entrada.\n\n';
    infographic = buildInfographic(await ask(correction + finalPrompt), data);
  }

  return {
    id: crypto.randomUUID(),
    runId: data.run.id,
    createdAt: new Date().toISOString(),
    provider,
    model,
    kind,
    prompt: kind === 'custom' ? instruction.trim() : '',
    result: infographicMarkdown(infographic),
    infographic,
    processedPosts: processed,
    skippedPosts: skipped,
    chunkCount: prompts.length,
  };
}
