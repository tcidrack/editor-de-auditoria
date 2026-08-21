// ---- juntar partes de um processo num PDF só ----
//
// O SEI entrega processo grande partido em vários downloads. Quando o auditor risca uma parte
// e o resto vem em outro arquivo, abrir o resto sozinho faz a calculadora começar do zero: a
// glosa da parte auditada mora nas Keywords do PDF exportado (PREFIXO_GLOSAS), e o outro
// arquivo não tem nada disso. Somar os dois totais na mão é exatamente o erro que a
// calculadora existe para evitar.
//
// Este módulo é a única cópia dessa lógica: roda no navegador (o botão "Juntar" da fila) e no
// node (scripts/juntar-pdfs.mjs). Por isso nada de React e nada de fs aqui dentro — só
// pdf-lib, que os dois lados já têm.
//
// O miolo é o DESLOCAMENTO: tudo que é chaveado por número de página anda o tamanho das
// partes que vieram antes. No arquivo exportado isso é só a glosa; dentro do editor são
// também as marcações vivas e os giros, que o chamador desloca com deslocarPaginas.
import { PDFDocument } from "pdf-lib";

// campo padrão do PDF, que o pdf.js devolve de volta em info.Keywords
export const PREFIXO_GLOSAS = "maida-glosas:";

// devolve { herdado, keywordsOriginais } a partir do que o leitor achou nos metadados.
// keywordsOriginais é a string crua anterior à nossa entrada: preserva keywords de terceiros
// (não dá para separá-las com segurança — o separador é espaço, que também aparece dentro delas).
export const lerGlosasDoPdf = (keywords) => {
  const bruto = String(keywords || "");
  const i = bruto.indexOf(PREFIXO_GLOSAS);
  if (i < 0) return { herdado: null, keywordsOriginais: bruto.trim() };
  let herdado = null;
  try { herdado = JSON.parse(bruto.slice(i + PREFIXO_GLOSAS.length)); }
  catch { /* PDF mexido por fora — segue sem herança */ }
  return { herdado, keywordsOriginais: bruto.slice(0, i).trim() };
};

// acumula auditores de várias partes na mesma lista, com a regra do listaAuditores: a mesma
// pessoa duas vezes seguidas não empilha, atualiza a data dela.
export const juntarAuditores = (acc, novos) => {
  for (const a of novos || []) {
    if (!a) continue;
    const ultimo = acc[acc.length - 1];
    if (ultimo && ultimo.email === (a.email || "")) acc[acc.length - 1] = a;
    else acc.push(a);
  }
  return acc;
};

// { página: valor } → { página + offset: valor }. Serve para doc.annotations e doc.rotacoes.
// O +pg é obrigatório: depois de restaurar um rascunho as chaves voltam como string, e
// "3" + 115 daria "3115".
export const deslocarPaginas = (mapa, offset) => {
  const out = {};
  for (const [pg, valor] of Object.entries(mapa || {})) out[+pg + offset] = valor;
  return out;
};

// soma da glosa de um payload herdado — o que a calculadora vai mostrar como "· do PDF"
export const somaHerdada = (herdado) => {
  const itens = [...((herdado && herdado.tec) || []), ...((herdado && herdado.adm) || [])];
  return Math.round(itens.reduce((s, i) => s + (i.v || 0), 0) * 100) / 100;
};

// Junta as partes na ordem dada.
//
// `partes` é [{ bytes, herdado, keywordsOriginais }]. herdado e keywordsOriginais são
// opcionais: quando não vierem, saem das próprias Keywords do PDF. O editor passa os seus,
// que estão em memória e podem ter glosa que o auditor apagou — reler o arquivo a
// ressuscitaria.
//
// Devolve { bytes, offsets, herdado, keywordsOriginais, paginas, detalhes }, onde offsets[i] é
// quantas páginas vieram antes da parte i: é com ele que o chamador desloca o que for dele.
// `detalhes` traz o mesmo por parte, já com a contagem de glosa — é o relatório da linha de
// comando e evita reler os arquivos só para montá-lo.
export const juntarPdfs = async (partes) => {
  if (!Array.isArray(partes) || partes.length < 2)
    throw new Error("são necessárias pelo menos duas partes.");

  const opts = { ignoreEncryption: true, updateMetadata: false };
  const out = await PDFDocument.create();
  const payload = { v: 1, totalConta: null, tec: [], adm: [], auditores: [] };
  const keywords = [];
  const offsets = [];
  const detalhes = [];

  for (const parte of partes) {
    const doc = await PDFDocument.load(parte.bytes, opts);
    const offset = out.getPageCount(); // páginas já acumuladas = deslocamento desta parte
    offsets.push(offset);

    const copias = await out.copyPages(doc, doc.getPageIndices());
    for (const p of copias) out.addPage(p);

    // o que o chamador informou manda; sem informação, vale o que está no arquivo
    const doArquivo = lerGlosasDoPdf(doc.getKeywords());
    const herdado = parte.herdado !== undefined ? parte.herdado : doArquivo.herdado;
    const kw = parte.keywordsOriginais !== undefined ? parte.keywordsOriginais : doArquivo.keywordsOriginais;
    if (kw) keywords.push(kw);

    const itens = herdado ? ((herdado.tec || []).length + (herdado.adm || []).length) : 0;
    detalhes.push({ offset, paginas: doc.getPageCount(), itens, soma: somaHerdada(herdado) });
    if (!herdado) continue;

    for (const t of herdado.tec || []) payload.tec.push({ ...t, p: t.p + offset });
    for (const a of herdado.adm || []) payload.adm.push({ ...a, p: a.p + offset });
    juntarAuditores(payload.auditores, herdado.auditores);
    if (payload.totalConta == null && herdado.totalConta != null) payload.totalConta = herdado.totalConta;
  }

  const temGlosa = payload.tec.length || payload.adm.length || payload.auditores.length
    || payload.totalConta != null;
  const keywordsOriginais = keywords.join(" ").trim();

  const nomes = [...new Set(payload.auditores.map((a) => a.nome).filter(Boolean))];
  if (nomes.length) out.setAuthor(nomes.join("; "));
  // rastro de que o arquivo passou por aqui, no mesmo espírito do reparar-rotacao.mjs
  out.setProducer("Editor de Auditoria — Maida (juntado)");
  // o payload vai por último: o leitor corta a partir do prefixo até o fim da string
  if (temGlosa) out.setKeywords([keywordsOriginais, PREFIXO_GLOSAS + JSON.stringify(payload)].filter(Boolean));
  else if (keywordsOriginais) out.setKeywords([keywordsOriginais]);

  return {
    bytes: await out.save(),
    offsets,
    detalhes,
    paginas: out.getPageCount(),
    herdado: temGlosa ? payload : null,
    keywordsOriginais,
  };
};
