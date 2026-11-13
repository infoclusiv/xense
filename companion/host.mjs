#!/usr/bin/env node
// Chrome Native Messaging framing: little-endian uint32 followed by JSON bytes.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_MESSAGE = 1024 * 1024;
// The Windows launcher can select a specific Codex binary without changing global PATH.
const CODEX_BINARY = process.env.XENSE_CODEX_PATH || 'codex';
function send(data) {
  const bytes = Buffer.from(JSON.stringify(data));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(bytes.length);
  process.stdout.write(Buffer.concat([prefix, bytes]));
}
// Never return raw CLI logs to Chrome: stderr can include tweets, paths or credentials.
function classifyFailure(raw) {
  const log = raw.toLowerCase();
  if (/(not logged in|login required|authentication required|sign in|unauthorized|invalid api key|401\b)/i.test(log))
    return 'Parece un problema de autenticación. Ejecuta: codex login status';
  if (/(rate.limit|quota|usage.limit|429\b|too many requests)/i.test(log))
    return 'El proveedor parece haber alcanzado un límite de uso. Revisa el estado de tu plan.';
  if (/(sandbox|helper_unknown_error|setup refresh|createprocessasuserw|access is denied|permission denied)/i.test(log))
    return 'Codex podría tener un problema con el sandbox de Windows. Reproduce la prueba directamente en PowerShell.';
  if (/(unknown (argument|option)|unrecognized (argument|option)|unexpected argument|found argument)/i.test(log))
    return 'La versión del CLI podría no admitir estos argumentos. Ejecuta: codex exec --help';
  if (/(unknown model|model not found|model does not exist|unsupported model)/i.test(log))
    return 'El modelo configurado no parece estar disponible. Prueba dejando el campo Modelo vacío.';
  if (/(network|connection refused|could not resolve|connection reset|timed out|tls error)/i.test(log))
    return 'Parece un fallo de conectividad con el proveedor.';
  return 'Causa no identificada. Ejecuta una prueba de codex exec en PowerShell para obtener el diagnóstico.';
}

function execute(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let bytes = 0;
    let errors = '';
    let expired = false;
    const timeout = setTimeout(() => { expired = true; child.kill(); }, options.timeout ?? 150000);
    child.stdout.on('data', b => {
      bytes += b.length;
      if (bytes > MAX_MESSAGE) child.kill();
      else chunks.push(b);
    });
    child.stderr.on('data', b => { errors = (errors + b.toString('utf8')).slice(-8000); });
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (expired) return reject(new Error('Tiempo de ejecución agotado.'));
      if (bytes > MAX_MESSAGE) return reject(new Error('La respuesta superó el límite de tamaño.'));
      if (code !== 0) return reject(new Error('El CLI falló (código ' + code + '). ' + classifyFailure(errors + '\n' + Buffer.concat(chunks).toString('utf8').slice(-3000))));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}
async function inspectCli(binary) {
  try {
    const version = await execute(binary, ['--version'], { timeout: 10000 });
    return { installed: true, version: version.trim().split(/\r?\n/)[0].slice(0, 100) };
  } catch { return { installed: false }; }
}
async function analyze(request) {
  if (!['chatgpt_codex', 'opencode'].includes(request.provider)) throw new Error('Proveedor no admitido.');
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 75000)
    throw new Error('El contenido de análisis no es válido.');
  const model = typeof request.model === 'string' ? request.model.trim() : '';
  if (model && !/^[A-Za-z0-9._/+:-]{1,100}$/.test(model))
    throw new Error('Nombre de modelo no válido.');
  const folder = await mkdtemp(join(tmpdir(), 'xense-ai-'));
  try {
    let answer;
    if (request.provider === 'chatgpt_codex') {
      const output = join(folder, 'result.txt');
      const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', output];
      if (model) args.push('--model', model);
      args.push('-');
      await execute(CODEX_BINARY, args, { cwd: folder, input: request.prompt });
      answer = await readFile(output, 'utf8');
    } else {
      const source = join(folder, 'tweets.txt');
      await writeFile(source, request.prompt, { encoding: 'utf8', mode: 0o600 });
      const args = ['run', '--format', 'json', '--file', source];
      if (model) args.push('--model', model);
      args.push('Analiza el archivo proporcionado y devuelve solo el análisis. No uses herramientas.');
      const env = {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        }),
      };
      const raw = await execute('opencode', args, { cwd: folder, env });
      const parts = [];
      for (const line of raw.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'text' && typeof event.part?.text === 'string') parts.push(event.part.text);
        } catch { /* JSONL can have partial non-JSON lines */ }
      }
      answer = parts.join('');
    }
    if (!answer?.trim()) throw new Error('No se recibió un análisis del proveedor.');
    return { ok: true, text: answer.trim() };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
async function handle(request) {
  if (request?.type === 'PING') {
    const [codex, opencode] = await Promise.all([inspectCli(CODEX_BINARY), inspectCli('opencode')]);
    return {
      ok: true, version: '0.1.0',
      providers: {
        chatgpt_codex: { ...codex, label: 'ChatGPT mediante Codex CLI' },
        opencode: { ...opencode, label: 'OpenCode CLI' },
      },
    };
  }
  if (request?.type === 'ANALYZE') return analyze(request);
  throw new Error('Operación desconocida.');
}
let pending = Buffer.alloc(0);
let processing = false;
process.stdin.on('data', chunk => {
  if (processing) return;
  pending = Buffer.concat([pending, chunk]);
  if (pending.length < 4) return;
  const len = pending.readUInt32LE(0);
  if (len < 1 || len > MAX_MESSAGE) {
    processing = true;
    send({ ok: false, error: 'Mensaje demasiado grande.' });
    return;
  }
  if (pending.length < len + 4) return;
  processing = true;
  const body = pending.subarray(4, 4 + len);
  (async () => {
    try { send(await handle(JSON.parse(body.toString('utf8')))); }
    catch (e) { send({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  })();
});
