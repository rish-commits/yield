// Local speech-to-text: whisper.cpp, spawned as a subprocess.
//
// Deliberately free of any `vscode` import — like gate.ts and questions.ts, this
// is a pure unit so the rules can be tested directly instead of inferred from
// the extension's behaviour. The extension passes paths in.
//
// WHY A SUBPROCESS AND NOT A NATIVE BINDING: the extension host is Electron's
// Node (24.x, module ABI 137), which is NOT the Node that built anything on the
// developer's machine (25.x, ABI 141). An in-process N-API addon has to match;
// a spawned Mach-O binary does not care at all. That is the whole reason
// nodejs-whisper won over smart-whisper — it shells out. nodejs-whisper itself
// is a devDependency that BUILDS whisper.cpp; at runtime we spawn the staged
// binary directly, so none of its npm tree needs to ship.
//
// The binary ships in the VSIX at bin/whisper/ (see scripts/stage-whisper.js,
// which makes it relocatable). The MODEL does not ship — it is ~141 MB and is
// downloaded once into the extension's global storage.

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

/**
 * THE VOICE FEATURE FLAG. One boolean, one place.
 *
 * OFF for v1 because voice cannot work in this shell: extension webviews are
 * hosted in an iframe whose Permissions Policy grants only
 * `cross-origin-isolated`, `autoplay`, `local-network-access` and the clipboard
 * (Antigravity's `…/webview/browser/pre/index.html`, where allowRules is built).
 * `microphone` is never delegated and no webview option can add it, so
 * getUserMedia can never succeed from the panel. That is the VS Code webview
 * model, not an Antigravity quirk.
 *
 * Everything downstream of capture is BUILT AND TESTED and stays in the tree:
 * the staged whisper binary, media/wav.js, the v78 voice states and their CSS,
 * the transcribe/retry host path. v1.1 flips this to true — most likely
 * alongside a native recorder spawned from the host, which has no permission
 * policy over it.
 *
 * What it gates:
 *   - extension.ts: the `voice` capability it reports, so runTranscription
 *     refuses and no host-side voice work ever runs
 *   - the `no-voice` class painted onto the card, which hides the mic and
 *     rebalances the composer's right padding for one button
 *   - the webview removes the mic node outright on the first render
 */
export const VOICE_ENABLED = false;

/** base.en — the brief's pick. English-only; multilingual would be `base`. */
export const MODEL_NAME = 'ggml-base.en.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;
/** Anything much smaller than this is a truncated or error-page download. */
const MODEL_MIN_BYTES = 100 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export type VoiceSupport =
  | { ok: true; binary: string }
  /** `reason` is user-facing: it becomes the disabled mic's tooltip. */
  | { ok: false; reason: string };

/**
 * Whether voice can run at all here.
 *
 * The staged binary is arm64 macOS ONLY — that is what we compiled. Everywhere
 * else the mic must stay honestly disabled rather than fail at click time, so
 * this is checked BEFORE the button is ever enabled, not inside the handler.
 *
 * `platform`/`arch` are injectable purely so the fallback can be tested without
 * another machine.
 */
export function checkVoiceSupport(
  extensionRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (p: string) => boolean = (p) => { try { require('fs').accessSync(p); return true; } catch { return false; } }
): VoiceSupport {
  if (platform !== 'darwin') {
    return { ok: false, reason: `Voice needs macOS on Apple silicon — this is ${platform}` };
  }
  if (arch !== 'arm64') {
    return { ok: false, reason: `Voice needs Apple silicon — this Mac is ${arch}` };
  }
  const binary = binaryPath(extensionRoot);
  if (!exists(binary)) {
    return { ok: false, reason: 'Voice engine is missing from this install' };
  }
  return { ok: true, binary };
}

export function binaryPath(extensionRoot: string): string {
  return path.join(extensionRoot, 'bin', 'whisper', 'whisper-cli');
}

export function modelFile(cacheDir: string): string {
  return path.join(cacheDir, MODEL_NAME);
}

export async function modelIsCached(cacheDir: string): Promise<boolean> {
  try {
    const st = await fs.stat(modelFile(cacheDir));
    return st.size >= MODEL_MIN_BYTES;
  } catch {
    return false;
  }
}

/**
 * Downloads the model once, into the extension's global storage. Never bundled:
 * it is ~141 MB and the VSIX has no business carrying it.
 *
 * Downloads to a `.part` file and renames on success, so a cancelled or failed
 * download can never leave a half-written model that looks cached.
 */
