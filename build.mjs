// Gera a extensão pronta para carregar no navegador.
//
//   node build.mjs public    -> dist/public  (padrões neutros; é o que vai para o GitHub)
//   node build.mjs dev       -> dist/dev     (padrões + config/dev.json, que é só seu)
//   node build.mjs release   -> release/model-asker-v<versão>.zip (build public + host)
//   adicione --watch para refazer a cada alteração
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? "public";
const watch = process.argv.includes("--watch");
const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

if (!["public", "dev", "release"].includes(target)) {
  console.error(`Alvo desconhecido: ${target} (use public, dev ou release)`);
  process.exit(1);
}

const flavor = target === "dev" ? "dev" : "public";
const outDir = path.join(root, "dist", flavor);

// Padrões das configurações: os públicos, e no dev os seus por cima.
const defaults = readJson("config/defaults.json");
if (flavor === "dev") {
  const devFile = path.join(root, "config", "dev.json");
  if (fs.existsSync(devFile)) {
    const { _comment, ...overrides } = JSON.parse(fs.readFileSync(devFile, "utf8"));
    Object.assign(defaults, overrides);
  } else {
    console.warn("config/dev.json não existe; usando só os padrões (copie de config/dev.example.json).");
  }
}

function copyStatic() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(path.join(root, "extension"), outDir, { recursive: true });

  const manifest = readJson("extension/manifest.json");
  if (flavor === "dev") manifest.name += " (dev)";
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Lido pelo content script e pela página de opções.
  fs.writeFileSync(
    path.join(outDir, "defaults.js"),
    `globalThis.MODEL_ASKER_DEFAULTS = ${JSON.stringify(defaults, null, 2)};\n`,
  );
  return manifest;
}

const manifest = copyStatic();
const buildOptions = {
  entryPoints: [path.join(root, "src", "background.js")],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outfile: path.join(outDir, "background.js"),
  // __DEV__ liga o log detalhado de cada pergunta (logs/ na pasta do projeto).
  define: { __DEFAULTS__: JSON.stringify(defaults), __DEV__: JSON.stringify(flavor === "dev") },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  fs.watch(path.join(root, "extension"), { recursive: true }, () => copyStatic());
  console.log(`Observando alterações (${flavor})…`);
} else {
  await esbuild.build(buildOptions);
  console.log(`Extensão ${flavor} pronta em dist/${flavor}`);
}

if (target === "release") {
  // Pacote para o GitHub: extensão compilada + host (sem arquivos gerados pelo install).
  const stage = path.join(root, "release", "stage");
  const zip = path.join(root, "release", `model-asker-v${manifest.version}.zip`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, "host"), { recursive: true });
  fs.cpSync(outDir, path.join(stage, "extension"), { recursive: true });
  for (const file of ["host.js", "extension-id.mjs", "install.ps1", "uninstall.ps1", "install.sh", "uninstall.sh"]) {
    fs.copyFileSync(path.join(root, "host", file), path.join(stage, "host", file));
  }
  for (const file of ["README.md", "README.pt-BR.md"]) {
    fs.copyFileSync(path.join(root, file), path.join(stage, file));
  }
  // O host é ESM; sem package.json ao lado o Node o trataria como CommonJS.
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2));
  fs.rmSync(zip, { force: true });
  // No Windows, usa o tar do sistema (o do Git Bash não gera .zip e confunde "C:" com host remoto).
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-a", "-c", "-f", zip, "-C", stage, "."]);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`Release: ${path.relative(root, zip)}`);
}
