// ---- itens repetidos da conta: ler as linhas de uma página e achar as iguais ----
// Mora fora do editor porque não depende de React nem do tesseract: recebe palavras com posição
// (da camada de texto do PDF ou do OCR) e devolve linhas de tabela já interpretadas. Assim dá
// para conferir a leitura com `node` direto num PDF, sem subir a tela.
//
// Todas as coordenadas são pontos do documento no espaço da tela (página já girada) — o mesmo
// espaço das anotações.

// número do jeito que a conta imprime: "1,00", "216,6800", "1.244,32"
const RE_NUM = /^\d{1,3}(?:\.\d{3})*,\d{2,4}$/;
// código do item: só dígitos e separadores ("7820799.1", "4.03.08.39-1")
const RE_COD = /^\d[\d.\-]*$/;
// data/hora da linha ("24/08", "06:11"): marca onde a descrição acaba
const RE_DATA = /^\d{2}[/:]\d{2}/;
const numBR = (s) => parseFloat(s.replace(/\./g, "").replace(",", "."));
// o OCR lê as bordas da tabela ("|") como barra, colchete, I ou l grudados no texto
const semBorda = (s) => String(s || "").replace(/^[|[\]!]+|[|[\]!]+$/g, "");

// palavras soltas → linhas: junta o que está na mesma altura (tolerância = meia linha)
export const agruparLinhas = (palavras) => {
  const ps = palavras.filter((p) => p.text).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const linhas = [];
  for (const p of ps) {
    const cy = (p.y0 + p.y1) / 2, alt = p.y1 - p.y0;
    const l = linhas[linhas.length - 1];
    if (l && Math.abs(cy - l.cy) <= Math.max(alt, l.y1 - l.y0) * 0.5) {
      l.tokens.push(p);
      l.y0 = Math.min(l.y0, p.y0); l.y1 = Math.max(l.y1, p.y1);
      l.cy = (l.y0 + l.y1) / 2;
    } else linhas.push({ y0: p.y0, y1: p.y1, cy, tokens: [p] });
  }
  for (const l of linhas) l.tokens.sort((a, b) => a.x0 - b.x0);
  return linhas.map(interpretarLinha);
};

// uma linha de tabela: código no começo, Qtde | Vl unitário | Vl total no fim
export const interpretarLinha = (l) => {
  // borda grudada no meio ("|MUCAMBO|24/08|06:11|PAR") separa palavras, como um espaço
  const tk = [];
  for (const t of l.tokens) {
    const re = /[^|]+/g, s = t.text;
    let m;
    while ((m = re.exec(s))) {
      const limpo = semBorda(m[0].trim());
      if (!limpo) continue;
      const w = t.x1 - t.x0;
      tk.push({ ...t, limpo,
        x0: t.x0 + w * (m.index / s.length), x1: t.x0 + w * ((m.index + m[0].length) / s.length) });
    }
  }
  const iCod = tk.findIndex((t) => RE_COD.test(t.limpo) && t.limpo.replace(/\D/g, "").length >= 5);
  const nums = tk.filter((t) => RE_NUM.test(t.limpo));
  let qtd = null, unit = null, total = null;
  if (nums.length >= 3) [qtd, unit, total] = nums.slice(-3);
  else if (nums.length === 2) {
    // tabela de procedimentos: "Qt" inteiro ("| 1 |") antes de Valor | Total, que têm vírgula
    [unit, total] = nums;
    const iUnit = tk.indexOf(unit);
    for (let i = iUnit - 1; i > iCod; i--)
      if (/^\d{1,4}$/.test(tk[i].limpo)) { qtd = tk[i]; break; }
  }
  const vTotal = total ? numBR(total.limpo) : null;
  const vUnit = unit ? numBR(unit.limpo) : null;
  const vQtd = qtd ? numBR(qtd.limpo) : vUnit > 0 && vTotal != null ? Math.round(vTotal / vUnit) : null;
  // descrição: logo depois do código; sem código, desde o começo da linha, pulando a data/hora
  // que algumas faturas põem antes do item ("10/04/2026 SOL RINGER ...")
  let i = iCod + 1;
  if (iCod < 0) while (i < tk.length && RE_DATA.test(tk[i].limpo)) i++;
  const resto = [];
  for (const t of tk.slice(i)) {
    if (RE_DATA.test(t.limpo) || t.limpo.includes("%") || t === qtd || t === unit) break;
    resto.push(t.limpo);
  }
  const descricao = resto.join(" ");
  return {
    y0: l.y0, y1: l.y1, cy: l.cy,
    codigo: iCod >= 0 ? tk[iCod].limpo.replace(/\D/g, "") : "",
    codigoLido: iCod >= 0 ? tk[iCod].limpo : "",
    descricao, chave: chaveDescricao(descricao),
    qtd: vQtd, unit: vUnit, total: vTotal,
    xQtd: qtd ? qtd.x0 : null,
  };
};

