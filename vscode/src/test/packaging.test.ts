import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { listFiles } from '@vscode/vsce';

/**
 * Reproduz, sem precisar gerar o .vsix de verdade, exatamente o conjunto de arquivos que
 * `vsce package` embutiria (mesma função usada internamente pelo `vsce`, ver `@vscode/vsce`'s
 * `listFiles()`). Existe pra pegar em CI o bug real que já aconteceu 2026-07-17: `package.json`
 * declarava `serialport` em `dependencies`, mas o array `files` não incluía `node_modules` -- o
 * `.vsix` empacotado ficava sem NENHUMA dependência de runtime, e a extensão falhava na ativação
 * com "Cannot find module 'serialport'" assim que instalada (nunca detectado antes por não haver
 * teste nenhum de empacotamento, só de lógica de negócio). Roda contra o `node_modules` real do
 * checkout (precisa de `npm ci`/`npm install` antes, igual a `test:unit`).
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  main: string;
  dependencies?: Record<string, string>;
};

async function packagedFileSet(): Promise<Set<string>> {
  const files = await listFiles({ cwd: repoRoot });
  return new Set(files.map((file) => file.replace(/\\/g, '/')));
}

test('toda dependencia de runtime (package.json "dependencies") é embutida no .vsix', async () => {
  const runtimeDeps = Object.keys(pkg.dependencies ?? {});
  assert.ok(
    runtimeDeps.length > 0,
    'package.json não declara nenhuma "dependencies" -- se isso for esperado, revise este teste; caso contrário, "serialport" sumiu do package.json.'
  );

  const files = await packagedFileSet();
  const missing = runtimeDeps.filter((dep) => !files.has(`node_modules/${dep}/package.json`));
  assert.deepEqual(
    missing,
    [],
    `Dependência(s) de runtime ausente(s) do pacote: ${missing.join(', ')}. ` +
      `Verifique o array "files" em package.json -- precisa incluir "node_modules" (vsce trata "files" ` +
      `como allowlist; sem essa entrada, TODO o node_modules é excluído do .vsix, mesmo pacotes ` +
      `listados em "dependencies").`
  );
});

test('binário nativo do serialport para win32-x64 está incluído no .vsix', async () => {
  const nativeBinary = 'node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/node.napi.node';
  const files = await packagedFileSet();
  assert.ok(
    files.has(nativeBinary),
    `Binário nativo ausente do pacote: ${nativeBinary}. Sem ele, "require('serialport')" falha ao ` +
      `carregar o binding nativo na ativação (LasecPlot só é distribuído como .vsix "win32-x64").`
  );
});

test('o entry point declarado em "main" existe entre os arquivos empacotados', async () => {
  const mainEntry = pkg.main.replace(/^\.\//, '');
  const files = await packagedFileSet();
  assert.ok(files.has(mainEntry), `"main" (${pkg.main}) não está entre os arquivos que "vsce package" incluiria.`);
});
