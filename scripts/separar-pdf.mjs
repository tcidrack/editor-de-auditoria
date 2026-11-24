// Separa um PDF em dois a partir de uma página, preservando a glosa já auditada.
//
// O inverso do juntar-pdfs.mjs: processo que veio com duas contas. O mesmo que o botão
// "Separar" do rodapé faz dentro do app — a lógica mora em src/juntar.js (separarPdf) e é
// compartilhada pelos dois. A glosa herdada é dividida pela página, e a da 2ª parte volta a
// contar do 1. Nada é redesenhado: as riscadas estão no content stream e vão junto.
//
// Uso:
//   node scripts/separar-pdf.mjs "<arquivo>.pdf" 176
//
// Grava "<nome> (pág. 1-175) - AUDITADO (…).pdf" e "<nome> (pág. 176-N) …" ao lado — o sufixo
// entra antes da máscara do editor, para ele continuar reconhecendo-a. O original não é tocado;
// para "excluir o final", é só apagar a segunda parte.

import fs from "node:fs";
import path from "node:path";
import { separarPdf, somaHerdada } from "../src/juntar.js";

const brl = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
// mesma máscara do editor (MASCARA em src/EditorAuditoria.jsx)
const MASCARA = /\s*-\s*AUDITADO((?:\s*\([^()]*\))*)\s*$/i;

async function main() {
  const [entrada, corteStr] = process.argv.slice(2);
  const corte = parseInt(corteStr, 10);
  if (!entrada || !corte) {
    console.error('uso: node scripts/separar-pdf.mjs "<arquivo>.pdf" <página onde começa a 2ª parte>');
    process.exit(2);
  }
  if (!fs.existsSync(entrada)) { console.error("não encontrei: " + entrada); process.exit(2); }

  const dir = path.dirname(entrada);
  const base = path.basename(entrada).replace(/\.pdf$/i, "");
  const m = MASCARA.exec(base);
  const nome = (ini, fim) => {
    const suf = ` (pág. ${ini}-${fim})`;
    return path.join(dir, (m ? base.slice(0, m.index) + suf + base.slice(m.index) : base + suf) + ".pdf");
  };

  const partes = await separarPdf({ bytes: fs.readFileSync(entrada) }, corte);
  const saidas = partes.map((p) => nome(p.offset + 1, p.offset + p.paginas));
  // sobrescrever aqui apagaria trabalho de auditoria sem volta
  for (const s of saidas) if (fs.existsSync(s)) {
    console.error("já existe um arquivo em: " + s + " (nada foi alterado).");
    process.exit(2);
  }
  partes.forEach((p, i) => {
    fs.writeFileSync(saidas[i], p.bytes);
    const h = p.herdado, itens = h ? h.tec.length + h.adm.length : 0;
    const glosa = itens ? `${itens} itens de glosa, ${brl(somaHerdada(h))}` : "sem glosa";
    console.log(`pág. ${p.offset + 1}-${p.offset + p.paginas} (${p.paginas} páginas, ${glosa})`);
    console.log("  gravado em: " + saidas[i]);
  });
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
