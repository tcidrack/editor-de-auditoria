// Copia os arquivos do OCR (tesseract.js) de node_modules para public/ocr/, para o site servir
// tudo sozinho em vez de baixar do cdn.jsdelivr.net na primeira leitura. Numa rede que bloqueia
// ou derruba o CDN, o OCR não carregava e a glosa técnica caía em "preencha à mão".
// Roda no predev/prebuild (package.json); public/ocr/ é gerado e fica fora do git.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const destino = join(raiz, "public", "ocr");
mkdirSync(destino, { recursive: true });

const pasta = (pkg) => dirname(require.resolve(`${pkg}/package.json`));
const tess = pasta("tesseract.js"), core = pasta("tesseract.js-core"), por = pasta("@tesseract.js-data/por");

const arquivos = [
  [join(tess, "dist", "worker.min.js"), "worker.min.js"],
  // createWorker("por") usa o motor LSTM: a lib só pede as variantes "-lstm", e escolhe entre
  // elas pelo que o navegador suporta (relaxed SIMD, SIMD ou nenhum)
  [join(core, "tesseract-core-relaxedsimd-lstm.wasm.js"), "tesseract-core-relaxedsimd-lstm.wasm.js"],
  [join(core, "tesseract-core-simd-lstm.wasm.js"), "tesseract-core-simd-lstm.wasm.js"],
  [join(core, "tesseract-core-lstm.wasm.js"), "tesseract-core-lstm.wasm.js"],
  // mesmo dicionário que a lib baixava do CDN no modo LSTM (4.0.0_best_int)
  [join(por, "4.0.0_best_int", "por.traineddata.gz"), "por.traineddata.gz"],
];
for (const [de, nome] of arquivos) copyFileSync(de, join(destino, nome));
console.log(`OCR: ${arquivos.length} arquivos em public/ocr/`);
