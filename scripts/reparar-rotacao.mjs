// Repara PDFs auditados antes da correção do /Rotate na exportação.
//
// O bug: o editor marca em cima do que o pdf.js desenha, e o pdf.js APLICA o /Rotate da
// página — numa página deitada a tela é 842×595. O buildPdf gravava essas coordenadas no
// espaço da página sem rotação (595×842), então a marcação saía transposta e o que
// passava da largura do papel caía fora da folha.
//
// A marcação está íntegra dentro do PDF, só no lugar errado. Este script envolve o
// trecho de conteúdo que a exportação acrescentou numa matriz corretiva, que leva cada
// ponto ao lugar em que o auditor marcou. Nada é redesenhado nem recomprimido: streams
// de conteúdo concatenam, então basta inserir um "q <matriz> cm" antes e um "Q" depois.
//
// O que ele NÃO conserta: o tamanho da fonte. Se a marcação saiu gigante, ela continua
// gigante — o script mexe em posição e orientação, não em tamanho.
//
// Uso:
//   node scripts/reparar-rotacao.mjs "<original>.pdf" "<... - AUDITADO>.pdf"
//
// Grava "<... - AUDITADO> (corrigido).pdf" ao lado. O arquivo do auditor não é tocado.

import fs from "node:fs";
import path from "node:path";
import { PDFDocument, PDFArray } from "pdf-lib";

// Matriz que leva o ponto GRAVADO ao ponto CORRETO, por rotação da página.
// Gravado:  x = sx,  y = H - sy   (sx,sy = coordenadas de tela, H = altura do MediaBox)
// Correto:  depende de como o leitor gira a página na hora de exibir.
const matriz = (rot, W, H) => ({
  90: [0, 1, -1, 0, H, 0],
  180: [-1, 0, 0, -1, W, H],
  270: [0, -1, 1, 0, W - H, H],
}[rot]);

const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(4));

// Contents pode ser um stream só ou um array deles; devolve sempre o array (ou null).
const arrayDeConteudo = (pagina) => {
  const c = pagina.node.Contents();
  if (!c) return null;
  return c instanceof PDFArray ? c : null;
};

const conta = (pagina) => {
  const c = pagina.node.Contents();
  if (!c) return 0;
  return c instanceof PDFArray ? c.size() : 1;
};

async function main() {
  const [origem, auditado] = process.argv.slice(2);
  if (!origem || !auditado) {
    console.error('uso: node scripts/reparar-rotacao.mjs "<original>.pdf" "<... - AUDITADO>.pdf"');
    process.exit(2);
  }
  for (const f of [origem, auditado]) {
    if (!fs.existsSync(f)) { console.error("não encontrei: " + f); process.exit(2); }
  }

  const opts = { ignoreEncryption: true, updateMetadata: false };
  const orig = await PDFDocument.load(fs.readFileSync(origem), opts);
  const doc = await PDFDocument.load(fs.readFileSync(auditado), opts);

  const pOrig = orig.getPages(), pDoc = doc.getPages();
  if (pOrig.length !== pDoc.length) {
    console.error(`os dois PDFs têm páginas diferentes (${pOrig.length} × ${pDoc.length}) — ` +
      "passe o original de onde este auditado saiu.");
    process.exit(2);
  }

  const corrigidas = [], puladas = [];
  for (let i = 0; i < pDoc.length; i++) {
    const pg = pDoc[i];

    // sem conteúdo acrescentado pela exportação: nada a fazer nesta página
    const extra = conta(pg) - conta(pOrig[i]);
    if (extra <= 0) continue;

    let rot = ((pg.getRotation().angle % 360) + 360) % 360;
    if (rot % 90) rot = 0;
    if (rot === 0) continue;              // página em pé sempre saiu certa

    const arr = arrayDeConteudo(pg);
    if (!arr) { puladas.push(i + 1); continue; }

    const W = pg.getWidth(), H = pg.getHeight();
    const M = matriz(rot, W, H);
    if (!M) { puladas.push(i + 1); continue; }

    // o stream da marcação é o último do array (a exportação sempre acrescenta no fim)
    const abre = doc.context.register(
      doc.context.stream(`q\n${M.map(num).join(" ")} cm\n`));
    const fecha = doc.context.register(doc.context.stream("\nQ\n"));

    arr.insert(arr.size() - 1, abre);     // entra logo antes do stream da marcação
    arr.push(fecha);
    corrigidas.push(i + 1);
  }

  if (!corrigidas.length) {
    console.log("nenhuma página precisou de conserto — este arquivo já está certo.");
    return;
  }

  // rastro de que o arquivo passou por aqui. Autor e Keywords (onde ficam as glosas)
  // seguem intactos — o load usa updateMetadata: false justamente para não mexer neles.
  doc.setProducer("Editor de Auditoria — Maida (rotação reparada)");

  const dir = path.dirname(auditado);
  const base = path.basename(auditado).replace(/\.pdf$/i, "");
  const saida = path.join(dir, `${base} (corrigido).pdf`);
  fs.writeFileSync(saida, await doc.save());

  console.log(`páginas corrigidas (${corrigidas.length}): ${corrigidas.join(", ")}`);
  if (puladas.length) console.log(`páginas que não deu para tratar: ${puladas.join(", ")}`);
  console.log("gravado em: " + saida);
}

main().catch((e) => { console.error(e); process.exit(1); });
