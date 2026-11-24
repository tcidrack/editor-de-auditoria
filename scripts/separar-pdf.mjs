// Tira um trecho de um PDF (da página X até Y), preservando a glosa já auditada.
//
// O inverso do juntar-pdfs.mjs: processo que veio com duas contas. O mesmo que o botão
// "Separar" do rodapé faz dentro do app — a lógica mora em src/juntar.js (separarPdf) e é
// compartilhada pelos dois. Saem duas partes: o restante (páginas fora do trecho, emendadas) e
// o trecho. A glosa herdada segue a sua página, renumerada. Nada é redesenhado: as riscadas
// estão no content stream e vão junto.
//
// Uso:
//   node scripts/separar-pdf.mjs "<arquivo>.pdf" 80-120   (a outra conta no meio)
//   node scripts/separar-pdf.mjs "<arquivo>.pdf" 176      (da 176 até o fim)
//
// Grava "<nome> (sem pág. X-Y) - AUDITADO (…).pdf" e "<nome> (pág. X-Y) …" ao lado — o sufixo
// entra antes da máscara do editor, para ele continuar reconhecendo-a. O original não é tocado;
// para descartar uma parte, é só apagá-la.

import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { separarPdf, somaHerdada } from "../src/juntar.js";

const brl = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
// mesma máscara do editor (MASCARA em src/EditorAuditoria.jsx)
const MASCARA = /\s*-\s*AUDITADO((?:\s*\([^()]*\))*)\s*$/i;

async function main() {
  const [entrada, trecho] = process.argv.slice(2);
  const mt = /^(\d+)(?:-(\d+))?$/.exec(String(trecho || "").trim());
  if (!entrada || !mt) {
    console.error('uso: node scripts/separar-pdf.mjs "<arquivo>.pdf" <de>-<até>   (ou só <de>, até o fim)');
    process.exit(2);
  }
  if (!fs.existsSync(entrada)) { console.error("não encontrei: " + entrada); process.exit(2); }

  const dir = path.dirname(entrada);
  const base = path.basename(entrada).replace(/\.pdf$/i, "");
  const m = MASCARA.exec(base);
  const comSufixo = (suf) => path.join(dir, (m ? base.slice(0, m.index) + suf + base.slice(m.index) : base + suf) + ".pdf");

  const bytes = fs.readFileSync(entrada);
  const de = parseInt(mt[1], 10);
  // sem o "até", vai até a última página — o separarPdf confere o intervalo
  const ate = mt[2] ? parseInt(mt[2], 10) : (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  const partes = await separarPdf({ bytes }, de, ate);
  const saidas = [comSufixo(` (sem pág. ${de}-${ate})`), comSufixo(` (pág. ${de}-${ate})`)];
  // sobrescrever aqui apagaria trabalho de auditoria sem volta
  for (const s of saidas) if (fs.existsSync(s)) {
    console.error("já existe um arquivo em: " + s + " (nada foi alterado).");
    process.exit(2);
  }
  partes.forEach((p, i) => {
    fs.writeFileSync(saidas[i], p.bytes);
    const h = p.herdado, itens = h ? h.tec.length + h.adm.length : 0;
    const glosa = itens ? `${itens} itens de glosa, ${brl(somaHerdada(h))}` : "sem glosa";
    console.log(`${i ? "trecho  " : "restante"}: ${p.paginas} páginas, ${glosa}`);
    console.log("  gravado em: " + saidas[i]);
  });
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
