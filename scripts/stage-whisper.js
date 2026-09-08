#!/usr/bin/env node
// Stages a RELOCATABLE whisper.cpp runtime into bin/whisper/ so it can ship in
// the VSIX and run from wherever the extension is installed.
//
// Three things make this necessary, all found the hard way:
//   1. cmake bakes an ABSOLUTE LC_RPATH pointing at the build tree. Copy the
//      binary anywhere else and dyld cannot find its dylibs. We rewrite it to
//      @loader_path, which resolves next to the binary itself.
//   2. The dylibs in build/bin are version symlinks (libX.0.dylib ->
//      libX.0.15.1.dylib). A VSIX is a zip; ship real files, named the way the
//      load commands ask for them.
//   3. Editing a Mach-O invalidates its signature, and Apple silicon KILLS
//      unsigned/invalid binaries on launch. Every touched file is re-signed
//      ad-hoc.
//
// Run: npm run stage:whisper   (after building whisper.cpp)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin');
const DEST = path.join(ROOT, 'bin/whisper');

// Exactly what whisper-cli's load commands ask for — nothing else. libparakeet
// is built but never referenced, so it does not ship.
const BINARY = 'whisper-cli';
const DYLIBS = [
  'libwhisper.1.dylib', 'libggml.0.dylib', 'libggml-cpu.0.dylib',
  'libggml-blas.0.dylib', 'libggml-metal.0.dylib', 'libggml-base.0.dylib'
];

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

function rpathsOf(file) {
  const lines = sh('otool', ['-l', file]).split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('LC_RPATH')) {
      for (let j = i; j < i + 4 && j < lines.length; j++) {
        const m = /^\s*path (.+?) \(offset/.exec(lines[j]);
        if (m) { found.push(m[1]); break; }
      }
    }
  }
  return found;
}

if (!fs.existsSync(path.join(SRC, BINARY))) {
  console.error(`whisper.cpp is not built.\n  expected: ${path.join(SRC, BINARY)}\n  build it: cd node_modules/nodejs-whisper/cpp/whisper.cpp && cmake -B build && cmake --build build --config Release -j`);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

let bytes = 0;
for (const name of [BINARY, ...DYLIBS]) {
  const from = fs.realpathSync(path.join(SRC, name));   // deref the symlink
  const to = path.join(DEST, name);                     // keep the expected name
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
  bytes += fs.statSync(to).size;

  for (const rp of rpathsOf(to)) {
    if (rp !== '@loader_path') { sh('install_name_tool', ['-delete_rpath', rp, to]); }
  }
  if (!rpathsOf(to).includes('@loader_path')) {
    sh('install_name_tool', ['-add_rpath', '@loader_path', to]);
  }
  sh('codesign', ['--force', '--sign', '-', to]);       // Apple silicon requires this
  console.log(`  staged ${name.padEnd(24)} rpath=${rpathsOf(to).join(',') || '(none)'}`);
}

// Prove it: no absolute rpath may survive, or this breaks on someone else's disk.
const leaked = [BINARY, ...DYLIBS]
  .map(n => [n, rpathsOf(path.join(DEST, n)).filter(p => p.startsWith('/'))])
  .filter(([, p]) => p.length);
if (leaked.length) {
  console.error('ABSOLUTE RPATH SURVIVED — this will not run once installed:', leaked);
  process.exit(1);
}
console.log(`\nstaged ${1 + DYLIBS.length} files, ${(bytes / 1048576).toFixed(2)} MB -> bin/whisper/`);
