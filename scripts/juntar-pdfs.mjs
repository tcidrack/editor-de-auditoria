// Junta partes de um mesmo processo num PDF só, preservando a glosa já auditada.
//
// O mesmo que o botão "Juntar" da fila faz dentro do app — a lógica mora em src/juntar.js e é
// compartilhada pelos dois. Este script serve para o arquivo que já está em mãos, sem precisar
// abrir o editor: útil quando quem junta não é quem audita.
//
// Nada é redesenhado nem recomprimido: as riscadas da parte auditada estão no content stream e
// viajam junto, e o /Rotate de cada página vem no dicionário copiado.
//
// Uso:
//   node scripts/juntar-pdfs.mjs "<parte1>.pdf" "<parte2>.pdf" [...] [-o "<saída>.pdf"]
//
// Sem -o, grava "<parte1> (juntado).pdf" ao lado. Os arquivos de entrada não são tocados.
//
// O -o vale a pena quando o nome da parte auditada está sujo (o " (1)" que o Chrome cola
// quando o arquivo já existe, ou o " - AUDITADO" duplicado das versões antigas): o editor
// só sabe descascar a máscara dele, e o resto fica pendurado no nome para sempre.

import fs from "node:fs";
import path from "node:path";
import { juntarPdfs, somaHerdada } from "../src/juntar.js";

const brl = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function main() {
  const args = process.argv.slice(2);
  const entradas = [];
  let saida = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o") { saida = args[++i]; continue; }
    entradas.push(args[i]);
  }

  if (entradas.length < 2) {
    console.error('uso: node scripts/juntar-pdfs.mjs "<parte1>.pdf" "<parte2>.pdf" [...] [-o "<saída>.pdf"]');
    console.error("     as partes entram na ordem dada — a primeira é o começo do processo");
    process.exit(2);
  }
  for (const f of entradas) {
    if (!fs.existsSync(f)) { console.error("não encontrei: " + f); process.exit(2); }
  }

  if (!saida) {
    const dir = path.dirname(entradas[0]);
    const base = path.basename(entradas[0]).replace(/\.pdf$/i, "");
    saida = path.join(dir, `${base} (juntado).pdf`);
  }
  // sobrescrever aqui apagaria trabalho de auditoria sem volta
  if (fs.existsSync(saida)) {
    console.error("já existe um arquivo em: " + saida);
    console.error("escolha outro nome com -o (nada foi alterado).");
    process.exit(2);
  }

  const partes = entradas.map((f) => ({ bytes: fs.readFileSync(f) }));
  const juntado = await juntarPdfs(partes);
  fs.writeFileSync(saida, juntado.bytes);

  // relatório: é o que permite conferir a emenda sem abrir o arquivo
  console.log(`${entradas.length} partes → ${juntado.paginas} páginas`);
  juntado.detalhes.forEach((d, i) => {
    const glosa = d.itens ? `${d.itens} itens de glosa, ${brl(d.soma)}` : "sem glosa";
    console.log(`  pág. ${d.offset + 1}: ${path.basename(entradas[i])} (${d.paginas} páginas, ${glosa})`);
  });
  const h = juntado.herdado;
  if (h && (h.tec.length || h.adm.length)) {
    console.log(`glosa herdada: ${h.tec.length + h.adm.length} itens, ${brl(somaHerdada(h))}`);
    console.log(`auditores: ${h.auditores.map((a) => a.nome).join(", ")}`);
  } else {
    console.log("nenhuma parte trazia glosa — o juntado sai limpo.");
  }
  console.log("gravado em: " + saida);
  console.log("confira de olho a emenda entre as partes antes de auditar.");
}

main().catch((e) => { console.error(e); process.exit(1); });