// Descrição comparável: maiúsculas, sem acento, só letras e dígitos. Tirar espaço e pontuação
// absorve o que o OCR mais varia ("S/AG.LUER" × "S/AG. LUER"). Menos de 4 letras não identifica
// item nenhum (é "AMP", "UN", sobra de coluna) — aí não há chave.
const chaveDescricao = (d) => {
  const k = String(d || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (k.match(/[A-Z]/g) || []).length >= 4 ? k : "";
};

// item de tabela que dá para comparar: valor unitário e algo que o identifique — o código ou,
// nas faturas que não imprimem código, a descrição
export const ehItem = (l) => !!(l && l.unit > 0 && (l.codigo || l.chave));
// "exatamente igual" = mesmo valor unitário e mesmo código (só os dígitos); quando um dos dois
// não tem código, a descrição decide
export const mesmoItem = (a, b) => {
  if (!ehItem(a) || !ehItem(b) || Math.abs(a.unit - b.unit) >= 0.005) return false;
  if (a.codigo && b.codigo) return a.codigo === b.codigo;
  return !!a.chave && a.chave === b.chave;
};

// a linha de uma página mais perto de uma altura — onde o auditor glosou
export const linhaEm = (linhas, cy) => {
  let melhor = null, dist = Infinity;
  for (const l of linhas) {
    const d = Math.abs(l.cy - cy);
    if (d < dist) { dist = d; melhor = l; }
  }
  // longe demais da glosa é outra linha da tabela, não a glosada
  return melhor && dist <= Math.max(8, (melhor.y1 - melhor.y0) * 1.2) ? melhor : null;
};

// Camada de texto do pdf.js → palavras. Cada item do getTextContent é um trecho de linha
// ("|7820799.1 |LUVA CIRURGICA ..."); as palavras dentro dele ganham x proporcional à posição
// do caractere — as contas saem em fonte monoespaçada, então a proporção é exata o bastante.
// `viewport` é o de escala 1 com a mesma rotação da tela: converte do espaço do PDF para o nosso.
export const palavrasDoTexto = (items, viewport) => {
  const out = [];
  for (const it of items) {
    const s = it.str || "";
    if (!s.trim() || !it.width) continue;
    const [a, b, c, d, e, f] = it.transform;
    const tam = Math.hypot(c, d) || it.height || 10;
    const dirN = Math.hypot(a, b) || 1;
    const [x0, y0] = viewport.convertToViewportPoint(e, f);
    const [x1, y1] = viewport.convertToViewportPoint(e + (a / dirN) * it.width, f + (b / dirN) * it.width);
    if (Math.abs(y1 - y0) > tam * 0.5) continue; // texto em pé na tela: não é linha de tabela
    const base = (y0 + y1) / 2;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(s))) {
      const ta = x0 + (x1 - x0) * (m.index / s.length);
      const tb = x0 + (x1 - x0) * ((m.index + m[0].length) / s.length);
      out.push({
        text: m[0],
        x0: Math.min(ta, tb), x1: Math.max(ta, tb),
        y0: base - tam * 0.8, y1: base + tam * 0.2,
      });
    }
  }
  return out;
};
