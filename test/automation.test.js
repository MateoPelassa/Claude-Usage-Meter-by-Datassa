const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSpawn, cmdPath } = require('../src/automation');

const ENV = { ComSpec: 'C:\\Windows\\system32\\cmd.exe', SystemRoot: 'C:\\Windows', PATH: 'C:\\x' };

test('claude.exe se lanza directo, sin cmd, e ignorando la carpeta actual al buscar programas', () => {
  const s = buildSpawn('C:\\Users\\Ana\\.local\\bin\\claude.exe', ['-p', 'seguí', '--resume', 'abc12345'], ENV);
  assert.equal(s.file, 'C:\\Users\\Ana\\.local\\bin\\claude.exe');
  assert.deepEqual(s.args, ['-p', 'seguí', '--resume', 'abc12345']);
  assert.equal(s.options.env.NoDefaultCurrentDirectoryInExePath, '1');
});

test('claude.cmd va por el cmd.exe absoluto y con comillas que aguantan espacios', () => {
  const s = buildSpawn('C:\\Users\\Ana Pérez\\AppData\\Roaming\\npm\\claude.cmd', ['-p', 'seguí con lo que estabas haciendo', '--resume', 'abc12345'], ENV);
  assert.equal(s.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(s.args[3], '""C:\\Users\\Ana Pérez\\AppData\\Roaming\\npm\\claude.cmd" "-p" "seguí con lo que estabas haciendo" "--resume" "abc12345""');
  assert.equal(s.options.windowsVerbatimArguments, true);
  assert.equal(s.options.env.NoDefaultCurrentDirectoryInExePath, '1');
});

test('un argumento con comillas o % no llega a cmd.exe', () => {
  assert.throws(() => buildSpawn('C:\\npm\\claude.cmd', ['-p', 'hola" & calc & "'], ENV));
  assert.throws(() => buildSpawn('C:\\npm\\claude.cmd', ['-p', '%PATH%'], ENV));
  // Los demás metacaracteres quedan dentro de comillas y cmd no los interpreta.
  assert.doesNotThrow(() => buildSpawn('C:\\npm\\claude.cmd', ['-p', 'a & b | c > d'], ENV));
});

test('cmdPath no acepta un ComSpec relativo ni de otro programa', () => {
  assert.equal(cmdPath({ ComSpec: 'cmd.exe', SystemRoot: 'D:\\Win' }), path.join('D:\\Win', 'System32', 'cmd.exe'));
  assert.equal(cmdPath({ ComSpec: 'C:\\otro\\powershell.exe', SystemRoot: 'C:\\Windows' }), path.join('C:\\Windows', 'System32', 'cmd.exe'));
});

// De punta a punta, con archivos inofensivos en una carpeta temporal: un node.cmd plantado en la carpeta de la sesión
// no debe ejecutarse cuando el shim claude.cmd llama a "node" sin ruta. Es justo lo que pasaba antes del arreglo.
test('un node.cmd plantado en la carpeta de la sesión no se ejecuta', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medidor-spawn-'));
  try {
    const cwd = path.join(root, 'repo clonado');
    const bin = path.join(root, 'npm con espacios');
    fs.mkdirSync(cwd);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(cwd, 'node.cmd'), '@echo off\r\necho PLANTADO\r\n');
    // El shim imita al de npm: llama a "node" sin ruta. El node real deja sus argumentos en un archivo.
    const outf = path.join(root, 'args.json');
    fs.writeFileSync(path.join(bin, 'args.js'), "require('fs').writeFileSync(process.env.OUTF, JSON.stringify(process.argv.slice(2)))");
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0args.js" %*\r\n');
    const env = { ...process.env, OUTF: outf };
    delete env.NoDefaultCurrentDirectoryInExePath; // el widget lanzado desde Windows no la hereda
    const args = ['-p', 'Continuá con lo que estabas haciendo, desde donde lo dejaste.', '--resume', 'abc12345'];
    const s = buildSpawn(path.join(bin, 'claude.cmd'), args, env);
    const r = spawnSync(s.file, s.args, { ...s.options, cwd, encoding: 'utf8' });
    assert.ok(!r.stdout.includes('PLANTADO'), 'corrió el node.cmd plantado');
    assert.deepEqual(JSON.parse(fs.readFileSync(outf, 'utf8')), args);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
