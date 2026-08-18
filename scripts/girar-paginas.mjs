// Gira páginas específicas de um PDF, sem redesenhar nada.
//
// Digitalização deitada dentro de folha em pé: o conteúdo está certo, o enquadramento é
// que está errado. O conserto é o /Rotate da página — "graus no sentido horário ao
// exibir", na spec do PDF. Nenhum stream de conteúdo é tocado, nada é recomprimido:
// o arquivo sai do mesmo tamanho, só com as páginas escolhidas em pé.
//
// O giro é RELATIVO ao que a página já tem, para o script servir também em arquivos
// que já vieram com /Rotate.
//
// Uso:
//   node scripts/girar-paginas.mjs "<arquivo>.pdf" 4-19 90
//   node scripts/girar-paginas.mjs "<arquivo>.pdf" 4-19,30,44-46 -90
//
// Grava "<arquivo> (rotacionado).pdf" ao lado. O arquivo de entrada não é tocado.

import fs from "node:fs";
import path from "node:path";
import { PDFDocument, degrees } from "pdf-lib";

// "4-19,30" → [4,5,…,19,30] (1-based, sem repetição, em ordem)
const lerPaginas = (spec, total) => {
  const s = new Set();
  for (const parte of String(spec).split(",")) {
    const t = parte.trim();
    if (!t) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(t);
    if (!m) return null;
    const ini = parseInt(m[1], 10);
    const fim = m[2] ? parseInt(m[2], 10) : ini;
    if (ini < 1 || fim < ini || fim > total) return null;
    for (let i = ini; i <= fim; i++) s.add(i);
  }
  return s.size ? [...s].sort((a, b) => a - b) : null;
};

async function main() {
  const [arquivo, spec, grausTxt] = process.argv.slice(2);
  if (!arquivo || !spec || !grausTxt) {
    console.error('uso: node scripts/girar-paginas.mjs "<arquivo>.pdf" <páginas> <graus>');
    console.error('     páginas: 4-19  ou  4-19,30,44-46      graus: múltiplo de 90 (aceita negativo)');
    process.exit(2);
  }
  if (!fs.existsSync(arquivo)) { console.error("não encontrei: " + arquivo); process.exit(2); }

  const graus = parseInt(grausTxt, 10);
  if (Number.isNaN(graus) || graus % 90) {
    console.error("graus precisa ser múltiplo de 90 (90, 180, 270, -90…)");
    process.exit(2);
  }

  // updateMetadata: false — Autor e Keywords (onde o editor grava as glosas) ficam intactos
  const doc = await PDFDocument.load(fs.readFileSync(arquivo),
    { ignoreEncryption: true, updateMetadata: false });
  const pgs = doc.getPages();

  const alvo = lerPaginas(spec, pgs.length);
  if (!alvo) {
    console.error(`intervalo inválido: "${spec}" (o arquivo tem ${pgs.length} páginas)`);
    process.exit(2);
  }

  for (const n of alvo) {
    const pg = pgs[n - 1];
    const atual = pg.getRotation().angle;
    pg.setRotation(degrees((((atual + graus) % 360) + 360) % 360));
  }

  const dir = path.dirname(arquivo);
  const base = path.basename(arquivo).replace(/\.pdf$/i, "");
  const saida = path.join(dir, `${base} (rotacionado).pdf`);
  fs.writeFileSync(saida, await doc.save());

  console.log(`páginas giradas em ${graus}° (${alvo.length}): ${alvo.join(", ")}`);
  console.log("gravado em: " + saida);
}

main().catch((e) => { console.error(e); process.exit(1); });
