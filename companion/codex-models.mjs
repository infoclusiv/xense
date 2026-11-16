import { createInterface } from 'node:readline';

export const MODEL_ID = /^(?!-)[A-Za-z0-9._/+:-]{1,100}$/;

// Codex app-server uses one JSON-RPC message per line on stdio.
export function listCodexModels(child, maxBytes) {
  return new Promise((resolve, reject) => {
    const models = new Map();
    const cursors = new Set();
    let requestId = 1;
    let bytes = 0;
    let finished = false;
    let lines;

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      lines?.close();
      child.stdin.end();
      if (error) {
        child.kill();
        reject(new Error(error));
      } else {
        resolve([...models.values()]);
      }
    }

    function send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }

    function requestPage(cursor) {
      requestId += 1;
      send({ id: requestId, method: 'model/list', params: { cursor, limit: 100, includeHidden: false } });
    }

    const timeout = setTimeout(() => finish('Codex tardó demasiado en responder al consultar los modelos.'), 20000);
    child.on('error', () => finish('No se pudo iniciar Codex CLI para consultar los modelos.'));
    child.on('close', () => finish('Codex CLI se cerró antes de devolver el catálogo. Comprueba la conexión.'));
    child.stdin.on('error', () => finish('No se pudo comunicar con el servidor local de Codex CLI.'));
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) finish('El catálogo de Codex superó el límite de tamaño.');
    });

    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (finished) return;
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      if (reply?.id !== requestId) return;
      if (reply.error) {
        finish(reply.error.code === -32601
          ? 'Esta versión de Codex CLI no admite el catálogo de modelos. Actualiza el CLI.'
          : 'Codex CLI no pudo devolver el catálogo de modelos. Comprueba la conexión o vuelve a actualizar.');
        return;
      }
      if (requestId === 1) {
        send({ method: 'initialized' });
        requestPage(null);
        return;
      }
      if (!Array.isArray(reply.result?.data)) {
        finish('Codex CLI devolvió un catálogo de modelos con un formato inesperado.');
        return;
      }

      for (const model of reply.result.data) {
        const id = model?.model;
        if (model?.hidden || typeof id !== 'string' || !MODEL_ID.test(id) || models.has(id)) continue;
        if (Array.isArray(model.inputModalities) && !model.inputModalities.includes('text')) continue;
        const label = typeof model.displayName === 'string' ? model.displayName.trim().slice(0, 120) : '';
        models.set(id, { id, label: label || id });
      }

      const cursor = reply.result.nextCursor;
      if (typeof cursor === 'string' && cursor) {
        if (cursors.has(cursor)) {
          finish('Codex CLI devolvió una página repetida del catálogo de modelos.');
          return;
        }
        cursors.add(cursor);
        requestPage(cursor);
      } else {
        finish();
      }
    });

    send({ id: requestId, method: 'initialize', params: { clientInfo: { name: 'xense', title: 'Xense', version: '0.1.0' } } });
  });
}