export async function ensureModel(
  cacheDir: string,
  onProgress?: (pct: number, receivedBytes: number, totalBytes: number) => void
): Promise<string> {
  const target = modelFile(cacheDir);
  if (await modelIsCached(cacheDir)) { return target; }

  await fs.mkdir(cacheDir, { recursive: true });
  const part = `${target}.part`;
  await fs.rm(part, { force: true });

  await new Promise<void>((resolve, reject) => {
    const get = (url: string, redirectsLeft: number) => {
      const req = https.get(url, { headers: { 'User-Agent': 'yield-extension' } }, (res) => {
        // HuggingFace redirects to a CDN; follow it.
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) { reject(new Error('too many redirects fetching the model')); return; }
          get(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`model download failed: HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        let lastPct = -1;
        const out = createWriteStream(part);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (onProgress && total) {
            const pct = Math.floor((received / total) * 100);
            if (pct !== lastPct) { lastPct = pct; onProgress(pct, received, total); }
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        // The offline case, said plainly rather than as a raw errno.
        if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
          reject(new Error('no network — the voice model could not be downloaded'));
        } else {
          reject(err);
        }
      });
      req.setTimeout(60_000, () => req.destroy(new Error('model download timed out')));
    };
    get(MODEL_URL, 5);
  }).catch(async (err) => {
    await fs.rm(part, { force: true });
    throw err;
  });

  const st = await fs.stat(part);
  if (st.size < MODEL_MIN_BYTES) {
    await fs.rm(part, { force: true });
    throw new Error(`model download was truncated (${st.size} bytes)`);
  }
  await fs.rename(part, target);   // atomic: only a complete file is ever cached
  return target;
}

/**
 * Marker written after the first successful run. Its absence is what tells us
 * to show "Preparing voice…" BEFORE spawning: the very first execution of the
 * freshly installed binaries costs ~15s while macOS verifies them
 * (Gatekeeper/XProtect across 7 new Mach-O files), and without a state up front
 * that reads as a dead mic click.
 */
export function firstRunMarker(cacheDir: string): string {
  return path.join(cacheDir, '.voice-verified');
}

export async function isVerified(cacheDir: string): Promise<boolean> {
  try {
    await fs.access(firstRunMarker(cacheDir));
    return true;
  } catch {
    return false;
  }
}

export type TranscribeOptions = {
  /** a complete 16 kHz mono PCM WAV, produced by the webview */
  wav: Buffer;
  extensionRoot: string;
  cacheDir: string;
  onStage?: (stage: 'downloading' | 'preparing' | 'transcribing', pct?: number) => void;
};

/**
 * WAV in, text out. The audio is already 16 kHz mono (media/wav.js builds it
 * that way), which is what lets us skip ffmpeg entirely — whisper.cpp's own
 * wrapper only reaches for ffmpeg when the input needs resampling.
 */
export async function transcribe(opts: TranscribeOptions): Promise<string> {
  const support = checkVoiceSupport(opts.extensionRoot);
  if (!support.ok) { throw new Error(support.reason); }

  if (!(await modelIsCached(opts.cacheDir))) {
    opts.onStage?.('downloading', 0);
    await ensureModel(opts.cacheDir, (pct) => opts.onStage?.('downloading', pct));
  }
  const model = modelFile(opts.cacheDir);

  const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'yield-voice-')), 'clip.wav');
  await fs.writeFile(tmp, opts.wav);

  // Announce BEFORE the spawn, not after — on a fresh install the spawn itself
  // is the slow part.
  const verified = await isVerified(opts.cacheDir);
  opts.onStage?.(verified ? 'transcribing' : 'preparing');
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(support.binary, [
        '-m', model,
        '-f', tmp,
        '-np',            // no progress/system banner
        '-nt'             // no timestamps: we want a clean sentence
      ], { cwd: path.dirname(support.binary) });

      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('transcription timed out'));
      }, TRANSCRIBE_TIMEOUT_MS);

      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`whisper exited ${code}: ${err.trim().split('\n').pop() || 'no output'}`));
          return;
        }
        // It ran, so the binaries are verified from here on. Best-effort: a
        // failed marker write only costs one extra "Preparing voice…".
        if (!verified) {
          fs.mkdir(opts.cacheDir, { recursive: true })
            .then(() => fs.writeFile(firstRunMarker(opts.cacheDir), new Date().toISOString(), 'utf8'))
            .catch(() => { /* cosmetic only */ });
        }
        resolve(cleanTranscript(out));
      });
    });
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true });
  }
}

/**
 * whisper-cli emits the text plus, in some builds, bracketed timestamps and
 * non-speech markers like [BLANK_AUDIO] or (wind blowing). None of that belongs
 * in the composer.
 */
export function cleanTranscript(raw: string): string {
  return String(raw)
    .split('\n')
    .map((l) => l.replace(/^\s*\[[0-9:.\s\->]+\]\s*/, '').trim())
    .join(' ')
    .replace(/\[(BLANK_AUDIO|INAUDIBLE|MUSIC|SOUND|NOISE)\]/gi, ' ')
    .replace(/\((?:[^)]*(?:music|silence|noise|inaudible|blank)[^)]*)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
