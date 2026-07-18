#!/usr/bin/env node
"use strict";

/**
 * O LasecPlot só é distribuído como um .vsix específico de plataforma ("win32-x64", ver o script
 * "package" do package.json e o workflow de release). `@serialport/bindings-cpp` embute, dentro do
 * próprio pacote npm, o binário nativo pré-compilado de TODAS as plataformas suportadas
 * (android-arm(64), darwin, linux-*, win32-ia32, win32-x64 -- gerado via `prebuildify`), então um
 * `npm install` normal (em qualquer SO) já traz todos eles. Sem poda, cada .vsix win32-x64 embutiria
 * ~7 binários nativos que nunca vão rodar nessa plataforma -- não é um bug funcional (o loader
 * `node-gyp-build` já escolhe certo o binário do processo atual em runtime), só desperdício de
 * tamanho. Roda como `prepackage` (hook automático do npm antes de `npm run package`) -- nunca
 * durante `compile`/`watch`/`test`, pra não atrapalhar o node_modules "cheio" que outros scripts
 * podem precisar. Falha graciosamente (loga e sai 0) se a estrutura de prebuilds mudar num futuro
 * upgrade de dependência -- poda é uma otimização de tamanho, nunca deveria quebrar o build.
 */

const fs = require("fs");
const path = require("path");

const TARGET_PLATFORM_DIR = "win32-x64";
const prebuildsDir = path.join(__dirname, "..", "node_modules", "@serialport", "bindings-cpp", "prebuilds");

function main() {
  if (!fs.existsSync(prebuildsDir)) {
    console.log(`[prune-foreign-prebuilds] ${prebuildsDir} não existe (dependência mudou de layout?) -- nada a podar.`);
    return;
  }

  const entries = fs.readdirSync(prebuildsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const toRemove = entries.filter((entry) => entry.name !== TARGET_PLATFORM_DIR);
  const kept = entries.find((entry) => entry.name === TARGET_PLATFORM_DIR);

  if (!kept) {
    console.warn(
      `[prune-foreign-prebuilds] AVISO: prebuild de "${TARGET_PLATFORM_DIR}" não encontrado em ${prebuildsDir} -- ` +
      `o .vsix seria empacotado SEM o binário nativo da plataforma alvo. Abortando a poda (nada removido) ` +
      `para não mascarar esse problema -- corrija a instalação de dependências antes de empacotar.`
    );
    process.exitCode = 1;
    return;
  }

  for (const entry of toRemove) {
    fs.rmSync(path.join(prebuildsDir, entry.name), { recursive: true, force: true });
  }
  console.log(`[prune-foreign-prebuilds] Mantido apenas "${TARGET_PLATFORM_DIR}"; removidas ${toRemove.length} plataforma(s): ${toRemove.map((e) => e.name).join(", ") || "(nenhuma)"}.`);
}

main();
