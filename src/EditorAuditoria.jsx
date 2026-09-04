import { useState, useRef, useEffect, useReducer, useMemo } from "react";
import { flushSync } from "react-dom";
import {
  FilePlus, Folder, Undo2, Trash2, Save, Download,
  ChevronLeft, ChevronRight, Minus, Plus, Pencil, Type, Highlighter,
  Moon, Sun, Stamp, Copy, X, Redo2, Move, Check, Eraser, ScanText, Calculator,
  Keyboard, LogOut, KeyRound, Settings, Square, RotateCcw, RotateCw,
  ChevronUp, ChevronDown, Combine, GripVertical, Rows3,
} from "lucide-react";
import "./EditorAuditoria.css";

// bibliotecas auto-hospedadas (empacotadas no bundle — sem CDN de terceiros)
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
import { PDFDocument, rgb, StandardFonts, LineCapStyle, degrees,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix } from "pdf-lib";
import JSZip from "jszip";
import * as rascunho from "./rascunho";
import { PREFIXO_GLOSAS, lerGlosasDoPdf, juntarPdfs, deslocarPaginas, somaHerdada } from "./juntar";
import { useArrastarLista } from "./arrastar";
import { PAPEIS, usaCarimbo, usaGlosaColuna, lerCarimbo, salvarCarimbo, apagarCarimbo,
  trocarSenha } from "./conta";
import CampoSenha from "./CampoSenha";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const LOGO_MAIDA =
  "https://maida.health/wp-content/themes/melhortema/assets/images/logo-light.svg";

// hex → rgba com transparência (para o canvas)
const hexA = (h, al) => {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${al})`;
};

// ---- glosas ----
// só duas cores, e elas carregam o significado: a calculadora classifica por elas.
const COR_ADM = "#2148c0"; // azul  — glosa administrativa
const COR_TEC = "#d92d20"; // vermelho — glosa técnica
const CORES = [
  { id: "adm", hex: COR_ADM, label: "Administrativa", title: "Glosa administrativa (azul) — tecla A" },
  { id: "tec", hex: COR_TEC, label: "Técnica", title: "Glosa técnica (vermelha) — tecla T" },
];
// glosa em coluna, em pontos: a janela de leitura é a fatia de tabela AO LADO da coluna (é lá
// que estão as linhas a contar — onde os "G" nascem o papel está vazio), e a faixa do preview é
// só a largura que os "G" vão ocupar.
const LARG_LEITURA_G = 220;
const LARG_PREVIEW_G = 70;

const classeGlosa = (hex) => {
  const h = String(hex || "").toLowerCase();
  return h === COR_ADM ? "adm" : h === COR_TEC ? "tec" : null;
};

// ---- ferramentas e atalhos ----
// a ordem desta lista É a numeração das teclas (toolbar e teclado leem daqui)
const FERRAMENTAS = [
  { id: "pen", label: "Desenho", Icon: Pencil },
  { id: "line", label: "Linha", Icon: Minus },
  { id: "text", label: "Texto", Icon: Type },
  { id: "highlight", label: "Destaque", Icon: Highlighter },
  { id: "check", label: "Check", Icon: Check },
  { id: "eraser", label: "Borracha", Icon: Eraser },
  // corrigir anda junto: cobre uma marcação já achatada num PDF exportado, na cor do fundo
  // da própria página. O "Copiar código" fecha a fila por ser leitura, não marcação.
  { id: "cover", label: "Corretivo", Icon: Square },
  { id: "ocr", label: "Copiar código", Icon: ScanText },
  // glosa em coluna: repete "G <valor>" em todas as linhas de uma faixa de uma vez só.
  // Entra no fim da fila de propósito — a ordem desta lista é o atalho numérico, e mexer
  // no meio trocaria as teclas 1..8 que a equipe já tem no dedo.
  { id: "colglosa", label: "Glosa em coluna", Icon: Rows3, disponivel: usaGlosaColuna },
];
// As ferramentas que ESTE auditor vê — e, com isso, a numeração das teclas dele. `disponivel`
// mora na própria ferramenta para a regra ficar ao lado do que ela liga; sem ele, vale para
// todo mundo. A glosa em coluna ser a última é o que faz o técnico continuar com as teclas
// 1..8 exatamente onde sempre estiveram.
const ferramentasDe = (usuario) =>
  FERRAMENTAS.filter((f) => !f.disponivel || f.disponivel(usuario));
// tela de ajuda (tecla ?) — manter em sincronia com o handler de keydown.
// Recebe as ferramentas do auditor: a lista de teclas tem de bater com a toolbar dele.
const montarAtalhos = (ferramentas) => [
  {
    grupo: "Ferramentas",
    itens: [
      ...ferramentas.map((f, i) => ({ teclas: [String(i + 1)], descricao: f.label })),
      { teclas: ["0"], descricao: "Modo navegar (nenhuma ferramenta)" },
      { teclas: ["C"], descricao: "Painel de carimbos" },
      { teclas: ["Esc"], descricao: "Fecha balões, desmarca o item, volta a navegar" },
    ],
  },
  {
    grupo: "Glosa e marca",
    itens: [
      { teclas: ["A"], descricao: "Glosa administrativa (azul)" },
      { teclas: ["T"], descricao: "Glosa técnica (vermelha)" },
      { teclas: ["X"], descricao: "Alterna ✓ / ✗ (ativa o Check)" },
      { teclas: ["G"], descricao: "Abre/recolhe a calculadora de glosas" },
    ],
  },
  {
    grupo: "Edição",
    itens: [
      { teclas: ["Ctrl", "Z"], descricao: "Desfazer" },
      { teclas: ["Ctrl", "Y"], descricao: "Refazer" },
      { teclas: ["Delete"], descricao: "Apaga o item selecionado" },
      { teclas: ["↑", "↓", "←", "→"], descricao: "Move o item selecionado (10 pt com Shift)" },
    ],
  },
  {
    grupo: "Navegação e zoom",
    itens: [
      { teclas: ["←", "→"], descricao: "Página anterior / próxima (sem item selecionado)" },
      { teclas: ["PageUp", "PageDown"], descricao: "Página anterior / próxima" },
      { teclas: ["Home", "End"], descricao: "Primeira / última página" },
      { teclas: ["[", "]"], descricao: "Documento anterior / próximo da fila" },
      { teclas: ["+", "−"], descricao: "Aproxima / afasta o zoom" },
      { teclas: ["Ctrl", "0"], descricao: "Zoom em 100%" },
    ],
  },
  {
    grupo: "Arquivo",
    itens: [
      { teclas: ["Ctrl", "S"], descricao: "Salvar este documento" },
      { teclas: ["Ctrl", "Shift", "S"], descricao: "Baixar todos auditados (.zip)" },
      { teclas: ["?"], descricao: "Abre esta tela de atalhos" },
    ],
  },
];

// glosa administrativa: a equipe sempre escreve "G <valor>".
// exigir as 2 casas decimais é o que descarta código ("2401") e as próprias linhas
// do fechamento ("Glosa Técnica: R$ 298,81") — senão o resumo entraria na soma.
const RE_GLOSA = /^g\s*(?:r\$)?\s*((?:\d{1,3}(?:\.\d{3})+|\d+)),(\d{2})$/i;
const valorGlosa = (txt) => {
  const m = RE_GLOSA.exec(String(txt || "").trim());
  return m ? parseFloat(m[1].replace(/\./g, "") + "." + m[2]) : null;
};

// valor monetário isolado, do jeito que o OCR devolve ("298,81", "1.019,57")
const RE_MOEDA = /^\d{1,3}(?:\.\d{3})*,\d{2}$/;

// O código do procedimento vem impresso com os separadores da tabela ("4.03.08.39-1"), mas quem
// recebe o valor colado espera a sequência crua. Tirar aqui poupa a limpeza à mão em toda leitura.
const soDigitos = (txt) => String(txt || "").replace(/\D+/g, "");

// Só dígitos e os separadores que sobram no recorte: os pontos e o traço do próprio código, o
// espaço, e os "|" da moldura da tabela, que o OCR quase sempre traz junto. A vírgula fica de
// fora de propósito — assim um valor lido ("59,68") nunca é confundido com código.
const SO_CODIGO = /^[\d.\-\s|]*\d[\d.\-\s|]*$/;
// A ferramenta tem dois usos: copiar o código do procedimento e copiar a descrição do item, que
// a equipe cola na pesquisa. Limpar só o primeiro — e ele se reconhece por não ter palavra nenhuma.
const limparLeitura = (txt) => {
  const t = String(txt || "").trim();
  return SO_CODIGO.test(t) ? soDigitos(t) : t;
};

// "1.019,57" → 1019.57 (aceita também "1019.57" digitado com ponto)
const numeroBR = (txt) => {
  const s = String(txt ?? "").trim().replace(/[^\d.,-]/g, "");
  if (!s) return null;
  const n = s.includes(",")
    ? parseFloat(s.replace(/\./g, "").replace(",", "."))
    : parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
const moeda = (n) =>
  (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// varre um documento e devolve os itens e totais das duas glosas.
// administrativa = caixas de texto azuis "G <valor>";
// técnica = traços vermelhos com valor confirmado (qtd × unitário) + o que veio do PDF.
const calcGlosas = (doc) => {
  const adm = [], tec = [];
  if (doc) {
    for (const [pg, lista] of Object.entries(doc.annotations || {}))
      for (const a of lista) {
        const cls = classeGlosa(a.color);
        if (cls === "adm" && a.type === "text") {
          const v = valorGlosa(a.text);
          if (v != null) adm.push({ tipo: "adm", pagina: +pg, valor: v, ann: a });
        } else if (cls === "tec" && a.type === "pen" && a.glosa > 0) {
          tec.push({ tipo: "tec", pagina: +pg, valor: a.glosa, qtd: a.glosaQtd, unit: a.glosaUnit, ann: a });
        }
      }
    // itens gravados no PDF por uma etapa anterior da auditoria (ver PREFIXO_GLOSAS).
    // não há contagem dupla: as marcações do arquivo recebido vêm achatadas, o app não
    // as enxerga como anotações — só existem aqui.
    for (const h of (doc.herdado && doc.herdado.tec) || [])
      tec.push({ tipo: "tec", pagina: h.p, valor: h.v, qtd: h.q, unit: h.u, herdado: true });
    for (const h of (doc.herdado && doc.herdado.adm) || [])
      adm.push({ tipo: "adm", pagina: h.p, valor: h.v, herdado: true });
  }
  const soma = (l) => Math.round(l.reduce((s, i) => s + i.valor, 0) * 100) / 100;
  const porPagina = (l) => l.sort((a, b) => a.pagina - b.pagina);
  const totalAdm = soma(adm), totalTec = soma(tec);
  const totalGlosado = Math.round((totalAdm + totalTec) * 100) / 100;
  const totalConta = doc ? numeroBR(doc.totalConta) : null;
  return {
    adm: porPagina(adm), tec: porPagina(tec), totalAdm, totalTec, totalGlosado, totalConta,
    valorApurado: totalConta == null ? null : Math.round((totalConta - totalGlosado) * 100) / 100,
  };
};

// ---- passagem entre as etapas da auditoria ----
// O técnico risca e salva; o analista abre o PDF já riscado. Como as marcações saem
// achatadas no arquivo, o app não teria como somar a glosa técnica do colega — então ela
// viaja junto, nas Keywords (campo padrão, que o pdf.js devolve de volta em info.Keywords).
// PREFIXO_GLOSAS e lerGlosasDoPdf moram em src/juntar.js: o script da linha de comando
// precisa dos mesmos, e três cópias da mesma leitura era pedir para uma delas divergir.

// quem já auditou este documento, na ordem. É lista, e não campo único, porque a auditoria
// tem duas etapas: o técnico risca e salva, o administrativo abre o PDF já riscado e exporta
// de novo — com campo único, o segundo apagaria o primeiro.
const listaAuditores = (doc, auditor) => {
  const l = doc && doc.herdado && Array.isArray(doc.herdado.auditores) ? [...doc.herdado.auditores] : [];
  if (!auditor) return l;
  // o papel viaja junto porque o nome do arquivo mora no disco do auditor e pode ser
  // renomeado: sem isto, um "AUDITADO (Técnico)" renomeado à mão perderia a etapa técnica
  const novo = { nome: auditor.nome, email: auditor.email || "", papel: auditor.papel || "",
    em: new Date().toISOString() };
  // reexportar o mesmo documento não empilha a mesma pessoa: atualiza a data dela
  if (l.length && l[l.length - 1].email === novo.email) l[l.length - 1] = novo;
  else l.push(novo);
  return l;
};
// ---- nome do arquivo exportado ----
// A máscara diz por que etapas o documento passou. O rótulo sai do papel gravado no banco
// (perfis.papel), então o nome herda a mesma garantia do resto: ninguém se promove a
// técnico mexendo no JS do navegador.
export const ROTULO_PAPEL = { tecnico: "Técnico", administrativo: "Administrativo" };

// comparar sem acento e sem caixa: o auditor renomeia arquivo no Windows, e um "(tecnico)"
// digitado à mão tem que contar como a mesma marca que "(Técnico)"
const chaveRotulo = (s) =>
  String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const CANONICO = new Map(Object.values(ROTULO_PAPEL).map((r) => [chaveRotulo(r), r]));

// " - AUDITADO" seguido dos rótulos, no fim do nome
const MASCARA = /\s*-\s*AUDITADO((?:\s*\([^()]*\))*)\s*$/i;

// Monta o nome de saída sem nunca repetir a máscara: o auditor salva, para, e só depois
// continua o processo — reabrindo o próprio arquivo baixado. Antes disso cada volta
// empilhava mais um " - AUDITADO" no nome.
// `herdados` são os papéis lidos dos metadados do PDF; `rotulo` é o de quem está salvando.
export const nomeAuditado = (nome, rotulo, herdados) => {
  let base = String(nome || "").replace(/\.pdf$/i, "");
  let rotulos = [];
  // laço, e não um replace só, por causa dos arquivos que a versão anterior gerou com
  // " - AUDITADO - AUDITADO" empilhado
  for (;;) {
    const m = MASCARA.exec(base);
    if (!m) break;
    const grupos = (m[1].match(/\([^()]*\)/g) || []).map((g) => CANONICO.get(chaveRotulo(g.slice(1, -1))));
    // parêntese que não é papel conhecido (o "(corrigido)" do scripts/reparar-rotacao.mjs,
    // por exemplo) não é máscara nossa: fica onde está
    if (grupos.some((g) => !g)) break;
    rotulos = grupos.concat(rotulos); // a descasca vem da direita, então acumula à esquerda
    base = base.slice(0, m.index);
  }
  const juntar = (r) => {
    if (r && !rotulos.some((x) => chaveRotulo(x) === chaveRotulo(r))) rotulos.push(r);
  };
  (herdados || []).forEach(juntar);
  juntar(rotulo);
  // rótulo vazio (papel desconhecido no banco) degrada para o " - AUDITADO" seco de antes,
  // em vez de escrever "(undefined)" no nome do arquivo do auditor
  return base + " - AUDITADO" + rotulos.map((r) => ` (${r})`).join("") + ".pdf";
};

// papéis de quem já auditou, lidos das Keywords do PDF (mesmo acesso defensivo de
// ultimoAuditor). PDF exportado antes desta versão não traz papel: devolve lista vazia e
// quem manda passa a ser só o nome do arquivo.
const rotulosHerdados = (doc) => {
  const l = doc && doc.herdado && Array.isArray(doc.herdado.auditores) ? doc.herdado.auditores : [];
  return l.map((a) => (a && ROTULO_PAPEL[a.papel]) || "").filter(Boolean);
};

// mediana por canal de um bloco RGBA — o miolo do conta-gotas do corretivo.
// Mediana, e não média: um pixel escuro no meio de fundo claro (a borda de uma letra) puxaria
// a média para o cinza e o corretivo sairia manchado. Exportada para poder ser testada.
export const corMediana = (data) => {
  const canal = (off) => {
    const v = [];
    for (let i = off; i < data.length; i += 4) v.push(data[i]);
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)].toString(16).padStart(2, "0");
  };
  return `#${canal(0)}${canal(1)}${canal(2)}`;
};

const dataCurta = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "" : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
};
const ultimoAuditor = (doc) => {
  const l = doc && doc.herdado && Array.isArray(doc.herdado.auditores) ? doc.herdado.auditores : [];
  return l.length ? l[l.length - 1] : null;
};

const gravarGlosas = (out, doc, auditor) => {
  const g = calcGlosas(doc);
  const auditores = listaAuditores(doc, auditor);
  // sem glosa nenhuma o payload ainda vale a pena: ele carrega a autoria
  if (!g.tec.length && !g.adm.length && g.totalConta == null && !auditores.length) return;
  const payload = {
    v: 1,
    totalConta: g.totalConta,
    tec: g.tec.map((i) => ({ p: i.pagina, q: i.qtd, u: i.unit, v: i.valor })),
    adm: g.adm.map((i) => ({ p: i.pagina, v: i.valor })),
    auditores,
  };
  // o pdf-lib junta o array num único campo separado por espaço, e é assim que o pdf.js
  // devolve — por isso a nossa entrada vai por último e o JSON sai sem espaços.
  out.setKeywords([doc.keywordsOriginais || "", PREFIXO_GLOSAS + JSON.stringify(payload)]
    .filter(Boolean));
};
// conversão das anotações para o rascunho — ver src/rascunho.js
const { serializarAnns, restaurarAnns, dataUrlParaBlob, blobParaDataUrl, hashesDosRegistros } = rascunho;

// ---- carimbos ----
// A assinatura mora num bucket privado do Supabase, uma pasta por usuário, e só o dono
// baixa a dele. Em memória durante a sessão e nada em disco: carimbo parado no
// localStorage era exatamente o que precisávamos parar de fazer.
// Limpa de uma vez as chaves das versões anteriores, que ainda guardam assinatura aqui.
const ehUuid = (v) =>
  typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);

const limparCarimbosAntigos = () => {
  try {
    const mortas = Object.keys(localStorage)
      .filter((k) => k === "carimbos" || k.startsWith("carimbos:"));
    for (const k of mortas) localStorage.removeItem(k);
  } catch { /* sem localStorage não há o que limpar */ }
};

// ---- giro de página ----
// Digitalização deitada dentro de folha em pé é rotina nos lotes que chegam. O auditor
// gira a página; o giro é RELATIVO ao /Rotate que o PDF já traz e vale na tela e na
// exportação. Página sem entrada em doc.rotacoes = sem giro.
const giroDaPagina = (doc, pg) =>
  (doc && doc.rotacoes && doc.rotacoes[pg]) || 0;

// Leva um ponto do espaço de tela ANTES do giro para o espaço DEPOIS dele.
// Wv/Hv são as dimensões do viewport antes de girar; em ±90 elas trocam de lugar.
const giraPonto = (x, y, delta, Wv, Hv) =>
  delta === 90 ? { x: Hv - y, y: x }
    : delta === 270 ? { x: y, y: Wv - x }
      : { x: Wv - x, y: Hv - y };            // 180

// Gira as marcações já feitas na página, para elas continuarem coladas no conteúdo.
//
// Traço, linha e realce são geometria pura e giram junto. Texto, símbolo e carimbo são
// caixas que o editor sempre desenha alinhadas à tela: giram de posição (pelo centro,
// que é o que não se mexe do lugar) mas mantêm a própria forma — depois do giro a nota
// continua legível, que é o que se espera de uma nota.
const girarAnns = (lista, delta, Wv, Hv) => {
  const d = ((delta % 360) + 360) % 360;
  if (!d || !lista) return;
  const troca = d !== 180;                  // em ±90 largura e altura trocam
  // gira a caixa pelo centro e devolve o novo canto superior-esquerdo
  const porCentro = (a, w, h) => {
    const c = giraPonto(a.x + w / 2, a.y + h / 2, d, Wv, Hv);
    return { x: c.x - w / 2, y: c.y - h / 2 };
  };
  for (const a of lista) {
    if (a.type === "pen") {
      a.points = (a.points || []).map((p) => giraPonto(p.x, p.y, d, Wv, Hv));
    } else if (a.type === "strike" || a.type === "highlight") {
      const p1 = giraPonto(a.x1, a.y1, d, Wv, Hv);
      const p2 = giraPonto(a.x2, a.y2, d, Wv, Hv);
      a.x1 = p1.x; a.y1 = p1.y; a.x2 = p2.x; a.y2 = p2.y;
    } else if (a.type === "cover" || a.type === "stamp") {
      // corretivo e carimbo cobrem uma área do documento: a área tem de girar junto,
      // então aqui a caixa troca de lado além de mudar de lugar.
      const p1 = giraPonto(a.x, a.y, d, Wv, Hv);
      const p2 = giraPonto(a.x + a.w, a.y + a.h, d, Wv, Hv);
      a.x = Math.min(p1.x, p2.x); a.y = Math.min(p1.y, p2.y);
      if (troca) { const t = a.w; a.w = a.h; a.h = t; }
    } else if (a.type === "symbol") {
      const p = porCentro(a, a.size, a.size);
      a.x = p.x; a.y = p.y;
    } else if (a.type === "text") {
      // w/h da caixa de texto são medidos na tela (ver TextBox.measure) e não giram:
      // o texto continua correndo na horizontal, só a caixa muda de lugar.
      const p = porCentro(a, a.w || 0, a.h || 0);
      a.x = p.x; a.y = p.y;
    }
  }
};

// botão redondo (× fechar / excluir)
function RoundBtn({ style, title, onAction, bg, children }) {
  return (
    <button
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onAction(); }}
      title={title}
      style={{
        position: "absolute", width: 22, height: 22, borderRadius: "50%",
        border: "none", background: bg, color: "#fff", fontSize: 14,
        lineHeight: "22px", textAlign: "center", cursor: "pointer", padding: 0,
        boxShadow: "0 1px 3px rgba(0,0,0,.3)", zIndex: 3, touchAction: "none", ...style,
      }}
    >
      {children}
    </button>
  );
}

// etiqueta do tamanho atual, ao lado da caixa, só enquanto a alça está sendo arrastada
function TagTamanho({ children }) {
  return (
    <div style={{
      position: "absolute", top: -26, left: "50%", transform: "translateX(-50%)",
      padding: "2px 7px", borderRadius: 10, whiteSpace: "nowrap",
      background: "rgba(17,24,39,.9)", color: "#fff", fontSize: 11, fontWeight: 700,
      lineHeight: "16px", pointerEvents: "none", zIndex: 4,
    }}>
      {children}
    </div>
  );
}

// Sensibilidade das alças de redimensionar: pixels de arrasto na tela por ponto de
// tamanho. As alças multiplicavam o tamanho pela razão das distâncias até o centro da
// caixa; numa caixa pequena (meia diagonal ~28px) um arrasto de 60px triplicava a fonte,
// e foi assim que uma conta de corpo 7pt recebeu marcação de 37pt. Somar o deslocamento
// em vez de multiplicar tira o salto e mantém o controle fino.
const PX_POR_PONTO = 4;

// ---- caixa de texto editável, móvel e redimensionável (estilo Canva) ----
function TextBox({ a, scale, tetoFonte, editing, selected, interactive, onChange, onMove,
  onResize, onMeasure, onStartEdit, onEndEdit, onSelect, onDelete, onCancel, onDuplicate }) {
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const drag = useRef(null);
  const rez = useRef(null);

  const [hover, setHover] = useState(false);
  const [redim, setRedim] = useState(false); // mostra o tamanho em pt enquanto arrasta

  // foca ao entrar em edição (após o DOM assentar, evita blur imediato)
  useEffect(() => {
    if (!editing) return;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) { el.focus({ preventScroll: true }); el.select(); }
    });
    return () => cancelAnimationFrame(id);
  }, [editing]);

  // mede tamanho real e reporta em coords do documento
  const measure = () => {
    const el = boxRef.current; if (!el) return;
    onMeasure(el.offsetWidth / scale, el.offsetHeight / scale);
  };
  useEffect(() => { if (!editing) measure(); });

  const startDrag = (e) => {
    if (editing) return;
    e.stopPropagation();
    onSelect();
    drag.current = { px: e.clientX, py: e.clientY, x: a.x, y: a.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e) => {
    if (!drag.current) return;
    const d = drag.current;
    const nx = d.x + (e.clientX - d.px) / scale;
    const ny = d.y + (e.clientY - d.py) / scale;
    if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 2) d.moved = true;
    onMove(Math.max(0, nx), Math.max(0, ny));
  };
  const endDrag = () => { drag.current = null; measure(); };

  // ---- redimensionar o tamanho da fonte (arrastar alça no canto) ----
  // ver PX_POR_PONTO: soma o deslocamento, não multiplica pela razão de distâncias
  const startResize = (e) => {
    e.stopPropagation();
    const r = boxRef.current.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    rez.current = { cx, cy, startSize: a.size,
      startDist: Math.hypot(e.clientX - cx, e.clientY - cy) };
    setRedim(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize = (e) => {
    const rc = rez.current; if (!rc) return;
    const dist = Math.hypot(e.clientX - rc.cx, e.clientY - rc.cy);
    // /scale para o arrasto valer os mesmos pontos em qualquer zoom
    const novo = rc.startSize + (dist - rc.startDist) / (PX_POR_PONTO * scale);
    onResize(Math.max(6, Math.min(tetoFonte, novo)));
  };
  const endResize = () => { if (rez.current) { rez.current = null; setRedim(false); measure(); } };

  const commonStyle = {
    position: "absolute",
    left: a.x * scale,
    top: a.y * scale,
    color: a.color,
    fontSize: a.size * scale,
    fontWeight: 600,
    fontFamily: "sans-serif",
    lineHeight: 1.25,
    whiteSpace: "pre",
    pointerEvents: interactive ? "auto" : "none",
    touchAction: "none", // arraste com o dedo sem rolar a página
  };

  if (editing) {
    return (
      <div style={{ position: "absolute", left: a.x * scale, top: a.y * scale,
        pointerEvents: interactive ? "auto" : "none" }}>
        <input
          ref={inputRef}
          value={a.text}
          placeholder="digite…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onEndEdit(); }
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          onBlur={onEndEdit}
          style={{
            display: "block",
            color: a.color, fontSize: a.size * scale, fontWeight: 600,
            fontFamily: "sans-serif", lineHeight: 1.25,
            padding: "2px 5px", margin: 0,
            border: "2px solid var(--accent)", borderRadius: 5, outline: "none",
            boxShadow: "0 2px 10px rgba(0,0,0,.18)", background: "#fff", minWidth: 90,
          }}
        />
        {/* × desistir de escrever */}
        <RoundBtn bg="#111827" title="Fechar / desistir" onAction={onCancel}
          style={{ top: -9, right: -9 }}>×</RoundBtn>
      </div>
    );
  }

  const showBox = selected || hover;
  const handles = [
    { key: "tl", pos: { top: -8, left: -8, cursor: "nwse-resize" } },
    { key: "bl", pos: { bottom: -8, left: -8, cursor: "nesw-resize" } },
    { key: "br", pos: { bottom: -8, right: -8, cursor: "nwse-resize" } },
  ];
  return (
    <div
      ref={boxRef}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={interactive ? "Duplo clique para editar · arraste para mover" : undefined}
      style={{
        ...commonStyle,
        padding: "2px 5px",
        cursor: interactive ? "move" : "default",
        borderRadius: 5,
        border: showBox ? "1.5px dashed var(--accent)" : "1.5px solid transparent",
        background: showBox ? "rgba(255,255,255,.10)" : "transparent",
        userSelect: "none",
      }}
    >
      {a.text || " "}
      {selected && interactive && (
        <>
          <RoundBtn bg="#d92d20" title="Excluir" onAction={onDelete} style={{ top: -10, right: -10 }}>
          ×
          </RoundBtn>
          <RoundBtn bg="#1f6feb" title="Duplicar texto" onAction={onDuplicate}
            style={{ top: -10, left: -10 }}>
            <Copy style={{ width: 12, height: 12, margin: "0 auto" }} />
          </RoundBtn>
          {/* tamanho em pt enquanto arrasta: o exagero fica visível antes de exportar */}
          {redim && <TagTamanho>{Math.round(a.size)} pt</TagTamanho>}
          {handles.map((h) => (
            <div
              key={h.key}
              onPointerDown={startResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              style={{
                position: "absolute", width: 16, height: 16, borderRadius: 4,
                background: "#fff", border: "1.5px solid var(--accent)",
                boxShadow: "0 1px 3px rgba(0,0,0,.3)", zIndex: 2,
                touchAction: "none", ...h.pos,
              }}
            />
          ))}
          {/* alça de mover: alvo grande e separado do × (evita excluir sem querer) */}
          <div
            onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag}
            title="Arraste para mover"
            style={{
              position: "absolute", bottom: -30, left: "50%", transform: "translateX(-50%)",
              width: 34, height: 24, borderRadius: 12,
              background: "var(--accent)", color: "var(--accent-contrast)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 1px 4px rgba(0,0,0,.35)", zIndex: 3, cursor: "move", touchAction: "none",
            }}
          >
            <Move style={{ width: 16, height: 16 }} />
          </div>
        </>
      )}
    </div>
  );
}

// ---- carimbo inserido no PDF: mover, redimensionar (proporção fixa) e excluir ----
function StampBox({ a, scale, tetoLargura, selected, interactive, onMove, onResize, onSelect, onDelete, onDuplicate }) {
  const boxRef = useRef(null);
  const drag = useRef(null);
  const rez = useRef(null);
  const [hover, setHover] = useState(false);

  const startDrag = (e) => {
    e.stopPropagation();
    onSelect();
    drag.current = { px: e.clientX, py: e.clientY, x: a.x, y: a.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e) => {
    if (!drag.current) return;
    const d = drag.current;
    onMove(Math.max(0, d.x + (e.clientX - d.px) / scale),
           Math.max(0, d.y + (e.clientY - d.py) / scale));
  };
  const endDrag = () => { drag.current = null; };

  // ver PX_POR_PONTO: soma o deslocamento, não multiplica pela razão de distâncias
  const startResize = (e) => {
    e.stopPropagation();
    const r = boxRef.current.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    rez.current = { cx, cy, w0: a.w, h0: a.h,
      d0: Math.hypot(e.clientX - cx, e.clientY - cy) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize = (e) => {
    const rc = rez.current; if (!rc) return;
    // o carimbo é grande, então cada px de arrasto vale 2pt de largura (sem amortecer)
    const d = (Math.hypot(e.clientX - rc.cx, e.clientY - rc.cy) - rc.d0) / scale;
    const w = Math.max(24, Math.min(tetoLargura, rc.w0 + d * 2));
    onResize(w, w * (rc.h0 / rc.w0)); // mantém a proporção
  };
  const endResize = () => { rez.current = null; };

  const showBox = selected || hover;
  const handles = [
    { key: "tl", pos: { top: -8, left: -8, cursor: "nwse-resize" } },
    { key: "bl", pos: { bottom: -8, left: -8, cursor: "nesw-resize" } },
    { key: "br", pos: { bottom: -8, right: -8, cursor: "nwse-resize" } },
  ];
  return (
    <div
      ref={boxRef}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={interactive ? "Arraste p/ mover · cantos p/ tamanho" : undefined}
      style={{
        position: "absolute",
        left: a.x * scale,
        top: a.y * scale,
        width: a.w * scale,
        height: a.h * scale,
        cursor: interactive ? "move" : "default",
        borderRadius: 5,
        border: showBox ? "1.5px dashed var(--accent)" : "1.5px solid transparent",
        pointerEvents: interactive ? "auto" : "none",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <img src={a.url} alt="" draggable={false} onContextMenu={(e) => e.preventDefault()}
        style={{ width: "100%", height: "100%", pointerEvents: "none", userSelect: "none" }} />
      {selected && interactive && (
        <>
          <RoundBtn bg="#d92d20" title="Excluir" onAction={onDelete}
            style={{ top: -10, right: -10 }}>×</RoundBtn>
          <RoundBtn bg="#1f6feb" title="Duplicar carimbo" onAction={onDuplicate}
            style={{ top: -10, left: -10 }}>
            <Copy style={{ width: 12, height: 12, margin: "0 auto" }} />
          </RoundBtn>
          {handles.map((h) => (
            <div
              key={h.key}
              onPointerDown={startResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              style={{
                position: "absolute", width: 16, height: 16, borderRadius: 4,
                background: "#fff", border: "1.5px solid var(--accent)",
                boxShadow: "0 1px 3px rgba(0,0,0,.3)", zIndex: 2,
                touchAction: "none", ...h.pos,
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ---- corretivo: retângulo opaco na cor do fundo, para cobrir marcação já achatada ----
// Redimensiona livre (não proporcional, ao contrário do carimbo): cobrir um valor exige
// ajustar largura e altura de forma independente.
function CoverBox({ a, scale, selected, interactive, onMove, onResize, onSelect, onDelete }) {
  const drag = useRef(null);
  const rez = useRef(null);
  const [hover, setHover] = useState(false);

  const startDrag = (e) => {
    e.stopPropagation();
    onSelect();
    drag.current = { px: e.clientX, py: e.clientY, x: a.x, y: a.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e) => {
    if (!drag.current) return;
    const d = drag.current;
    onMove(Math.max(0, d.x + (e.clientX - d.px) / scale),
           Math.max(0, d.y + (e.clientY - d.py) / scale));
  };
  const endDrag = () => { drag.current = null; };

  const startResize = (e) => {
    e.stopPropagation();
    rez.current = { px: e.clientX, py: e.clientY, w0: a.w, h0: a.h };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize = (e) => {
    const r = rez.current; if (!r) return;
    onResize(Math.max(4, r.w0 + (e.clientX - r.px) / scale),
             Math.max(4, r.h0 + (e.clientY - r.py) / scale));
  };
  const endResize = () => { rez.current = null; };

  return (
    <div
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={interactive ? "Corretivo — arraste p/ mover · canto p/ tamanho" : undefined}
      style={{
        position: "absolute",
        left: a.x * scale, top: a.y * scale,
        width: a.w * scale, height: a.h * scale,
        background: a.color || "#ffffff",
        cursor: interactive ? "move" : "default",
        // contorno só na tela, nunca na exportação: um corretivo branco sobre fundo branco
        // seria invisível e impossível de reposicionar depois
        outline: !interactive ? "none"
          : selected || hover ? "1.5px dashed var(--accent)" : "1px dashed rgba(120,120,120,.55)",
        outlineOffset: 0,
        pointerEvents: interactive ? "auto" : "none",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {selected && interactive && (
        <>
          <RoundBtn bg="#d92d20" title="Excluir" onAction={onDelete}
            style={{ top: -10, right: -10 }}>×</RoundBtn>
          <div
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            style={{
              position: "absolute", bottom: -8, right: -8, width: 16, height: 16,
              borderRadius: 4, background: "#fff", border: "1.5px solid var(--accent)",
              boxShadow: "0 1px 3px rgba(0,0,0,.3)", zIndex: 2,
              cursor: "nwse-resize", touchAction: "none",
            }}
          />
        </>
      )}
    </div>
  );
}

// ---- símbolo ✓ / ✗ (marca de verificado): mover, redimensionar e excluir ----
// desenhado como vetor (SVG na tela, drawLine no PDF) — nítido em qualquer zoom
function SymbolBox({ a, scale, tetoFonte, selected, interactive, onMove, onResize, onSelect, onDelete, onDuplicate }) {
  const boxRef = useRef(null);
  const drag = useRef(null);
  const rez = useRef(null);
  const [hover, setHover] = useState(false);
  const [redim, setRedim] = useState(false); // mostra o tamanho em pt enquanto arrasta
  const px = a.size * scale;

  const startDrag = (e) => {
    e.stopPropagation();
    onSelect();
    drag.current = { px: e.clientX, py: e.clientY, x: a.x, y: a.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e) => {
    if (!drag.current) return;
    const d = drag.current;
    onMove(Math.max(0, d.x + (e.clientX - d.px) / scale),
           Math.max(0, d.y + (e.clientY - d.py) / scale));
  };
  const endDrag = () => { drag.current = null; };

  // ver PX_POR_PONTO: soma o deslocamento, não multiplica pela razão de distâncias
  const startResize = (e) => {
    e.stopPropagation();
    const r = boxRef.current.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    rez.current = { cx, cy, startSize: a.size,
      startDist: Math.hypot(e.clientX - cx, e.clientY - cy) };
    setRedim(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveResize = (e) => {
    const rc = rez.current; if (!rc) return;
    const dist = Math.hypot(e.clientX - rc.cx, e.clientY - rc.cy);
    const novo = rc.startSize + (dist - rc.startDist) / (PX_POR_PONTO * scale);
    // o ✓/✗ é um sinal de conferência: pode passar um pouco do teto do texto
    onResize(Math.max(10, Math.min(tetoFonte * 2, novo)));
  };
  const endResize = () => { if (rez.current) { rez.current = null; setRedim(false); } };

  const Icon = a.symbol === "cross" ? X : Check;
  const showBox = selected || hover;
  const handles = [
    { key: "tl", pos: { top: -8, left: -8, cursor: "nwse-resize" } },
    { key: "br", pos: { bottom: -8, right: -8, cursor: "nwse-resize" } },
  ];
  return (
    <div
      ref={boxRef}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={interactive ? "Arraste p/ mover · cantos p/ tamanho" : undefined}
      style={{
        position: "absolute",
        left: a.x * scale,
        top: a.y * scale,
        width: px,
        height: px,
        cursor: interactive ? "move" : "default",
        borderRadius: 5,
        border: showBox ? "1.5px dashed var(--accent)" : "1.5px solid transparent",
        pointerEvents: interactive ? "auto" : "none",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <Icon style={{ width: "100%", height: "100%", color: a.color, strokeWidth: 3, pointerEvents: "none" }} />
      {selected && interactive && (
        <>
          <RoundBtn bg="#d92d20" title="Excluir" onAction={onDelete}
            style={{ top: -10, right: -10 }}>×</RoundBtn>
          <RoundBtn bg="#1f6feb" title="Duplicar" onAction={onDuplicate}
            style={{ top: -10, left: -10 }}>
            <Copy style={{ width: 12, height: 12, margin: "0 auto" }} />
          </RoundBtn>
          {redim && <TagTamanho>{Math.round(a.size)} pt</TagTamanho>}
          {handles.map((h) => (
            <div
              key={h.key}
              onPointerDown={startResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              style={{
                position: "absolute", width: 16, height: 16, borderRadius: 4,
                background: "#fff", border: "1.5px solid var(--accent)",
                boxShadow: "0 1px 3px rgba(0,0,0,.3)", zIndex: 2,
                touchAction: "none", ...h.pos,
              }}
            />
          ))}
          {/* alça de mover: alvo grande e separado do × (evita excluir sem querer) */}
          <div
            onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag}
            title="Arraste para mover"
            style={{
              position: "absolute", bottom: -30, left: "50%", transform: "translateX(-50%)",
              width: 34, height: 24, borderRadius: 12,
              background: "var(--accent)", color: "var(--accent-contrast)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 1px 4px rgba(0,0,0,.35)", zIndex: 3, cursor: "move", touchAction: "none",
            }}
          >
            <Move style={{ width: 16, height: 16 }} />
          </div>
        </>
      )}
    </div>
  );
}

// ---- linha-guia horizontal: mover (só vertical), selecionar e excluir ----
function LineBox({ a, scale, selected, interactive, onMove, onSelect, onDelete }) {
  const drag = useRef(null);
  const [hover, setHover] = useState(false);
  const HIT = 16; // altura da área de toque (a linha é fina demais p/ agarrar)

  const startDrag = (e) => {
    e.stopPropagation();
    onSelect();
    drag.current = { py: e.clientY, y: a.y1 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e) => {
    if (!drag.current) return;
    const d = drag.current;
    onMove(Math.max(0, d.y + (e.clientY - d.py) / scale)); // só vertical
  };
  const endDrag = () => { drag.current = null; };

  const showBox = selected || hover;
  return (
    <div
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={interactive ? "Arraste para mover (vertical)" : undefined}
      style={{
        position: "absolute",
        left: a.x1 * scale,
        top: a.y1 * scale - HIT / 2,
        width: (a.x2 - a.x1) * scale,
        height: HIT,
        display: "flex",
        alignItems: "center",
        cursor: interactive ? "move" : "default",
        background: showBox ? "rgba(255,255,255,.10)" : "transparent",
        pointerEvents: interactive ? "auto" : "none",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {/* linha colorida real, centralizada na área de toque */}
      <div style={{ width: "100%", height: Math.max(1, a.thickness * scale), background: a.color,
        borderRadius: 2, pointerEvents: "none" }} />
      {selected && interactive && (
        <>
          <RoundBtn bg="#d92d20" title="Excluir" onAction={onDelete}
            style={{ top: -20, left: "50%", marginLeft: -11 }}>×</RoundBtn>
          {/* alça de mover, centralizada abaixo da linha */}
          <div
            onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag}
            title="Arraste para mover"
            style={{
              position: "absolute", bottom: -26, left: "50%", transform: "translateX(-50%)",
              width: 34, height: 24, borderRadius: 12,
              background: "var(--accent)", color: "var(--accent-contrast)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 1px 4px rgba(0,0,0,.35)", zIndex: 3, cursor: "move", touchAction: "none",
            }}
          >
            <Move style={{ width: 16, height: 16 }} />
          </div>
        </>
      )}
    </div>
  );
}

// segmentos vetoriais do símbolo (coords locais 0..size); usados na exportação p/ PDF
const symbolSegs = (sym, size) =>
  sym === "cross"
    ? [[{ x: 0.22, y: 0.22 }, { x: 0.78, y: 0.78 }], [{ x: 0.78, y: 0.22 }, { x: 0.22, y: 0.78 }]]
        .map((seg) => seg.map((p) => ({ x: p.x * size, y: p.y * size })))
    : [[{ x: 0.20, y: 0.55 }, { x: 0.42, y: 0.78 }], [{ x: 0.42, y: 0.78 }, { x: 0.82, y: 0.24 }]]
        .map((seg) => seg.map((p) => ({ x: p.x * size, y: p.y * size })));

// distância de um ponto p ao segmento a–b (para o hit-test da borracha)
const distToSeg = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

// uma das duas linhas de total da calculadora
function LinhaGlosa({ hex, nome, valor, n, nota }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-2.5 h-2.5 rounded-full shrink-0 self-center" style={{ background: hex }} />
      <span className="flex-1 min-w-0">
        <span className="truncate">{nome}</span>
        <span className="block text-[10px] text-[var(--muted)]">
          {n} {n === 1 ? "item" : "itens"}{nota ? ` · ${nota}` : ""}
        </span>
      </span>
      <b className="font-mono tabular-nums">{moeda(valor)}</b>
    </div>
  );
}

// ---- calculadora de glosas (painel flutuante no canto superior direito) ----
// soma sozinha enquanto o auditor marca, e monta o fechamento que hoje é digitado à mão.
// `aberto`/`alterna` vêm do editor (e não de estado local) porque a tecla G também alterna o painel
function CalculadoraGlosas({ g, aberto, alterna, totalConta, onTotalConta, onInserirResumo, onIrPara, onRemover }) {
  const [itens, setItens] = useState(false);

  if (!aberto)
    return (
      <button onClick={() => alterna(true)} title="Abrir a calculadora de glosas (G)"
        className="absolute top-3 right-3 z-20 flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg
          text-sm font-semibold bg-[var(--surface)] border border-[var(--border)] text-[var(--text)]
          hover:bg-[var(--hover)]">
        <Calculator className="w-4 h-4 text-[var(--accent)]" />
        R$ {moeda(g.totalGlosado)}
      </button>
    );

  const herdadosTec = g.tec.filter((i) => i.herdado).length;
  const herdadosAdm = g.adm.filter((i) => i.herdado).length;

  return (
    <div className="absolute top-3 right-3 z-20 w-64 max-w-[calc(100%-1.5rem)] rounded-xl shadow-lg
      bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] text-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <Calculator className="w-4 h-4 text-[var(--accent)]" />
        <b className="flex-1 text-xs uppercase tracking-wide">Glosas</b>
        <button onClick={() => alterna(false)} title="Recolher (G)"
          className="px-1.5 rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">–</button>
      </div>

      <div className="px-3 py-2.5 flex flex-col gap-2">
        <LinhaGlosa hex={COR_ADM} nome="Administrativa" valor={g.totalAdm} n={g.adm.length}
          nota={herdadosAdm ? `${herdadosAdm} do PDF` : ""} />
        <LinhaGlosa hex={COR_TEC} nome="Técnica" valor={g.totalTec} n={g.tec.length}
          nota={herdadosTec ? `${herdadosTec} do PDF` : ""} />

        <div className="border-t border-[var(--border)] pt-2 flex items-baseline gap-2">
          <span className="flex-1">Total glosado</span>
          <b className="font-mono tabular-nums text-[var(--accent)]">{moeda(g.totalGlosado)}</b>
        </div>

        <label className="flex items-center gap-2">
          <span className="flex-1 text-xs text-[var(--muted)]">Total da conta</span>
          <input value={totalConta || ""} onChange={(e) => onTotalConta(e.target.value)}
            placeholder="0,00" inputMode="decimal" title="Total da conta, para calcular o valor apurado"
            className="w-24 px-1.5 py-1 rounded-md text-right font-mono text-xs
              border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
              focus:outline-none focus:border-[var(--accent)]" />
        </label>

        {g.valorApurado != null && (
          <div className="flex items-baseline gap-2">
            <span className="flex-1">Valor apurado</span>
            <b className="font-mono tabular-nums">{moeda(g.valorApurado)}</b>
          </div>
        )}

        <button onClick={onInserirResumo}
          className="mt-1 w-full px-2 py-1.5 rounded-md text-xs font-semibold
            bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90">
          Inserir resumo na página
        </button>

        <button onClick={() => setItens(!itens)}
          className="text-xs text-[var(--muted)] hover:text-[var(--text)] text-left">
          {itens ? "ocultar itens ▴" : "ver itens ▾"}
        </button>
      </div>

      {itens && (
        <div className="max-h-56 overflow-auto border-t border-[var(--border)] maida-scroll">
          {!g.adm.length && !g.tec.length && (
            <div className="px-3 py-3 text-xs text-[var(--muted)]">Nenhuma glosa ainda.</div>
          )}
          {[...g.tec, ...g.adm].map((i, k) => (
            <div key={k} className="flex items-center gap-2 px-3 py-1.5 text-xs
              border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]">
              <span className="w-2 h-2 rounded-full shrink-0"
                style={{ background: i.tipo === "adm" ? COR_ADM : COR_TEC }} />
              <button onClick={() => onIrPara(i.pagina)} title="Ir para a página"
                className="flex-1 text-left text-[var(--muted)] hover:text-[var(--text)] truncate">
                pág. {i.pagina}
                {i.qtd ? <span className="ml-1">({moeda(i.qtd).replace(",00", "")} × {moeda(i.unit)})</span> : null}
                {i.herdado ? <span className="ml-1 opacity-70">· do PDF</span> : null}
              </button>
              <b className="font-mono tabular-nums">{moeda(i.valor)}</b>
              {/* o que o × faz depende da origem: marcação desta sessão sai da página junto;
                  herdada do PDF só sai da conta, porque lá a marcação virou tinta */}
              <button onClick={() => onRemover(i)}
                title={i.herdado
                  ? "Tirar da conta — a marcação já está achatada no PDF recebido e não pode ser apagada"
                  : "Apagar esta glosa e a marcação da página"}
                className="px-1 rounded text-[var(--muted)] hover:bg-[var(--hover)]">×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- tela de atalhos (tecla ?) ----
function AjudaAtalhos({ secoes, onFechar }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onFechar} />
      <div className="relative bg-[var(--surface)] rounded-xl shadow-2xl p-4 w-full max-w-2xl
        max-h-[85vh] overflow-auto maida-scroll border border-[var(--border)]">
        <div className="flex items-center justify-between mb-3">
          <b className="flex items-center gap-2 text-[var(--text)]">
            <Keyboard className="w-4 h-4 text-[var(--accent)]" />
            Atalhos do teclado
          </b>
          <button onClick={onFechar} title="Fechar (Esc)"
            className="w-8 h-8 flex items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-[var(--muted)] mb-3 leading-relaxed">
          Os atalhos não disparam enquanto você digita num campo de texto.
        </p>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4">
          {secoes.map((sec) => (
            <div key={sec.grupo}>
              <div className="text-xs uppercase tracking-wide text-[var(--muted)] mb-1.5">{sec.grupo}</div>
              <div className="flex flex-col">
                {sec.itens.map((it) => (
                  <div key={it.descricao}
                    className="flex items-baseline gap-2 py-1 border-b border-[var(--border)] last:border-0">
                    <span className="flex flex-wrap gap-1 shrink-0">
                      {it.teclas.map((t) => (
                        <kbd key={t} className="px-1.5 py-0.5 rounded-md text-[11px] font-mono
                          border border-[var(--border)] bg-[var(--panel)] text-[var(--text)]">{t}</kbd>
                      ))}
                    </span>
                    <span className="flex-1 text-xs text-[var(--text)] text-right">{it.descricao}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- menu de configurações (engrenagem) ----
// Junta o que é da conta e da aparência: sem isso, a barra da marca acumulava seis botões e
// empurrava o título para baixo em tela estreita.
function MenuConta({ usuario, papel, tema, aberto, onAlternar, onFechar, onSenha, onAtalhos, onTema, onSair }) {
  const caixa = useRef(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e) => { if (caixa.current && !caixa.current.contains(e.target)) onFechar(); };
    document.addEventListener("pointerdown", fora);
    return () => document.removeEventListener("pointerdown", fora);
  }, [aberto, onFechar]);

  const item = "w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left " +
    "text-[var(--text)] hover:bg-[var(--hover)]";

  return (
    <div className="relative" ref={caixa}>
      <button className="btn-tema" onClick={onAlternar} title="Configurações" aria-expanded={aberto}>
        <Settings className="w-4 h-4" />
        <span className="hidden lg:inline">Configurações</span>
      </button>
      {aberto && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-xl overflow-hidden
          shadow-lg border border-[var(--border)] bg-[var(--surface)]">
          <div className="px-3 py-2 border-b border-[var(--border)]">
            <b className="block text-sm truncate text-[var(--text)]">{usuario.nome}</b>
            <span className="block text-xs text-[var(--muted)] truncate">{papel.label || usuario.papel}</span>
          </div>
          <button className={item} onClick={() => { onFechar(); onSenha(); }}>
            <KeyRound className="w-4 h-4 text-[var(--muted)]" />Trocar senha
          </button>
          <button className={item} onClick={() => { onFechar(); onAtalhos(); }}>
            <Keyboard className="w-4 h-4 text-[var(--muted)]" />Atalhos do teclado
          </button>
          <button className={item} onClick={() => { onFechar(); onTema(); }}>
            {tema === "claro"
              ? <Moon className="w-4 h-4 text-[var(--muted)]" />
              : <Sun className="w-4 h-4 text-[var(--muted)]" />}
            Tema {tema === "claro" ? "escuro" : "claro"}
          </button>
          <button className={item + " border-t border-[var(--border)]"} onClick={() => { onFechar(); onSair(); }}>
            <LogOut className="w-4 h-4 text-[var(--muted)]" />Sair
          </button>
        </div>
      )}
    </div>
  );
}

// ---- trocar a própria senha (quem cria conta continua sendo só o admin) ----
function TrocarSenha({ onFechar }) {
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [repete, setRepete] = useState("");
  const [erro, setErro] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [pronto, setPronto] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    if (salvando) return;
    if (nova.length < 6) return setErro("A nova senha precisa ter pelo menos 6 caracteres.");
    if (nova !== repete) return setErro("A confirmação não bate com a nova senha.");
    if (nova === atual) return setErro("A nova senha precisa ser diferente da atual.");
    setSalvando(true); setErro("");
    const { erro: falhou } = await trocarSenha(atual, nova);
    setSalvando(false);
    if (falhou) return setErro(falhou);
    setPronto(true);
    setTimeout(onFechar, 1600);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onFechar} />
      <div className="relative bg-[var(--surface)] rounded-xl shadow-2xl p-5 w-full max-w-sm border border-[var(--border)]">
        <div className="flex items-center justify-between mb-3">
          <b className="text-[var(--text)]">Trocar a minha senha</b>
          <button onClick={onFechar} title="Fechar (Esc)"
            className="w-8 h-8 flex items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {pronto ? (
          <p className="text-sm text-[var(--text)] py-2">
            Senha trocada. Use a nova da próxima vez que entrar.
          </p>
        ) : (
          <form onSubmit={enviar}>
            <CampoSenha label="Senha atual" autoComplete="current-password" value={atual}
              className="mb-3" onChange={(e) => { setAtual(e.target.value); setErro(""); }} />

            <CampoSenha label="Nova senha" autoComplete="new-password" value={nova}
              className="mb-3" onChange={(e) => { setNova(e.target.value); setErro(""); }} />

            <CampoSenha label="Repita a nova senha" autoComplete="new-password" value={repete}
              onChange={(e) => { setRepete(e.target.value); setErro(""); }} />

            {erro && <div className="mt-2 text-xs text-red-500">{erro}</div>}

            <button type="submit" disabled={!atual || !nova || !repete || salvando}
              className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg
                text-sm font-semibold bg-[var(--accent)] text-[var(--accent-contrast)]
                hover:opacity-90 disabled:opacity-40">
              <KeyRound className="w-4 h-4" />{salvando ? "Trocando…" : "Trocar senha"}
            </button>
            <p className="mt-2 text-[11px] text-[var(--muted)] leading-relaxed">
              Pedimos a senha atual porque a sessão fica aberta: sem isso, quem passasse por uma
              máquina destravada trocaria a sua senha.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

// ---- juntar partes de um processo ----
// O SEI entrega processo grande partido em vários downloads. Quem audita uma parte e recebe o
// resto em outro arquivo não tem como somar a glosa das duas — ver src/juntar.js.
//
// A ordem se escolhe arrastando ou pelas setas — os dois caminhos, de propósito. O arrasto no
// toque exige o toque longo de src/arrastar.js, porque a lista rola; as setas ficam para quem
// prefere clique preciso e como saída se o arrasto não pegar em algum aparelho.
function JuntarDocs({ docs, limiteRascunho, juntando, onFechar, onJuntar }) {
  const [ordem, setOrdem] = useState(() => docs.map((d) => d.id));
  const listaRef = useRef(null);
  // arrastar e as setas fazem a mesma coisa: as setas ficam para quem prefere clique preciso,
  // e como saída se o arrasto não pegar em algum aparelho
  const arrasto = useArrastarLista({
    ids: ordem, aoSoltar: setOrdem, containerRef: listaRef, desligado: juntando,
  });
  const lista = arrasto.ordem.map((id) => docs.find((d) => d.id === id)).filter(Boolean);

  const mover = (i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= ordem.length) return;
    const nova = [...ordem];
    [nova[i], nova[j]] = [nova[j], nova[i]];
    setOrdem(nova);
  };

  // numPages e herdado só existem depois que o documento foi aberto uma vez (quem preenche é
  // o efeito de render). Parte nunca aberta mostra "—" e o total vira "≥ N": parsear os PDFs
  // só para o preview seria segundos de espera por uma linha de texto. O que NÃO se pode
  // fazer é mostrar zero como se fosse resposta — a glosa dela existe e entra na junção, que
  // lê os metadados do arquivo na hora.
  const conhecidas = lista.reduce((s, d) => s + (d.numPages || 0), 0);
  const incerto = lista.some((d) => !d.numPages || !d.metaLida);
  const glosa = lista.reduce((s, d) => s + (d.metaLida ? somaHerdada(d.herdado) : 0), 0);
  const glosaIncerta = lista.some((d) => !d.metaLida);
  const bytes = lista.reduce((s, d) => s + (d.bytes ? d.bytes.byteLength : 0), 0);
  const grande = bytes > limiteRascunho;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={juntando ? undefined : onFechar} />
      <div className="relative bg-[var(--surface)] rounded-xl shadow-2xl p-5 w-full max-w-md border border-[var(--border)]">
        <div className="flex items-center justify-between mb-3">
          <b className="text-[var(--text)]">Juntar documentos</b>
          <button onClick={onFechar} disabled={juntando} title="Fechar (Esc)"
            className="w-8 h-8 flex items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-[var(--muted)] mb-2">
          As partes viram um documento só, nesta ordem. A primeira é o começo do processo.
        </p>

        <div ref={listaRef} className="max-h-64 overflow-auto maida-scroll -mx-1 px-1">
          {lista.map((d, i) => (
            <div key={d.id} {...arrasto.props(d.id)}
              className={"flex items-center gap-2 p-2 rounded-lg border mb-1.5 " +
                // uma classe de cursor por vez: com as duas juntas quem ganhava era a ordem
                // em que o Tailwind as emite, não a ordem escrita aqui
                (arrasto.arrastandoId === d.id
                  ? "cursor-grabbing border-[var(--accent)] bg-[var(--panel)] opacity-80 shadow-lg"
                  : "cursor-grab border-[var(--border)]")}>
              <GripVertical className="w-4 h-4 shrink-0 text-[var(--muted)]" />
              <span className="w-5 shrink-0 text-xs font-bold text-[var(--muted)] text-right">{i + 1}.</span>
              <div className="flex-1 min-w-0">
                <span className="block text-sm text-[var(--text)] truncate" title={d.name}>{d.name}</span>
                <span className="block text-[11px] text-[var(--muted)]">
                  {d.numPages ? `${d.numPages} páginas` : "páginas: —"}
                  {!d.metaLida ? " · glosa: —"
                    : somaHerdada(d.herdado) ? ` · glosa R$ ${moeda(somaHerdada(d.herdado))}` : ""}
                </span>
              </div>
              <button onClick={() => mover(i, -1)} disabled={i === 0 || juntando} title="Subir"
                className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-25">
                <ChevronUp className="w-4 h-4" />
              </button>
              <button onClick={() => mover(i, 1)} disabled={i === lista.length - 1 || juntando} title="Descer"
                className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-25">
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 text-xs text-[var(--muted)] leading-relaxed">
          <div>Resultado: <b className="text-[var(--text)]">
            {incerto ? `≥ ${conhecidas}` : conhecidas} páginas</b></div>
          {(glosa > 0 || glosaIncerta) && (
            <div>Glosa que vem junto: <b className="text-[var(--text)]">
              {glosaIncerta ? "≥ " : ""}R$ {moeda(glosa)}</b>
              {glosaIncerta && " — partes ainda não abertas podem trazer mais"}
            </div>
          )}
          <div className="truncate" title={lista[0] && lista[0].name}>
            Nome: {lista[0] ? lista[0].name : "—"}
          </div>
        </div>

        {grande && (
          // acima do limite o binário não entra no IndexedDB, e o rascunho é a única coisa
          // que segura o trabalho num F5 — o auditor precisa saber ANTES de juntar
          <p className="mt-3 text-[11px] text-amber-600 leading-relaxed">
            Juntos passam de {Math.round(limiteRascunho / 1048576)} MB: o documento não cabe no
            rascunho automático, então recarregar a página perderia o trabalho não baixado.
          </p>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onFechar} disabled={juntando}
            className="px-3 py-2 rounded-lg text-sm border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40">
            Cancelar
          </button>
          <button onClick={() => onJuntar(ordem)} disabled={juntando}
            className="px-3 py-2 rounded-lg text-sm font-semibold bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40">
            {juntando ? "Juntando…" : "Juntar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EditorAuditoria({ usuario, onSair, bloqueado = false }) {
  const ready = true; // libs empacotadas no bundle — sempre disponíveis
  const papel = PAPEIS[usuario.papel] || {};
  const carimbaDoc = usaCarimbo(usuario); // técnico assina; administrativo não
  // a toolbar, as teclas numéricas e a tela de atalhos leem todas daqui
  const ferramentas = useMemo(() => ferramentasDe(usuario), [usuario]);
  const [loadErr] = useState("");

  const [tema, setTema] = useState(() => localStorage.getItem("tema") || "claro");
  useEffect(() => { localStorage.setItem("tema", tema); }, [tema]);

  const store = useRef({ docs: [] });
  const seq = useRef(0);
  const [activeId, setActiveId] = useState(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1"); // campo "ir para página" do rodapé
  // contador que força o re-render da página ao girar: doc.rotacoes vive no store.current
  // (ref, não reativo). Usar `rev` aqui redesenharia a página inteira a cada traço.
  const [giroRev, setGiroRev] = useState(0);
  const [scale, setScale] = useState(1.3);
  const [tool, setTool] = useState("pen");
  // a cor padrão sai do papel; os dois botões seguem disponíveis para os dois papéis
  // (o administrativo precisa enxergar, e às vezes ajustar, a glosa técnica herdada do PDF)
  const [color, setColor] = useState(carimbaDoc ? COR_TEC : COR_ADM);
  const [thickness, setThickness] = useState(2);
  // corpo do texto inserido, em pontos do papel. Guardado como o tema: o auditor acerta uma vez
  // e vale para as contas seguintes. (Antes o corpo saía de 15/zoom — trabalhando afastado, a
  // marcação nascia enorme.)
  const [fonte, setFonte] = useState(() =>
    Math.max(6, Math.min(22, Number(localStorage.getItem("fonteTexto")) || 10)));
  // o efeito mora aqui, e não junto do tema: o array de dependências é avaliado durante o
  // render, então lá em cima ele lia `fonte` antes da declaração e derrubava o editor inteiro
  useEffect(() => { localStorage.setItem("fonteTexto", String(fonte)); }, [fonte]);
  const [checkSymbol, setCheckSymbol] = useState("check"); // símbolo ativo: "check" | "cross"
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stampsOpen, setStampsOpen] = useState(false);
  const filaRef = useRef(null); // container que rola da fila — a rolagem automática do arrasto
  const [juntarOpen, setJuntarOpen] = useState(false); // janela de juntar partes do processo
  const [selecionados, setSelecionados] = useState(() => new Set()); // ids marcados na fila
  const [ajudaOpen, setAjudaOpen] = useState(false); // tela de atalhos (tecla ?)
  const [senhaOpen, setSenhaOpen] = useState(false); // trocar a própria senha
  const [menuOpen, setMenuOpen] = useState(false);   // engrenagem do cabeçalho
  // painel da calculadora: mora aqui (e não dentro dela) porque a tecla G também o alterna
  const [calcAberta, setCalcAberta] = useState(() => localStorage.getItem("calcAberta") !== "0");
  const alternaCalc = (v) => { setCalcAberta(v); localStorage.setItem("calcAberta", v ? "1" : "0"); };
  // carimbo do auditor: data-URL vinda do bucket, só em memória
  const [carimbo, setCarimbo] = useState(null);
  const [carimboErro, setCarimboErro] = useState(""); // recusa do servidor ≠ pasta vazia
  const [carimboOcupado, setCarimboOcupado] = useState(true);
  const [dialog, setDialog] = useState(null); // alert/confirm customizado
  const showAlert = (title, message) => setDialog({ title, message, alert: true });
  const showConfirm = (title, message, onConfirm, opts = {}) =>
    setDialog({
      title, message, onConfirm,
      confirmText: opts.confirmText || "Confirmar",
      cancelText: opts.cancelText || "Cancelar",
      onCancel: opts.onCancel,        // recusar pode ter consequência (descartar rascunho)
      semBackdrop: opts.semBackdrop,  // clique fora não pode decidir por engano
    });
  const [editingId, setEditingId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [ocr, setOcr] = useState(null); // leitura de código: { x, y, w, h, loading, text, err }
  const [ocrHold, setOcrHold] = useState(false); // mouse/foco no balão: pausa o fechamento
  const [glosaTec, setGlosaTec] = useState(null); // balão de confirmação da glosa técnica
  const [colGlosa, setColGlosa] = useState(null); // balão da glosa em coluna
  const textSeq = useRef(0);
  const ultimoValorCol = useRef("");  // o valor da última coluna, para não redigitar na seguinte
  const grupoSeq = useRef(0);         // identifica as caixas nascidas do mesmo arrasto
  const editOrig = useRef("");
  const [rev, tick] = useReducer((x) => x + 1, 0); // rev também serve de dep p/ os memos

  // ---- rascunho automático ----
  const persistir = useRef(false);   // desligado se o IndexedDB falhou ou outra aba é a dona
  const bootFeito = useRef(false);   // <StrictMode> monta 2× em dev: o boot roda uma só vez
  const montagens = useRef(0);       // distingue a remontagem do StrictMode da saída de verdade
  const autosave = useRef({ timer: 0, ultimo: 0 });
  const ordemSeq = useRef(0);        // ordem da fila, estável entre sessões
  const avisouFalha = useRef(false); // o aviso de falha aparece no máximo uma vez
  const imgsGravadas = useRef(new Set()); // hashes de carimbo já no banco

  // limpa edição/seleção ao trocar de documento ou página
  useEffect(() => {
    setEditingId(null); setSelectedId(null); setOcr(null); setOcrHold(false); setGlosaTec(null);
    setColGlosa(null);
  }, [activeId, page]);

  // mantém o campo do rodapé em sincronia quando a página muda por fora (setas, troca de doc)
  useEffect(() => { setPageInput(String(page)); }, [page, activeId]);

  const baseRef = useRef(null);
  const overlayRef = useRef(null);
  const wrapRef = useRef(null);
  const mainRef = useRef(null);
  const fileRef = useRef(null);
  const folderRef = useRef(null);
  const stampFileRef = useRef(null);
  const drawing = useRef(false);
  const startPt = useRef(null);
  const penPts = useRef(null);    // pontos do traço livre em andamento (canetinha)
  const corCover = useRef(null);  // cor amostrada no início do arrasto do corretivo
  const panning = useRef(null); // arrastar para navegar no modo neutro
  const redo = useRef([]);      // pilha de refazer: { docId, page, ann }
  const focal = useRef(null);   // ponto (coords doc) a centralizar após mudar o zoom
  const lastTap = useRef(null); // detecção de duplo toque
  const pointers = useRef(new Map()); // ponteiros ativos no overlay
  const pinch = useRef(null);   // estado da pinça (2 dedos)

  const getActive = () => store.current.docs.find((d) => d.id === activeId);

  // ---- rascunho: gravação de um documento ----
  // monta o registro leve (sem bytes, sem pdfDoc) e manda para o IndexedDB.
  // pdfDoc é um PDFDocumentProxy com worker e referências circulares — o structured
  // clone do IndexedDB falharia se ele entrasse aqui.
  const salvarRascunho = (doc, pg) => {
    if (!persistir.current || !doc || !doc.key) return;
    try {
      // O binário vai uma vez só, mas a garantia fica aqui (e não em addFiles) para cobrir
      // dois casos em que o registro sobraria sem arquivo — e sumiria sem aviso na volta:
      // arquivos abertos antes do boot terminar, e edição retomada depois de exportar.
      if (!doc.binarioGravado && doc.bytes) {
        if (doc.bytes.byteLength > rascunho.LIMITE_ARQUIVO) doc.semBinario = true;
        else {
          doc.binarioGravado = true;
          rascunho.salvarPdf(doc.key, new Blob([doc.bytes], { type: "application/pdf" }));
        }
      }
      const imagens = new Map();
      const annotations = serializarAnns(doc.annotations, imagens);
      // a imagem do carimbo vai uma vez por sessão, não a cada gravação: converter o
      // base64 e reescrever a cada 2s seria caro à toa (a imagem nunca muda).
      for (const [h, url] of imagens) {
        if (imgsGravadas.current.has(h)) continue;
        const b = dataUrlParaBlob(url);
        if (b) { imgsGravadas.current.add(h); rascunho.salvarImagem(h, b); }
      }
      rascunho.salvarSessao({
        key: doc.key, dono: usuario.id, nome: doc.name, ordem: doc.ordem || 0,
        page: pg || doc.page || 1, numPages: doc.numPages || 0,
        totalConta: doc.totalConta || "", herdado: doc.herdado || null,
        keywordsOriginais: doc.keywordsOriginais || "",
        metaLida: !!doc.metaLida, semBinario: !!doc.semBinario,
        rotacoes: doc.rotacoes || {},
        annotations, atualizadoEm: Date.now(),
      });
    } catch { /* gravar rascunho nunca pode interromper a marcação em andamento */ }
  };

  // ---- calculadora de glosas ----
  // recalcula a cada render: o tick() que toda mutação já dispara faz os totais subirem
  // enquanto o auditor ainda está digitando dentro da caixa de texto.
  const glosas = useMemo(
    () => calcGlosas(store.current.docs.find((d) => d.id === activeId)),
    [activeId, rev]);

  // ferramentas de desenho/marcação: enquanto ativas, as caixas DOM ficam não-interativas
  const isDrawTool = ["pen", "line", "highlight", "check", "eraser", "ocr", "cover", "colglosa"].includes(tool);

  // Tetos das alças de redimensionar, ancorados no papel e não no zoom: ~22pt de fonte
  // (em A4, proporcional em papel maior) e 60% da largura da página para o carimbo.
  // Em pt: é o tamanho que vai para o PDF, não o que aparece na tela.
  const cv = baseRef.current;
  const larguraPapel = cv ? cv.width / scale : 595;
  const menorLado = cv ? Math.min(cv.width, cv.height) / scale : 595;
  const tetoFonte = Math.max(12, Math.round(22 * (menorLado / 595)));
  const tetoLargura = Math.round(larguraPapel * 0.6);

  // ---- borracha: acha a anotação sob o ponto (de cima p/ baixo) ----
  const hitAnnotation = (p) => {
    const doc = getActive(); if (!doc) return null;
    const list = doc.annotations[page] || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (a.type === "pen") {
        const lim = Math.max(6, a.thickness * 1.5) / scale;
        const pts = a.points || [];
        for (let j = 1; j < pts.length; j++)
          if (distToSeg(p, pts[j - 1], pts[j]) <= lim) return a;
      } else if (a.type === "strike") {
        const lim = Math.max(6, a.thickness * 1.5) / scale;
        if (distToSeg(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) <= lim) return a;
      } else if (a.type === "highlight") {
        const x0 = Math.min(a.x1, a.x2), x1 = Math.max(a.x1, a.x2);
        const y0 = Math.min(a.y1, a.y2), y1 = Math.max(a.y1, a.y2);
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return a;
      } else {
        // text / stamp / symbol — caixa x,y,w/h (símbolo é quadrado: size×size)
        const w = a.type === "symbol" ? a.size : (a.w || 0);
        const h = a.type === "symbol" ? a.size : (a.h || 0);
        const m = 4 / scale; // margem de tolerância
        if (p.x >= a.x - m && p.x <= a.x + w + m && p.y >= a.y - m && p.y <= a.y + h + m) return a;
      }
    }
    return null;
  };
  // remove uma anotação específica (por referência) — usada pela borracha
  const eraseAt = (p) => {
    const doc = getActive(); if (!doc) return false;
    const alvo = hitAnnotation(p); if (!alvo) return false;
    doc.annotations[page] = (doc.annotations[page] || []).filter((x) => x !== alvo);
    doc.saved = false;
    if (alvo.id && selectedId === alvo.id) setSelectedId(null);
    return true;
  };

  // ---- folder input attribute ----
  useEffect(() => {
    if (folderRef.current) folderRef.current.setAttribute("webkitdirectory", "");
  }, [ready]);

  // ---- render da página ----
  useEffect(() => {
    if (!ready || !activeId) return;
    let cancelled = false;
    const alvo = getActive(); // fora da promessa: o catch precisa saber de qual documento veio
    if (!alvo) return;
    (async () => {
      const doc = alvo;
      if (!doc.pdfDoc) {
        // isEvalSupported:false → mitiga GHSA-wgrm-67xf-hhpq (exec. de JS em PDF malicioso)
        doc.pdfDoc = await pdfjsLib.getDocument({ data: doc.bytes.slice(0), isEvalSupported: false }).promise;
        doc.numPages = doc.pdfDoc.numPages;
        // glosas deixadas por uma etapa anterior da auditoria (ver gravarGlosas).
        // Só na primeira abertura: num documento restaurado do rascunho, doc.herdado já
        // reflete o que o auditor mexeu (removerGlosa dá splice nele) e reler os
        // metadados aqui faria os itens removidos voltarem sozinhos.
        if (!doc.metaLida) {
          try {
            const { info } = await doc.pdfDoc.getMetadata();
            const { herdado, keywordsOriginais } = lerGlosasDoPdf(info && info.Keywords);
            doc.herdado = herdado; doc.keywordsOriginais = keywordsOriginais;
            if (herdado && herdado.totalConta != null && !doc.totalConta)
              doc.totalConta = moeda(herdado.totalConta);
          } catch { /* PDF sem metadados legíveis — segue sem herança */ }
          doc.metaLida = true;
        }
        tick();
      }
      const pageObj = await doc.pdfDoc.getPage(page);
      if (cancelled) return;
      // giro do auditor (ver girarPagina): o `rotation` do getViewport é ABSOLUTO, então
      // soma-se ao /Rotate que a página já traz em vez de substituí-lo.
      const rotacao = pageObj.rotate + giroDaPagina(doc, page);
      // auto-fit: na 1ª abertura do doc, ajusta o zoom à largura disponível (celular)
      if (!doc.autoFit) {
        doc.autoFit = true;
        const avail = mainRef.current ? mainRef.current.clientWidth - 32 : 0;
        if (avail > 0) {
          const vp1 = pageObj.getViewport({ scale: 1, rotation: rotacao });
          const fit = Math.min(1.3, Math.max(0.5, avail / vp1.width));
          if (fit < scale - 0.01) { setScale(fit); return; } // re-renderiza com o novo zoom
        }
      }
      const vp = pageObj.getViewport({ scale, rotation: rotacao });
      const b = baseRef.current, o = overlayRef.current;
      if (!b || !o) return;
      b.width = o.width = Math.floor(vp.width);
      b.height = o.height = Math.floor(vp.height);
      await pageObj.render({ canvasContext: b.getContext("2d"), viewport: vp }).promise;
      drawOverlay();
      // centraliza no ponto do zoom (duplo clique/toque ou pinça)
      if (focal.current && mainRef.current) {
        const m = mainRef.current, f = focal.current;
        m.scrollLeft = f.x * scale - m.clientWidth / 2;
        m.scrollTop = f.y * scale - m.clientHeight / 2;
        focal.current = null;
      }
    })().catch((e) => {
      // juntar e remover descartam o documento e destroem o pdfDoc dele. Se isso pegar um
      // render no meio, o getPage/render rejeita — e é a falha de um trabalho que já não
      // interessa a ninguém. `alvo.solto` é o sinal confiável: o `cancelled` sozinho não
      // serve, porque ele só vira true quando o React confirma o render seguinte, e a
      // rejeição do destroy chega antes disso. Erro de verdade, no documento que está na
      // tela, continua subindo como antes.
      if (!cancelled && !alvo.solto) throw e;
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeId, page, scale, giroRev]);

  // ---- rascunho: gravação contínua ----
  // Toda mutação passa por tick() (que incrementa rev), então um efeito só cobre tudo.
  // `page` também é dep porque prevPage/nextPage/goToPage mudam d.page sem chamar tick().
  useEffect(() => {
    if (!persistir.current) return;
    const d = getActive();
    if (!d || !d.key || d.saved) return; // exportado não tem rascunho (ver doSaveOne)
    const st = autosave.current;
    const grava = () => { st.ultimo = Date.now(); salvarRascunho(d, page); };
    // teto: o cleanup abaixo cancela o timer a cada tick, então uma marcação contínua
    // adiaria a gravação para sempre. Com o teto, no máximo ~2s de trabalho ficam
    // sem checkpoint — que é o que de fato se perde numa queda de energia (não há
    // evento de fechamento nesse cenário).
    if (Date.now() - st.ultimo > 2000) { grava(); return; }
    clearTimeout(st.timer);
    st.timer = setTimeout(grava, 500);
    return () => clearTimeout(st.timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, activeId, page]);

  // ---- overlay ----
  const paint = (ctx, a) => {
    const s = scale;
    // strike (linha-guia) é renderizado como caixa DOM (ver LineBox), não no canvas
    if (a.type === "pen") {
      const pts = a.points || []; if (pts.length < 2) return;
      ctx.strokeStyle = a.color; ctx.lineWidth = a.thickness * s;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(pts[0].x * s, pts[0].y * s);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * s, pts[i].y * s);
      ctx.stroke();
    } else if (a.type === "highlight") {
      const x = Math.min(a.x1, a.x2) * s, y = Math.min(a.y1, a.y2) * s;
      const w = Math.abs(a.x2 - a.x1) * s, h = Math.abs(a.y2 - a.y1) * s;
      ctx.fillStyle = hexA(a.color || "#ffd600", 0.38); ctx.fillRect(x, y, w, h);
    } else if (a.type === "cover") {
      // só o preview do arrasto passa por aqui: o corretivo já criado vira caixa DOM
      // (CoverBox), para poder ser movido e redimensionado depois
      const x = Math.min(a.x1, a.x2) * s, y = Math.min(a.y1, a.y2) * s;
      const w = Math.abs(a.x2 - a.x1) * s, h = Math.abs(a.y2 - a.y1) * s;
      ctx.fillStyle = a.color || "#ffffff"; ctx.fillRect(x, y, w, h);
    } else if (a.type === "colsel") {
      // preview da glosa em coluna: a guia marca onde os "G" vão nascer e a faixa mostra
      // até onde a coluna desce. Nunca vira anotação — quem escreve é aplicarColunaGlosa.
      const y0 = Math.min(a.y1, a.y2) * s, y1 = Math.max(a.y1, a.y2) * s;
      const x = a.x1 * s;
      ctx.save();
      ctx.fillStyle = hexA(COR_ADM, 0.12); ctx.fillRect(x, y0, LARG_PREVIEW_G * s, y1 - y0);
      ctx.strokeStyle = COR_ADM; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.restore();
    } else if (a.type === "ocrsel") {
      // seleção da ferramenta "Copiar código": só preview, nunca vira anotação
      const x = Math.min(a.x1, a.x2) * s, y = Math.min(a.y1, a.y2) * s;
      const w = Math.abs(a.x2 - a.x1) * s, h = Math.abs(a.y2 - a.y1) * s;
      ctx.save();
      ctx.fillStyle = "rgba(31,111,235,.12)"; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#1f6feb"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
    // texto é renderizado como caixa DOM (ver TextBox), não no canvas
  };
  const drawOverlay = (preview) => {
    const o = overlayRef.current; if (!o) return;
    const ctx = o.getContext("2d"); ctx.clearRect(0, 0, o.width, o.height);
    const doc = getActive(); if (!doc) return;
    (doc.annotations[page] || []).forEach((a) => paint(ctx, a));
    if (preview) paint(ctx, preview);
  };

  // ---- conta-gotas do corretivo ----
  // Lê a cor do fundo da página no ponto, para o retângulo casar com a digitalização em vez
  // de sair um branco chapado sobre papel acinzentado. Mediana de 5×5, e não um pixel só:
  // um pixel isolado pode cair na borda de uma letra e devolver cinza escuro.
  const amostrarCor = (p) => {
    const b = baseRef.current;
    if (!b) return "#ffffff";
    try {
      const r = b.getBoundingClientRect();
      const k = r.width ? b.width / r.width : 1; // pixel do canvas por pixel de tela
      const n = 5, meio = (n - 1) / 2;
      const x0 = Math.max(0, Math.min(b.width - n, Math.round(p.x * scale * k) - meio));
      const y0 = Math.max(0, Math.min(b.height - n, Math.round(p.y * scale * k) - meio));
      const d = b.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, n, n).data;
      return corMediana(d);
    } catch { return "#ffffff"; } // página ainda não renderizada: branco resolve o caso comum
  };

  // ---- coordenadas ----
  const toDoc = (e) => {
    const r = overlayRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  // ---- zoom no ponto (duplo clique/toque) ----
  const zoomAt = (p) => {
    const m = mainRef.current, b = baseRef.current;
    if (!m || !b) return;
    let novo;
    if (scale < 2.99) novo = Math.min(3, scale * 1.5);
    else {
      // já no máximo: volta ao ajuste de largura
      const pageW = b.width / scale;
      novo = Math.min(1.3, Math.max(0.5, (m.clientWidth - 32) / pageW));
    }
    if (Math.abs(novo - scale) < 0.01) return;
    focal.current = p;
    setScale(novo);
  };
  const onDblClick = (e) => {
    if (tool === "text") return; // no modo texto o clique cria/edita caixas
    zoomAt(toDoc(e));
  };

  // ---- pinça (2 dedos) ----
  const pinchDist = () => {
    const pts = [...pointers.current.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
  };
  const pinchMid = () => {
    const pts = [...pointers.current.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  };

  // ---- desenho / navegação ----
  const onDown = (e) => {
    const doc = getActive(); if (!doc) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      // 2º dedo: vira pinça — cancela desenho/pan em andamento
      drawing.current = false; panning.current = null; drawOverlay();
      const mid = pinchMid();
      const r = overlayRef.current.getBoundingClientRect();
      pinch.current = {
        d0: pinchDist(), scale0: scale, k: 1,
        mid: { x: (mid.x - r.left) / scale, y: (mid.y - r.top) / scale },
      };
      return;
    }
    if (pinch.current) return; // ignora dedos extras durante a pinça
    const p = toDoc(e);
    // duplo toque → zoom no ponto (no mouse o dblclick nativo cuida disso)
    if (e.pointerType === "touch") {
      const t = Date.now(), lt = lastTap.current;
      lastTap.current = { t, x: e.clientX, y: e.clientY };
      if (lt && t - lt.t < 350 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 25) {
        lastTap.current = null;
        zoomAt(p);
        return;
      }
    }
    if (tool === "text") {
      if (editingId) return;   // já há uma caixa em edição: não cria outra (o blur finaliza)
      if (e.pointerType === "touch") {
        // mobile: flushSync + foco síncrono dentro do gesto → abre o teclado
        flushSync(() => addText(p));
        const inp = wrapRef.current && wrapRef.current.querySelector("input");
        if (inp) inp.focus();
      } else {
        // desktop: cria a caixa; o requestAnimationFrame do TextBox aplica o foco.
        // (foco síncrono aqui seria perdido pelo blur da ação padrão do mousedown)
        addText(p);
      }
      return;
    }
    if (tool === "check") {
      addSymbol(p); // marca ✓/✗; mantém a ferramenta ativa para marcar vários campos
      return;
    }
    setSelectedId(null);
    if (tool === "line") {
      addLine(p);   // linha horizontal de largura total na altura clicada
      return;
    }
    if (tool === "eraser") {
      // apaga o item sob o ponteiro; arrastar (drawing) apaga vários
      drawing.current = true;
      if (eraseAt(p)) { drawOverlay(); tick(); }
      return;
    }
    if (tool === "pen") {
      drawing.current = true; penPts.current = [p];
      return;
    }
    if (tool === "cover") {
      // a cor sai do ponto onde o arrasto começa — por isso o auditor deve começar num
      // pedaço limpo do fundo, ao lado do que vai cobrir
      corCover.current = amostrarCor(p);
      drawing.current = true; startPt.current = p;
      return;
    }
    if (tool !== "highlight" && tool !== "ocr" && tool !== "colglosa") {
      // modo neutro: arrastar para navegar pelo documento (mouse ou dedo)
      const m = mainRef.current; if (!m) return;
      panning.current = { x: e.clientX, y: e.clientY, sl: m.scrollLeft, st: m.scrollTop };
      return;
    }
    if (tool === "ocr") { setOcr(null); setOcrHold(false); } // nova leitura: fecha o anterior
    drawing.current = true; startPt.current = p;
  };
  const onMove = (e) => {
    if (pointers.current.has(e.pointerId))
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      // preview do zoom via CSS (sem re-renderizar o pdf.js a cada frame)
      const pc = pinch.current;
      let k = pinchDist() / pc.d0;
      k = Math.min(3 / pc.scale0, Math.max(0.5 / pc.scale0, k));
      pc.k = k;
      const w = wrapRef.current;
      if (w) {
        w.style.transformOrigin = `${pc.mid.x * pc.scale0}px ${pc.mid.y * pc.scale0}px`;
        w.style.transform = `scale(${k})`;
      }
      return;
    }
    if (panning.current) {
      const m = mainRef.current, pn = panning.current;
      if (m) {
        m.scrollLeft = pn.sl - (e.clientX - pn.x);
        m.scrollTop = pn.st - (e.clientY - pn.y);
      }
      return;
    }
    if (!drawing.current) return;
    const p = toDoc(e);
    if (tool === "eraser") {
      if (eraseAt(p)) { drawOverlay(); tick(); }
      return;
    }
    if (tool === "pen") {
      const pts = penPts.current; if (!pts) return;
      pts.push(p);
      drawOverlay({ type: "pen", points: pts, color, thickness });
      return;
    }
    const s = startPt.current;
    drawOverlay(
      tool === "colglosa" ? { type: "colsel", x1: s.x, y1: s.y, x2: p.x, y2: p.y }
      : tool === "ocr" ? { type: "ocrsel", x1: s.x, y1: s.y, x2: p.x, y2: p.y }
      : tool === "cover" ? { type: "cover", x1: s.x, y1: s.y, x2: p.x, y2: p.y, color: corCover.current }
      : { type: "highlight", x1: s.x, y1: s.y, x2: p.x, y2: p.y, color });
  };
  const onUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) {
        // fim da pinça: aplica o zoom de verdade (1 re-render nítido)
        const pc = pinch.current; pinch.current = null;
        const w = wrapRef.current;
        if (w) { w.style.transform = ""; w.style.transformOrigin = ""; }
        const novo = Math.min(3, Math.max(0.5, pc.scale0 * pc.k));
        if (Math.abs(novo - scale) > 0.01) { focal.current = pc.mid; setScale(novo); }
      }
      return;
    }
    if (panning.current) { panning.current = null; return; }
    if (!drawing.current) return;
    drawing.current = false;
    if (tool === "eraser") { drawOverlay(); return; } // já apagou no down/move
    const p = toDoc(e), s = startPt.current, doc = getActive();
    if (tool === "pen") {
      const pts = penPts.current; penPts.current = null;
      if (pts && pts.length > 1) {
        const ann = { type: "pen", points: pts, color, thickness };
        (doc.annotations[page] = doc.annotations[page] || []).push(ann);
        doc.saved = false; redo.current = []; tick();
        // riscou de vermelho na horizontal → provável corte de quantidade: pergunta o valor.
        // rabisco curto (marca solta, seta, círculo) não dispara.
        const xs = pts.map((q) => q.x);
        if (classeGlosa(color) === "tec" && Math.max(...xs) - Math.min(...xs) >= 8)
          lerGlosaTecnica(ann);
      }
      drawOverlay();
      return;
    }
    if (tool === "ocr") {
      const x = Math.min(s.x, p.x), y = Math.min(s.y, p.y);
      const w = Math.abs(p.x - s.x), h = Math.abs(p.y - s.y);
      drawOverlay();
      if (w >= 6 && h >= 6) readRegion({ x, y, w, h }); // ignora clique/arraste mínimo
      return;
    }
    if (tool === "colglosa") {
      // o x é o do INÍCIO do arrasto, não o menor: é a coluna onde o auditor quer os "G"
      const y0 = Math.min(s.y, p.y), y1 = Math.max(s.y, p.y);
      drawOverlay();
      if (y1 - y0 >= 12) abrirColunaGlosa(s.x, y0, y1 - y0); // clique solto não abre nada
      return;
    }
    if (tool === "cover") {
      const x = Math.min(s.x, p.x), y = Math.min(s.y, p.y);
      const w = Math.abs(p.x - s.x), h = Math.abs(p.y - s.y);
      drawOverlay(); // limpa o preview: daqui em diante quem desenha é a caixa DOM
      if (w >= 4 && h >= 4) {
        const id = "c" + ++textSeq.current;
        (doc.annotations[page] = doc.annotations[page] || []).push(
          { type: "cover", id, x, y, w, h, color: corCover.current || "#ffffff" });
        doc.saved = false; redo.current = []; setSelectedId(id); tick();
      }
      return;
    }
    if (Math.hypot(p.x - s.x, p.y - s.y) > 3) {
      (doc.annotations[page] = doc.annotations[page] || []).push(
        { type: "highlight", x1: s.x, y1: s.y, x2: p.x, y2: p.y, color });
      doc.saved = false; redo.current = []; tick();
    }
    drawOverlay();
  };
  // ---- leitura de código (OCR da área selecionada) ----
  // o tesseract.js é carregado sob demanda (import dinâmico) p/ não pesar o bundle inicial;
  // o worker fica em cache para as leituras seguintes saírem na hora.
  // OBS: o motor roda 100% no navegador (nenhum dado do PDF sai daqui), mas o wasm e o
  // dicionário vêm do CDN da própria lib na 1ª leitura. Para auto-hospedar, basta copiar os
  // arquivos p/ public/ e passar workerPath/corePath/langPath abaixo.
  const ocrWorker = useRef(null); // Promise<worker> — cachear a promise evita 2 workers
  const getOcrWorker = () => {
    if (!ocrWorker.current)
      ocrWorker.current = (async () => {
        const { createWorker } = await import("tesseract.js");
        return createWorker("por");
      })();
    return ocrWorker.current;
  };
  useEffect(() => () => {
    if (ocrWorker.current) ocrWorker.current.then((w) => w.terminate()).catch(() => {});
  }, []);
  // o balão some 2s depois de copiar; passar o mouse ou focar o campo pausa a contagem
  // (balão de erro/carregando fica até o usuário fechar — ele precisa ler a mensagem)
  useEffect(() => {
    if (!ocr || !ocr.copiado || ocrHold) return;
    const t = setTimeout(() => { setOcr(null); setOcrHold(false); }, 2000);
    return () => clearTimeout(t);
  }, [ocr && ocr.copiado, ocrHold]); // eslint-disable-line react-hooks/exhaustive-deps

  const copiar = async (txt) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(txt); return true;
      }
    } catch { /* cai no fallback abaixo */ }
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  };

  // percorre a árvore de blocos do tesseract até as palavras (com bbox em px do recorte)
  const ocrPalavras = (d) => {
    const out = [];
    for (const b of d.blocks || [])
      for (const p of b.paragraphs || [])
        for (const l of p.lines || [])
          for (const w of l.words || []) out.push(w);
    return out;
  };

  // mesma árvore, parando nas LINHAS: é delas que a glosa em coluna tira o y de cada item
  const ocrLinhas = (d) => {
    const out = [];
    for (const b of d.blocks || [])
      for (const p of b.paragraphs || [])
        for (const l of p.lines || []) out.push(l);
    return out;
  };

  // lê uma área da página e devolve { texto, palavras, linhas } — palavras e linhas trazem as
  // coordenadas em pontos do documento, que é o que permite saber qual coluna da tabela cada
  // número ocupa (glosa técnica) e onde fica cada item da lista (glosa em coluna).
  const lerRegiaoTexto = async (r, { escala = 6 } = {}) => {
    const doc = getActive(); if (!doc || !doc.pdfDoc) return null;
    const pageObj = await doc.pdfDoc.getPage(page);
    // Recorte em alta resolução: renderiza a página inteira deslocada, num canvas do
    // tamanho da área (as coords do app já são pontos do PDF — ver toDoc).
    // A margem extra é essencial: o tesseract erra muito quando o texto encosta na borda
    // do recorte (medido neste PDF: 12/20 sem margem → 18/20 com margem + filtro abaixo).
    const MG = 8;  // margem em pontos ao redor da seleção
    // resolução do recorte (S=6 saiu bem melhor que S=4 nos testes de código isolado).
    // A faixa da glosa em coluna é alta — a página inteira, às vezes — e a 6× viraria um canvas
    // de milhões de pixels que o tesseract levaria dezenas de segundos para varrer. Por isso a
    // escala é do chamador, e ainda assim fica limitada por um teto de área.
    const S = Math.max(1, Math.min(escala,
      Math.sqrt(16e6 / Math.max(1, (r.w + MG * 2) * (r.h + MG * 2)))));
    // mesma rotação do render principal: as coords da seleção estão no espaço da tela,
    // e sem isso o recorte lido pelo tesseract sairia de outro lugar da página
    const vp = pageObj.getViewport({ scale: S, rotation: pageObj.rotate + giroDaPagina(doc, page) });
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round((r.w + MG * 2) * S));
    cv.height = Math.max(1, Math.round((r.h + MG * 2) * S));
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    // renderiza o PDF original: as marcações do editor não entram e não atrapalham a leitura
    await pageObj.render({
      canvasContext: ctx, viewport: vp,
      transform: [1, 0, 0, 1, -(r.x - MG) * S, -(r.y - MG) * S],
    }).promise;
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(cv, {}, { blocks: true, text: true });
    // a margem entra na leitura mas não no resultado: fica só o que o usuário selecionou
    const X0 = MG * S, Y0 = MG * S, X1 = (MG + r.w) * S, Y1 = (MG + r.h) * S;
    const dentro = ocrPalavras(data).filter((p) => {
      const cx = (p.bbox.x0 + p.bbox.x1) / 2, cy = (p.bbox.y0 + p.bbox.y1) / 2;
      return cx >= X0 && cx <= X1 && cy >= Y0 && cy <= Y1;
    });
    const palavras = dentro.map((p) => ({
      text: p.text,
      x0: r.x - MG + p.bbox.x0 / S,   // de volta para pontos do documento
      x1: r.x - MG + p.bbox.x1 / S,
      y0: r.y - MG + p.bbox.y0 / S,
      y1: r.y - MG + p.bbox.y1 / S,
    }));
    const linhas = ocrLinhas(data)
      .filter((l) => {
        const cy = (l.bbox.y0 + l.bbox.y1) / 2, cx = (l.bbox.x0 + l.bbox.x1) / 2;
        return cx >= X0 && cx <= X1 && cy >= Y0 && cy <= Y1;
      })
      .map((l) => ({
        texto: String(l.text || "").trim(),
        y0: r.y - MG + l.bbox.y0 / S,
        y1: r.y - MG + l.bbox.y1 / S,
      }));
    const bruto = dentro.length ? dentro.map((p) => p.text).join(" ") : data.text || "";
    return { texto: bruto.replace(/\s+/g, " ").trim(), palavras, linhas };
  };

  const readRegion = async (r) => {
    const doc = getActive(); if (!doc || !doc.pdfDoc) return;
    const primeira = !ocrWorker.current;
    setOcr({ ...r, loading: true, primeira, text: "", err: "" });
    try {
      const lido = await lerRegiaoTexto(r);
      // código sai limpo; descrição sai como foi lida (ver limparLeitura)
      const saida = limparLeitura(lido && lido.texto);
      if (!saida) {
        setOcr((o) => (o ? { ...o, loading: false, err: "Não consegui ler essa área — tente selecionar mais perto do código." } : o));
        return;
      }
      const ok = await copiar(saida);
      setOcr((o) => (o ? { ...o, loading: false, text: saida, copiado: ok } : o));
    } catch {
      setOcr((o) => (o ? { ...o, loading: false, err: "Falha ao ler a área. Tente de novo." } : o));
    }
  };

  // ---- glosa técnica: o auditor risca a QUANTIDADE; o valor sai de qtd × Vl Unitário ----
  // o traço cobre a célula Qtde e o Vl Unitário fica à direita, fora dele — por isso a
  // leitura pega a faixa da linha inteira, não a caixa do traço.
  const lerGlosaTecnica = async (ann) => {
    const pts = ann.points || [];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const faixa = { x: Math.max(0, x0 - 10), y: Math.max(0, cy - 7), w: (x1 - x0) + 130, h: 14 };
    const primeira = !ocrWorker.current;
    setGlosaTec({ ann, ...faixa, loading: true, primeira, qtd: "", unit: "", err: "" });
    try {
      const lido = await lerRegiaoTexto(faixa);
      const palavras = (lido && lido.palavras) || [];
      // qtde: inteiro sob o traço | unitário: 1º valor monetário à direita do fim do traço
      const sob = palavras.find((p) => /^\d{1,4}$/.test(p.text) && p.x1 >= x0 - 4 && p.x0 <= x1 + 4);
      const unit = palavras.find((p) => RE_MOEDA.test(p.text) && p.x0 >= x1 - 6);
      setGlosaTec((g) => (g && g.ann === ann ? {
        ...g, loading: false,
        qtd: sob ? sob.text : "1",
        unit: unit ? unit.text : "",
      } : g));
    } catch {
      setGlosaTec((g) => (g && g.ann === ann
        ? { ...g, loading: false, qtd: "1", unit: "", err: "Não consegui ler a linha — preencha à mão." }
        : g));
    }
  };
  // confirma a glosa gravando o valor na própria anotação: assim borracha e Ctrl+Z
  // levam o traço e o valor juntos, e o buildPdf ignora esses campos ao exportar.
  const confirmarGlosaTec = () => {
    const g = glosaTec; if (!g) return;
    const qtd = numeroBR(g.qtd), unit = numeroBR(g.unit);
    if (!(qtd > 0) || !(unit > 0)) return;
    g.ann.glosaQtd = qtd; g.ann.glosaUnit = unit;
    g.ann.glosa = Math.round(qtd * unit * 100) / 100;
    const d = getActive(); if (d) d.saved = false;
    setGlosaTec(null); tick();
  };

  // ---- glosa em coluna: um "G <valor>" ao lado de cada linha da faixa arrastada ----
  // O caso que motivou isto: uma conta com 30 linhas iguais do mesmo exame, todas com a mesma
  // glosa. Uma a uma, é caixa de texto + digitação + posicionamento 30 vezes.
  //
  // As linhas vêm do OCR da tabela AO LADO da coluna (o lugar onde os "G" nascem está vazio,
  // não há o que ler ali). Se a contagem sair errada, o auditor corrige no balão e o app
  // distribui as caixas por igual dentro da faixa que ele arrastou — o arrasto é a verdade
  // sobre onde a coluna começa e termina; o OCR só afina o alinhamento linha a linha.
  const mediana = (l) => {
    if (!l.length) return 0;
    const o = [...l].sort((a, b) => a - b), m = o.length >> 1;
    return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
  };
  // valor sugerido: o da última coluna feita nesta sessão; na primeira, a última glosa
  // administrativa do documento — que é justamente a que o auditor viria copiando à mão.
  const valorSugerido = () => {
    if (ultimoValorCol.current) return ultimoValorCol.current;
    const ultima = glosas.adm[glosas.adm.length - 1];
    return ultima ? moeda(ultima.valor) : "";
  };
  const abrirColunaGlosa = async (x, y, h) => {
    const doc = getActive(); if (!doc || !doc.pdfDoc) return;
    // a tabela fica à esquerda da coluna de glosas; só quando ela nasce colada na margem
    // é que o texto a ser contado está do outro lado
    const faixa = x < 60
      ? { x, y: y - 2, w: LARG_LEITURA_G, h: h + 4 }
      : { x: Math.max(0, x - LARG_LEITURA_G), y: y - 2, w: Math.min(LARG_LEITURA_G, x), h: h + 4 };
    const primeira = !ocrWorker.current;
    const base = { x, y, h, valor: valorSugerido(), linhas: [], qtd: "",
      tamanho: String(tamanhoAtual), err: "" };
    setColGlosa({ ...base, loading: true, primeira });
    const semLeitura = (err) =>
      setColGlosa((g) => (g && g.loading ? { ...g, loading: false, err } : g));
    try {
      // escala baixa de propósito: aqui interessa ONDE estão as linhas, não ler os glifos
      const lido = await lerRegiaoTexto(faixa, { escala: 3 });
      let linhas = ((lido && lido.linhas) || [])
        .filter((l) => /[0-9A-Za-zÀ-ÿ]/.test(l.texto))
        .sort((a, b) => a.y0 - b.y0);
      // altura fora de escala é ruído do OCR (duas linhas grudadas, borda do recorte)
      const med = mediana(linhas.map((l) => l.y1 - l.y0));
      if (med > 0) linhas = linhas.filter((l) => {
        const alt = l.y1 - l.y0;
        return alt >= med * 0.4 && alt <= med * 2.5;
      });
      if (linhas.length < 2) {
        semLeitura("Não consegui contar as linhas — informe quantas são.");
        return;
      }
      // corpo sugerido pelo espaçamento das linhas lidas. O teto aqui é 14, e não o tetoFonte
      // (~22) das alças: acima disso um "G 10,56" não cabe na linha de uma tabela — foi assim
      // que colunas saíram com a fonte gigante.
      const centros = linhas.map((l) => (l.y0 + l.y1) / 2);
      const passo = mediana(centros.slice(1).map((c, i) => c - centros[i]));
      const tam = passo > 0 ? Math.max(6, Math.min(14, Math.round(passo * 0.8))) : tamanhoAtual;
      setColGlosa((g) => (g && g.loading
        ? { ...g, loading: false, linhas, qtd: String(linhas.length), tamanho: String(tam) } : g));
    } catch {
      semLeitura("Falha ao ler a área — informe quantas linhas são.");
    }
  };
  const aplicarColunaGlosa = () => {
    const g = colGlosa; if (!g) return;
    const v = numeroBR(g.valor);
    const n = Math.floor(numeroBR(g.qtd));
    if (!(v > 0) || !(n >= 1)) return;
    const doc = getActive(); if (!doc) return;
    // Onde cada caixa nasce, em ordem de preferência:
    //  • a contagem bate com a leitura → centro de cada linha lida (alinhamento perfeito);
    //  • o auditor pediu MENOS que o lido → as n primeiras linhas. O caso comum é o arrasto
    //    ter passado um pouco do último item e pego uma linha a mais lá embaixo;
    //  • pediu MAIS → o OCR perdeu linhas: aí a verdade é o arrasto, dividido em n faixas iguais.
    const lidos = g.linhas.map((l) => (l.y0 + l.y1) / 2);
    const centros = n <= lidos.length && lidos.length
      ? lidos.slice(0, n)
      : Array.from({ length: n }, (_, i) => g.y + (i + 0.5) * (g.h / n));
    // o corpo é o do campo Tamanho do balão (que já nasce sugerido pelo espaçamento das linhas)
    const size = Math.max(6, Math.min(tetoFonte, Math.floor(numeroBR(g.tamanho)) || tamanhoAtual));
    const text = `G ${moeda(v)}`;      // formato que o RE_GLOSA reconhece e a calculadora soma
    const grupo = "gc" + ++grupoSeq.current; // marca o lote: o desfazer leva a coluna inteira
    const lista = (doc.annotations[page] = doc.annotations[page] || []);
    let primeiro = null;
    for (const c of centros) {
      const id = "t" + ++textSeq.current;
      if (!primeiro) primeiro = id;
      lista.push({
        type: "text", id, grupo,
        x: Math.max(0, g.x), y: Math.max(0, c - size * 0.7), // ~centro visual da linha
        text, size, color: COR_ADM, w: 120, h: 24,           // sempre azul: é administrativa
      });
    }
    ultimoValorCol.current = g.valor;
    setFonte(size); // o corpo escolhido aqui vale para a próxima coluna e para o texto avulso
    doc.saved = false; redo.current = [];
    setColGlosa(null); setTool("select"); setSelectedId(primeiro); tick();
  };

  // ---- linha-guia horizontal (1 clique atravessa a largura da página) ----
  const addLine = (p) => {
    const doc = getActive(); if (!doc) return;
    const larguraDoc = baseRef.current ? baseRef.current.width / scale : 1000;
    const id = "l" + ++textSeq.current;
    (doc.annotations[page] = doc.annotations[page] || []).push(
      { type: "strike", id, x1: 0, y1: p.y, x2: larguraDoc, y2: p.y, color, thickness });
    doc.saved = false; redo.current = []; setSelectedId(id); tick();
  };
  // move a linha-guia só na vertical (mantém a largura total)
  const moveLine = (id, y) => {
    const a = findText(id); if (!a) return;
    a.y1 = a.y2 = y; getActive().saved = false; tick();
  };

  // ---- marca de verificado ✓/✗ (símbolo vetorial, movível) ----
  const addSymbol = (p) => {
    const doc = getActive(); if (!doc) return;
    const size = Math.max(14, Math.round(22 / scale));
    const id = "y" + ++textSeq.current;
    (doc.annotations[page] = doc.annotations[page] || []).push(
      // x/y são o canto superior esquerdo: recua meio tamanho p/ centralizar no ponto clicado
      { type: "symbol", id, symbol: checkSymbol,
        x: Math.max(0, p.x - size / 2), y: Math.max(0, p.y - size / 2), size, color });
    doc.saved = false; redo.current = [];
    setSelectedId(id); tick();
  };

  // ---- caixas de texto (estilo Canva) ----
  const findText = (id) => {
    const d = getActive(); if (!d) return null;
    return (d.annotations[page] || []).find((a) => a.id === id) || null;
  };
  const addText = (p) => {
    const doc = getActive(); if (!doc) return;
    const id = "t" + ++textSeq.current;
    const size = tamanhoAtual; // corpo escolhido na toolbar (Tamanho)
    (doc.annotations[page] = doc.annotations[page] || []).push({
      type: "text", id, x: p.x, y: p.y, text: "", size, color, w: 120, h: 24,
    });
    doc.saved = false; editOrig.current = ""; redo.current = [];
    setSelectedId(id); setEditingId(id); tick();
  };
  // seleciona ferramenta; clicar de novo na ativa desmarca (modo neutro = navegar).
  // O filtro por papel passa por aqui e só por aqui — botão, tecla e código novo entram
  // todos por esta porta, então não há como ligar uma ferramenta que o auditor não vê.
  const selectTool = (id) => {
    if (!ferramentas.some((f) => f.id === id)) return;
    setTool(tool === id ? "select" : id);
    setSelectedId(null);
    setOcr(null); setOcrHold(false);
  };
  const updateText = (id, text) => {
    const a = findText(id); if (!a) return;
    a.text = text; getActive().saved = false; tick();
  };
  const moveText = (id, x, y) => {
    const a = findText(id); if (!a) return;
    a.x = x; a.y = y; getActive().saved = false; tick();
  };
  // Redimensionar uma caixa nascida de uma coluna redimensiona a coluna toda: corpos diferentes
  // numa mesma coluna são defeito, não intenção. Vale para a alça do TextBox e para o controle
  // de Tamanho da toolbar — os dois entram por aqui.
  const resizeText = (id, size) => {
    const doc = getActive(); const a = findText(id); if (!doc || !a) return;
    const alvos = a.grupo ? (doc.annotations[page] || []).filter((x) => x.grupo === a.grupo) : [a];
    for (const t of alvos) {
      // a coluna nasce centrada na linha do item (y = centro - size*0.7): manter esse centro ao
      // trocar de corpo, senão diminuir a fonte desce a coluna inteira em relação às linhas
      if (t.grupo) t.y = Math.max(0, t.y + (t.size - size) * 0.7);
      t.size = size;
    }
    doc.saved = false; tick();
  };
  // ---- tamanho do texto: vale para o item selecionado e para o próximo a ser inserido ----
  // (declarado depois de findText/resizeText porque lê os dois)
  const selText = (() => {
    const a = findText(selectedId);
    return a && (a.type === "text" || a.type === "symbol") ? a : null;
  })();
  const tamanhoAtual = Math.max(6, Math.min(tetoFonte, Math.round(selText ? selText.size : fonte)));
  const aplicarTamanho = (n) => {
    setFonte(n);
    if (selText) resizeText(selText.id, n); // com uma caixa de coluna selecionada, muda todas
  };
  // setas do teclado: desloca o item selecionado; devolve true se consumiu a tecla
  const nudgeSelected = (dx, dy) => {
    const a = findText(selectedId); if (!a) return false;
    if (a.type === "strike") {          // linha-guia: só se move na vertical
      if (dy) moveLine(a.id, Math.max(0, a.y1 + dy));
      return true;                      // ←/→ não trocam de página com a linha selecionada
    }
    moveText(a.id, Math.max(0, a.x + dx), Math.max(0, a.y + dy));
    return true;
  };
  const measureText = (id, w, h) => {
    const a = findText(id); if (!a) return;
    if (Math.abs((a.w || 0) - w) > 0.5 || Math.abs((a.h || 0) - h) > 0.5) {
      a.w = w; a.h = h;
    }
  };
  const deleteText = (id) => {
    const d = getActive(); if (!d) return;
    d.annotations[page] = (d.annotations[page] || []).filter((a) => a.id !== id);
    d.saved = false;
    setEditingId(null); setSelectedId(null); tick();
  };
  const endEditText = (id) => {
    const a = findText(id);
    if (a && !a.text.trim()) { deleteText(id); setTool("select"); return; }
    setEditingId(null);
    setTool("select"); // desmarca a ferramenta Texto após inserir
  };
  // inicia edição guardando o texto original (para permitir desistir/reverter)
  const startEditText = (id) => {
    const a = findText(id);
    editOrig.current = a ? a.text : "";
    setSelectedId(id); setEditingId(id);
  };
  // desistir de escrever: reverte ao texto original; se ficar vazio, remove a caixa
  const cancelText = (id) => {
    const a = findText(id);
    if (a) a.text = editOrig.current;
    if (!a || !a.text.trim()) { deleteText(id); setTool("select"); return; }
    getActive().saved = false;
    setEditingId(null); setTool("select"); tick();
  };
  // ---- fechamento da conta (as 4 linhas que o analista escreve no fim) ----
  const setTotalConta = (txt) => {
    const doc = getActive(); if (!doc) return;
    doc.totalConta = txt; doc.saved = false; tick();
  };
  // tira um item da conta sem apagar a marcação do PDF (correção de leitura errada do OCR)
  // × da lista de itens da calculadora.
  //
  // Marcação desta sessão: apaga a marcação junto. Antes daqui, o código só limpava
  // glosa/glosaQtd/glosaUnit — campos que existem na glosa técnica e não na administrativa,
  // então remover um "G 1,00" simplesmente não funcionava: o valor é lido do texto da caixa e
  // voltava para a conta no recálculo seguinte. E deixar o "G 1,00" escrito na página sem
  // entrar na conta seria pior que não remover: o PDF entregue mostraria uma glosa que o
  // fechamento não tem.
  //
  // Glosa herdada: só sai da conta. Naquele arquivo a marcação foi achatada na exportação —
  // virou tinta na página e não existe mais como objeto que dê para apagar.
  const removerGlosa = (item) => {
    const doc = getActive(); if (!doc) return;
    if (!item.ann) {
      if (doc.herdado) {
        const alvo = item.tipo === "adm" ? "adm" : "tec";
        const lista = doc.herdado[alvo] || [];
        const i = lista.findIndex((h) => h.p === item.pagina && h.v === item.valor);
        if (i >= 0) lista.splice(i, 1);
      }
      doc.saved = false; tick();
      return;
    }
    const oQue = item.tipo === "adm"
      ? `a glosa de R$ ${moeda(item.valor)}`
      : `o traço da glosa técnica de R$ ${moeda(item.valor)}`;
    // confirma porque apaga da página e o Ctrl+Z não alcança: ele desfaz a última marcação
    // da página, não uma escolhida no meio da lista
    showConfirm("Apagar glosa",
      `Apagar ${oQue} da página ${item.pagina}? A marcação sai do documento.`,
      () => {
        const lista = doc.annotations[item.pagina] || [];
        doc.annotations[item.pagina] = lista.filter((a) => a !== item.ann);
        doc.saved = false;
        setSelectedId(null); drawOverlay(); tick();
      }, { confirmText: "Apagar" });
  };
  const inserirResumo = () => {
    const doc = getActive(); if (!doc) return;
    const linhas = [
      `Glosa Técnica: R$ ${moeda(glosas.totalTec)}`,
      `Glosa Administrativa: R$ ${moeda(glosas.totalAdm)}`,
      `Valor Glosado: R$ ${moeda(glosas.totalGlosado)}`,
    ];
    if (glosas.valorApurado != null)
      linhas.push(`Valor Apurado: R$ ${moeda(glosas.valorApurado)}`);
    // mesmo tamanho de fonte do texto avulso; nasce onde o analista está olhando
    const size = tamanhoAtual;
    const m = mainRef.current;
    const x = m ? (m.scrollLeft + 40) / scale : 40;
    const y = m ? (m.scrollTop + 40) / scale : 40;
    const lista = (doc.annotations[page] = doc.annotations[page] || []);
    let primeiro = null;
    linhas.forEach((text, i) => {
      const id = "t" + ++textSeq.current;
      if (!primeiro) primeiro = id;
      lista.push({
        type: "text", id, x: Math.max(0, x), y: Math.max(0, y + i * size * 1.6),
        text, size, color: COR_ADM, w: 120, h: 24,
      });
    });
    doc.saved = false; redo.current = [];
    setTool("select"); setSelectedId(primeiro); tick();
  };

  // duplica qualquer anotação já inserida (texto ou carimbo)
  const duplicateAnn = (id) => {
    const doc = getActive(); const a = findText(id);
    if (!doc || !a) return;
    const prefix = a.type === "stamp" ? "s" : "t";
    const novo = { ...a, id: prefix + ++textSeq.current, x: a.x + 15, y: a.y + 15 };
    (doc.annotations[page] = doc.annotations[page] || []).push(novo);
    doc.saved = false; redo.current = [];
    setSelectedId(novo.id); tick();
  };

  // ---- carimbos ----
  // baixa do bucket na entrada; some da memória quando o auditor sai (a remontagem por
  // key={usuario.id} no portão garante que não sobra carimbo do anterior)
  useEffect(() => {
    let vivo = true;
    limparCarimbosAntigos();
    (async () => {
      if (!carimbaDoc) { if (vivo) setCarimboOcupado(false); return; }
      const { url, erro } = await lerCarimbo(usuario.id);
      if (vivo) { setCarimbo(url || null); setCarimboErro(erro || ""); setCarimboOcupado(false); }
    })();
    return () => { vivo = false; };
  }, [usuario.id, carimbaDoc]);

  const addStamp = (stamp, ratio) => {
    const doc = getActive(); if (!doc) return;
    const m = mainRef.current;
    const w = 150, h = w * (ratio || 0.4);
    // centro da área visível, em coords do documento
    const x = m ? (m.scrollLeft + m.clientWidth / 2) / scale - w / 2 : 40;
    const y = m ? (m.scrollTop + m.clientHeight / 2) / scale - h / 2 : 40;
    const id = "s" + ++textSeq.current;
    (doc.annotations[page] = doc.annotations[page] || []).push({
      type: "stamp", id, x: Math.max(0, x), y: Math.max(0, y), w, h, url: stamp.url,
    });
    doc.saved = false; redo.current = [];
    setSelectedId(id); setStampsOpen(false); setTool("select"); tick();
  };
  const resizeStamp = (id, w, h) => {
    const a = findText(id); if (!a) return;
    a.w = w; a.h = h; getActive().saved = false; tick();
  };
  // envia (ou substitui) o carimbo do auditor no bucket
  const enviarCarimbo = async (file) => {
    setCarimboOcupado(true);
    const { url, erro } = await salvarCarimbo(usuario.id, file);
    setCarimboOcupado(false);
    if (erro) { setCarimboErro(erro); return showAlert("Não foi possível enviar", erro); }
    setCarimboErro(""); setCarimbo(url || null);
  };
  const removerCarimbo = () => {
    showConfirm("Remover carimbo",
      "O seu carimbo sai do servidor e você precisará enviá-lo de novo para assinar.",
      async () => {
        setCarimboOcupado(true);
        const { erro } = await apagarCarimbo(usuario.id);
        setCarimboOcupado(false);
        if (erro) { setCarimboErro(erro); return showAlert("Não foi possível remover", erro); }
        setCarimboErro(""); setCarimbo(null);
      }, { confirmText: "Remover" });
  };

  // ---- rascunho: retomada da sessão ----
  // Só uma aba pode ser dona do rascunho. Sem isso, duas abas abertas escreveriam nos
  // mesmos registros e a última gravação apagaria as marcações da outra — em silêncio,
  // que é o pior modo de falha possível aqui.
  const canal = useRef(null);
  // fecha o canal e solta o listener. Chamado no pagehide E na desmontagem: sem a segunda
  // parte, um editor desmontado (troca de auditor, sessão caída) continuava respondendo
  // "ocupado" para a instância seguinte, que subia com persistir=false — autosave desligado
  // em silêncio, justo em quem acabou de levar um susto.
  const fecharCanal = useRef(() => {});
  const reivindicarAba = () => new Promise((resolve) => {
    let livre = true;
    try {
      if (!globalThis.BroadcastChannel) return resolve(true); // sem suporte: segue sozinho
      // canal por auditor: duas abas do MESMO auditor brigam pelo rascunho, de auditores
      // diferentes não — os registros de cada um são separados
      const ch = new BroadcastChannel("editor-auditoria:" + usuario.id);
      canal.current = ch;
      ch.onmessage = (e) => {
        const m = e.data || {};
        if (m.tipo === "ocupado") livre = false;
        // já sou a dona: aviso a recém-chegada para ela não gravar por cima
        else if (m.tipo === "ola" && persistir.current) ch.postMessage({ tipo: "ocupado" });
      };
      ch.postMessage({ tipo: "ola" });
      setTimeout(() => resolve(livre), 250);
      const aoSair = () => { try { ch.close(); } catch { /* já fechado */ } };
      window.addEventListener("pagehide", aoSair);
      fecharCanal.current = () => {
        window.removeEventListener("pagehide", aoSair);
        persistir.current = false; // não grava mais nada depois de largar o canal
        aoSair();
        canal.current = null;
        fecharCanal.current = () => {};
      };
    } catch { resolve(true); }
  });

  // remonta um documento a partir do registro gravado
  const docDoRegistro = async (reg, cacheImg) => {
    const blob = reg.semBinario ? null : await rascunho.lerPdf(reg.key);
    if (!blob) return null; // sem o PDF não há o que restaurar
    const bytes = await blob.arrayBuffer();
    return {
      id: ++seq.current, key: reg.key, name: reg.nome, bytes, pdfDoc: null,
      numPages: reg.numPages || 0, page: reg.page || 1,
      annotations: await restaurarAnns(reg.annotations, cacheImg),
      rotacoes: reg.rotacoes || {}, // registro gravado antes deste recurso: sem giro nenhum
      saved: false, // se há rascunho, é porque não foi exportado
      totalConta: reg.totalConta || "",
      herdado: reg.herdado || null,
      keywordsOriginais: reg.keywordsOriginais || "",
      metaLida: !!reg.metaLida, // não relê as Keywords: doc.herdado já está do jeito certo
      ordem: reg.ordem || 0,
      semBinario: false,
      binarioGravado: true, // veio da base: o arquivo já está lá
    };
  };

  const restaurar = async (regs) => {
    const cache = new Map();
    const cacheImg = async (h) => {
      if (cache.has(h)) return cache.get(h);
      const b = await rascunho.lerImagem(h);
      const url = b ? await blobParaDataUrl(b) : null;
      if (url) imgsGravadas.current.add(h); // já está no banco: não regravar depois
      cache.set(h, url);
      return url;
    };
    const docs = [];
    for (const reg of regs) {
      try { const d = await docDoRegistro(reg, cacheImg); if (d) docs.push(d); }
      catch { /* registro corrompido: descarta esse, mantém os outros */ }
    }
    if (!docs.length) { showAlert("Nada a restaurar", "Os arquivos do rascunho não puderam ser lidos."); return; }
    // os ids das anotações vêm de textSeq, que reinicia em 0 a cada recarga: sem
    // recalcular, uma anotação nova nasceria com id repetido e a seleção/borracha
    // passariam a agir na marcação errada.
    let maior = 0;
    for (const d of docs)
      for (const lista of Object.values(d.annotations))
        for (const a of lista) {
          // o "c" do corretivo estava de fora, e o id dele saía repetido depois de
          // restaurar. Passava batido enquanto cada documento vivia sozinho; juntar dois
          // põe os dois corretivos na mesma fila, e aí a seleção pega o errado.
          const m = /^[ctsyl](\d+)$/.exec(a.id || "");
          if (m) maior = Math.max(maior, +m[1]);
        }
    textSeq.current = Math.max(textSeq.current, maior);
    ordemSeq.current = Math.max(ordemSeq.current, ...docs.map((d) => d.ordem || 0));
    // concatena em vez de trocar: entre o prompt aparecer e o auditor responder ele
    // pode ter aberto um arquivo, e essa fila não pode ser descartada.
    // Muta antes de apontar o activeId — o efeito de render sai calado se getActive()
    // não achar o documento, e não reagenda.
    const jaAbertos = store.current.docs;
    store.current.docs = [...jaAbertos, ...docs];
    if (!jaAbertos.length) { setActiveId(docs[0].id); setPage(docs[0].page || 1); }
    tick();
  };

  useEffect(() => {
    montagens.current++;
    if (bootFeito.current) return; // <StrictMode> monta 2× em dev
    bootFeito.current = true;
    (async () => {
      rascunho.aoFalhar(() => {
        if (avisouFalha.current) return;
        avisouFalha.current = true;
        persistir.current = false;
        showAlert("Rascunho automático indisponível",
          "Não foi possível gravar a recuperação neste navegador (espaço cheio ou janela anônima). O editor funciona normalmente — lembre de baixar o PDF auditado ao terminar.");
      });
      if (!await rascunho.iniciar()) return;       // sem IndexedDB: segue sem rascunho
      if (!await reivindicarAba()) {
        showAlert("Outra aba do Editor está aberta",
          "A recuperação automática ficou ativa apenas na primeira aba, para as duas não gravarem uma por cima da outra.");
        return;
      }
      persistir.current = true;
      // arquivos abertos enquanto o boot corria ainda não foram gravados
      for (const d of store.current.docs) salvarRascunho(d, d.page);

      let regs = await rascunho.listarSessoes();
      // teto de segurança: quem nunca exporta acumularia rascunho para sempre.
      // A purga é por idade, então varre os registros de todo mundo mesmo.
      const limite = Date.now() - 30 * 24 * 3600 * 1000;
      const velhos = regs.filter((r) => (r.atualizadoEm || 0) < limite);
      for (const r of velhos) rascunho.apagarDoc(r.key);
      regs = regs.filter((r) => (r.atualizadoEm || 0) >= limite);
      // a coleta de lixo precisa dos hashes de TODOS os registros: filtrar por dono aqui
      // apagaria as imagens de carimbo que estão nos rascunhos dos outros auditores
      rascunho.coletarLixo(hashesDosRegistros(regs));
      // sem o PDF guardado não há como remontar o documento — não entra na contagem
      regs = regs.filter((r) => !r.semBinario);
      // só o que é meu. Registro sem dono, ou com dono em formato antigo (era o id da lista
      // no bundle, hoje é o uuid do Supabase), é anterior a esta versão: fica para quem
      // entrar primeiro neste navegador, e ao restaurar já sai regravado no nome dele.
      regs = regs.filter((r) => r.dono === usuario.id || !ehUuid(r.dono));
      if (!regs.length) return;
      // o auditor já começou a trabalhar enquanto o boot corria: não interrompe com o
      // prompt nem troca a fila por baixo dele. O rascunho antigo continua guardado e
      // volta a ser oferecido na próxima abertura.
      if (store.current.docs.length) return;

      regs.sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
      ordemSeq.current = Math.max(0, ...regs.map((r) => r.ordem || 0));
      const marcas = regs.reduce(
        (s, r) => s + Object.values(r.annotations || {}).reduce((n, l) => n + (l ? l.length : 0), 0), 0);
      const quando = new Date(Math.max(...regs.map((r) => r.atualizadoEm || 0)))
        .toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const plural = (n, um, muitos) => `${n} ${n === 1 ? um : muitos}`;
      const oQue = plural(regs.length, "documento", "documentos")
        + (marcas ? ` com ${plural(marcas, "marcação", "marcações")}` : " ainda sem marcação");
      showConfirm(
        "Retomar de onde parou?",
        `Encontramos ${oQue} da sessão de ${quando}. Quer continuar esse trabalho?`,
        () => { restaurar(regs); },
        {
          confirmText: "Restaurar",
          cancelText: "Começar do zero",
          // apaga documento por documento: limparTudo() zeraria as stores inteiras e
          // levaria junto o rascunho dos outros auditores desta máquina
          onCancel: () => {
            imgsGravadas.current.clear();
            for (const r of regs) rascunho.apagarDoc(r.key);
          },
          semBackdrop: true, // um clique fora não pode descartar o trabalho
        });
    })();
    // Largar o canal na desmontagem, mas SÓ numa desmontagem de verdade: em dev o
    // <StrictMode> desmonta e remonta na sequência, e o boot não roda de novo (bootFeito),
    // então fechar aqui deixaria o editor sem autosave a manhã inteira. A remontagem
    // incrementa o contador antes deste timeout rodar; a saída para valer, não.
    return () => {
      const meu = montagens.current;
      setTimeout(() => { if (montagens.current === meu) fecharCanal.current(); }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // avisa que há trabalho ainda não exportado (o rascunho é rede de segurança, não
  // substitui o PDF auditado). Também cobre a janela de segundos do autosave.
  useEffect(() => {
    const h = (e) => {
      const pendente = store.current.docs.some(
        (d) => !d.saved && Object.values(d.annotations).some((l) => l.length));
      if (pendente) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  // no mobile o beforeunload não dispara de forma confiável; visibilitychange sim
  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== "hidden") return;
      const d = getActive();
      if (d && !d.saved) { clearTimeout(autosave.current.timer); salvarRascunho(d, page); }
    };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, page]);

  // ---- ações ----
  const addFiles = async (fileList) => {
    const arr = [...fileList].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    for (const f of arr) {
      const bytes = await f.arrayBuffer();
      const doc = {
        id: ++seq.current, name: f.name, bytes, pdfDoc: null,
        numPages: 0, page: 1, annotations: {}, saved: false,
        rotacoes: {},          // página → giro em graus, RELATIVO ao /Rotate que ela já tem
        totalConta: "",        // preenchido na calculadora (ou herdado do PDF)
        herdado: null,         // glosas da etapa anterior, lidas dos metadados
        keywordsOriginais: "", // keywords que o PDF já trazia — preservadas ao exportar
        // ---- rascunho ----
        key: rascunho.novaChave(), // id estável (o `id` acima reinicia a cada recarga)
        ordem: ++ordemSeq.current,
        metaLida: false,           // ver o efeito de render: só lê os metadados uma vez
        semBinario: false,         // true quando o PDF é grande demais para o rascunho
        binarioGravado: false,     // o PDF ainda não foi para o rascunho
      };
      store.current.docs.push(doc);
      // sem await: 50 PDFs não podem esperar a fila do IndexedDB para aparecer na tela.
      // new Blob([bytes]) lá dentro copia — o doc.bytes original segue intacto para o
      // PDFDocument.load da exportação.
      salvarRascunho(doc, doc.page);
    }
    tick();
    if (!activeId && store.current.docs.length) { setActiveId(store.current.docs[0].id); setPage(1); }
  };
  const selectDoc = (id) => {
    const old = getActive(); if (old) old.page = page;
    // grava o documento que está saindo: trocar activeId descarta o timer pendente
    // do autosave, e as últimas marcações dele se perderiam.
    if (old && !old.saved) { clearTimeout(autosave.current.timer); salvarRascunho(old, page); }
    const d = store.current.docs.find((x) => x.id === id);
    setActiveId(id); setPage(d.page || 1);
    setSidebarOpen(false); // fecha a gaveta no mobile
  };
  const removeDoc = (id) => {
    const docs = store.current.docs;
    const d = docs.find((x) => x.id === id); if (!d) return;
    const doRemove = () => {
      const list = store.current.docs;
      const idx = list.findIndex((x) => x.id === id);
      store.current.docs = list.filter((x) => x.id !== id);
      if (d.key) rascunho.apagarDoc(d.key); // sai da fila, sai do rascunho
      soltarDoc(d);
      desmarcar([id]);
      if (id === activeId) {
        const rest = store.current.docs;
        const next = rest[idx] || rest[idx - 1] || null;
        setActiveId(next ? next.id : null);
        setPage(next ? next.page || 1 : 1);
      }
      tick();
    };
    const temMarcas = !d.saved && Object.values(d.annotations).some((l) => l.length);
    if (temMarcas)
      showConfirm("Remover documento", `Remover "${d.name}"? As marcações não salvas serão perdidas.`, doRemove, { confirmText: "Remover" });
    else doRemove();
  };

  // ---- reordenar a fila arrastando ----
  // A fila em memória é a ordem do array; o campo `ordem` é o que reconstrói essa ordem depois
  // de um F5. Mexer num sem o outro dá uma fila que se desfaz sozinha na próxima abertura.
  const reordenarFila = (ids) => {
    const antes = store.current.docs;
    const nova = ids.map((id) => antes.find((d) => d.id === id)).filter(Boolean);
    if (nova.length !== antes.length) return; // fila mudou no meio do gesto: não arrisca
    store.current.docs = nova;
    nova.forEach((d, i) => {
      const ordem = i + 1;
      if (d.ordem === ordem) return;
      d.ordem = ordem;
      // documento já exportado teve o rascunho apagado e binarioGravado zerado: regravar aqui
      // reescreveria megabytes e ressuscitaria um rascunho que já cumpriu o papel
      if (d.key && !d.saved) salvarRascunho(d, d.page || 1);
    });
    ordemSeq.current = Math.max(ordemSeq.current, nova.length);
    tick();
  };

  // ---- juntar partes de um processo ----
  const alternarSelecao = (id) => setSelecionados((s) => {
    const novo = new Set(s);
    if (novo.has(id)) novo.delete(id); else novo.add(id);
    return novo;
  });
  const desmarcar = (ids) => setSelecionados((s) => {
    if (!ids.some((id) => s.has(id))) return s; // nada a fazer: não re-renderiza à toa
    const novo = new Set(s);
    for (const id of ids) novo.delete(id);
    return novo;
  });
  // o pdf.js abre um worker por documento; sem isto cada parte descartada deixa um vazando
  const soltarDoc = (d) => {
    if (!d) return;
    // marca ANTES de destruir: o destroy rejeita o getPage/render em voo num microtask, e o
    // efeito de render precisa saber que a falha é de um documento descartado. Contar com o
    // `cancelled` do efeito não bastava — ele só vira true quando o React confirma o render
    // seguinte, e a rejeição pode chegar antes disso.
    d.solto = true;
    if (d.pdfDoc) { try { d.pdfDoc.destroy(); } catch { /* já morto */ } d.pdfDoc = null; }
  };

  const juntarSelecionados = async (ordem) => {
    const lista = ordem.map((id) => store.current.docs.find((d) => d.id === id)).filter(Boolean);
    if (lista.length < 2) return;
    setSaving(true);
    try {
      // O herdado de memória manda SÓ quando já foi lido: ele pode ter glosa que o auditor
      // apagou, e reler o arquivo a ressuscitaria. Documento que nunca foi aberto ainda está
      // com o `herdado: null` de fábrica (quem preenche é o efeito de render, na primeira vez
      // que ele aparece na tela) — mandar esse null faria o juntarPdfs acreditar que a parte
      // não tem glosa nenhuma e descartar em silêncio a auditoria que veio dentro dela.
      // undefined é o combinado para "não sei, leia do arquivo".
      const junto = await juntarPdfs(lista.map((d) => ({
        bytes: d.bytes,
        herdado: d.metaLida ? d.herdado : undefined,
        keywordsOriginais: d.metaLida ? (d.keywordsOriginais || "") : undefined,
      })));

      // tudo que é chaveado por página anda o tamanho das partes anteriores
      const annotations = {}, rotacoes = {};
      lista.forEach((d, i) => {
        Object.assign(annotations, deslocarPaginas(d.annotations, junto.offsets[i]));
        Object.assign(rotacoes, deslocarPaginas(d.rotacoes, junto.offsets[i]));
      });

      // o resto do editor trata doc.bytes como ArrayBuffer; o pdf-lib devolve Uint8Array.
      // A view cobre o buffer inteiro, mas conferir é de graça e evita um PDF truncado caso
      // isso mude numa versão futura da biblioteca.
      const u8 = junto.bytes;
      const bytes = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
        ? u8.buffer : u8.slice().buffer;

      const primeiro = lista[0];
      const novo = {
        id: ++seq.current, name: primeiro.name, bytes, pdfDoc: null,
        numPages: junto.paginas, page: 1, annotations, rotacoes, saved: false,
        totalConta: lista.map((d) => d.totalConta).find(Boolean) || "",
        herdado: junto.herdado,
        keywordsOriginais: junto.keywordsOriginais,
        key: rascunho.novaChave(),
        // herda a posição da primeira parte: com uma ordem nova o juntado iria para o fim da
        // fila depois de uma restauração de rascunho
        ordem: primeiro.ordem,
        // true de propósito: os metadados certos são os que acabamos de montar, e deixar o
        // efeito de render reler as Keywords ressuscitaria glosa que o auditor apagou
        metaLida: true,
        semBinario: false,
        binarioGravado: false,
      };

      const idsFonte = lista.map((d) => d.id);
      // o juntado assume a tela. Se quem estava aberto não entrou na junção, ele sai como
      // sairia por selectDoc: sem isto, a página e as últimas marcações dele se perderiam
      // junto com o timer do autosave.
      const anterior = getActive();
      if (anterior && !idsFonte.includes(anterior.id)) {
        anterior.page = page;
        if (!anterior.saved) { clearTimeout(autosave.current.timer); salvarRascunho(anterior, page); }
      }
      const antes = store.current.docs;
      const resto = antes.filter((d) => !idsFonte.includes(d.id));
      // a posição é contada em `resto`, de onde as partes já saíram: usar o índice em `antes`
      // erraria por quantas partes ficavam antes da primeira. Com a fila [A,B,C,D] e as partes
      // A e C, o juntado tem que cair entre B e D, e não no fim.
      const pos = antes.slice(0, antes.findIndex((d) => d.id === primeiro.id))
        .filter((d) => !idsFonte.includes(d.id)).length;
      store.current.docs = [...resto.slice(0, pos), novo, ...resto.slice(pos)];
      for (const d of lista) { if (d.key) rascunho.apagarDoc(d.key); soltarDoc(d); }

      salvarRascunho(novo, 1);
      desmarcar(idsFonte);
      setJuntarOpen(false);
      redo.current = []; // as entradas apontam para { docId, page } que não existem mais
      setActiveId(novo.id); setPage(1);
      tick();
      // o efeito de render não depende de rev: sem isto a tela continua no PDF antigo
      setGiroRev((n) => n + 1);
    } catch (e) {
      // a janela de juntar fica por cima do diálogo: sem fechá-la, o recado de erro sairia
      // escondido atrás dela. A seleção continua de pé, para o auditor poder tentar de novo.
      setJuntarOpen(false);
      showAlert("Erro ao juntar", e.message);
    }
    finally { setSaving(false); }
  };
  // Uma coluna de glosas é um ato só: sem isto, desfazer 30 linhas seria 30 Ctrl+Z. As caixas
  // do mesmo arrasto compartilham `grupo` e saem juntas (a borracha continua indo de uma em
  // uma — é o que serve para corrigir uma linha isolada).
  const undo = () => {
    const d = getActive(); const l = d && d.annotations[page];
    if (l && l.length) {
      const ultima = l[l.length - 1];
      const anns = [l.pop()];
      if (ultima.grupo)
        while (l.length && l[l.length - 1].grupo === ultima.grupo) anns.unshift(l.pop());
      redo.current.push({ docId: activeId, page, anns });
      d.saved = false;
      setSelectedId(null); drawOverlay(); tick();
    }
  };
  const redoAction = () => {
    const item = redo.current.pop(); if (!item) return;
    const d = store.current.docs.find((x) => x.id === item.docId); if (!d) return;
    (d.annotations[item.page] = d.annotations[item.page] || []).push(...item.anns);
    d.saved = false;
    drawOverlay(); tick();
  };
  const clearPage = () => {
    const d = getActive();
    if (!d || !(d.annotations[page] || []).length) return;
    showConfirm("Limpar página", "Remover todas as marcações desta página?", () => {
      d.annotations[page] = []; d.saved = false;
      setSelectedId(null); drawOverlay(); tick();
    }, { confirmText: "Limpar" });
  };
  const prevPage = () => { if (page > 1) { const d = getActive(); d.page = page - 1; setPage(page - 1); } };
  const nextPage = () => { const d = getActive(); if (d && page < d.numPages) { d.page = page + 1; setPage(page + 1); } };
  // ir direto para uma página (usado pelo campo do rodapé); fora do intervalo, ajusta p/ 1..numPages
  const goToPage = (n) => {
    const d = getActive(); if (!d || !d.numPages) return page;
    const alvo = Math.min(d.numPages, Math.max(1, Math.floor(n)));
    if (alvo !== page) { d.page = alvo; setPage(alvo); }
    return alvo;
  };
  const commitPageInput = () => {
    const n = parseInt(pageInput, 10);
    if (Number.isNaN(n)) { setPageInput(String(page)); return; }
    setPageInput(String(goToPage(n)));
  };

  // gira SÓ a página aberta, na tela e no PDF exportado (ver girarAnns e buildPdf).
  // Fica fora do desfazer de propósito: para voltar, basta o botão do outro lado —
  // misturar giro e marcação na mesma pilha confundiria mais do que ajudaria.
  const girarPagina = (delta) => {
    const d = getActive(); if (!d || !d.numPages) return;
    const cv = baseRef.current; if (!cv) return;
    // dimensões do viewport ANTES do giro, em pontos do documento
    const Wv = cv.width / scale, Hv = cv.height / scale;
    d.rotacoes = d.rotacoes || {};
    d.rotacoes[page] = ((((d.rotacoes[page] || 0) + delta) % 360) + 360) % 360;
    girarAnns(d.annotations[page], delta, Wv, Hv);
    d.saved = false;
    setSelectedId(null);
    setGiroRev((n) => n + 1); // re-renderiza a página com a nova rotação
    tick();                   // e leva o giro para o rascunho
  };

  // ---- exportar ----
  const hexRgb = (h) => {
    const n = parseInt(h.slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };
  const buildPdf = async (d) => {
    const out = await PDFDocument.load(d.bytes);
    const font = await out.embedFont(StandardFonts.HelveticaBold);
    const pages = out.getPages();
    const stampCache = new Map(); // url → PDFImage (embeda cada carimbo 1x por documento)
    const embedStamp = async (url) => {
      if (stampCache.has(url)) return stampCache.get(url);
      const bytes = await (await fetch(url)).arrayBuffer();
      const isJpg = url.startsWith("data:image/jpeg") || /\.jpe?g($|\?)/i.test(url);
      const img = isJpg ? await out.embedJpg(bytes) : await out.embedPng(bytes);
      stampCache.set(url, img);
      return img;
    };
    // O giro das páginas vem PRIMEIRO, e em laço próprio: o laço de marcações abaixo pula
    // página sem marcação nenhuma, e uma página só endireitada precisa sair endireitada.
    // Feito aqui, o bloco de matriz corretiva mais abaixo já lê o /Rotate final e põe as
    // marcações no lugar sozinho.
    for (const [pg, giro] of Object.entries(d.rotacoes || {})) {
      const p = pages[pg - 1];
      if (!p || !giro) continue;
      p.setRotation(degrees((((p.getRotation().angle + giro) % 360) + 360) % 360));
    }
    for (const [pg, list] of Object.entries(d.annotations)) {
      const pageObj = pages[pg - 1]; if (!pageObj || !list || !list.length) continue;
      // O editor marca em cima do que o pdf.js desenha, e o getViewport APLICA o /Rotate
      // da página: numa página deitada a tela é 842×595, não 595×842. O pdf-lib desenha
      // no espaço da página sem rotação. Sem a matriz abaixo, a marcação sai transposta
      // e o que passa da largura do papel cai fora da folha.
      const W = pageObj.getWidth(), H = pageObj.getHeight(); // MediaBox: ignora /Rotate
      let rot = ((pageObj.getRotation().angle % 360) + 360) % 360;
      if (rot % 90) rot = 0;                                 // /Rotate torto: trata como 0
      const VH = (rot === 90 || rot === 270) ? W : H;        // altura do viewport da tela
      // leva o espaço do viewport (y para cima) ao espaço da página
      const M = { 90: [0, 1, -1, 0, W, 0], 180: [-1, 0, 0, -1, W, H], 270: [0, -1, 1, 0, 0, H] }[rot];
      // cada draw* do pdf-lib já se envolve no próprio q…Q, então todos ficam aninhados
      // aqui dentro e herdam a matriz. Página em pé não recebe operador nenhum.
      if (M) pageObj.pushOperators(pushGraphicsState(), concatTransformationMatrix(...M));
      for (const a of list) {
        if (a.type === "strike")
          pageObj.drawLine({ start: { x: a.x1, y: VH - a.y1 }, end: { x: a.x2, y: VH - a.y2 }, thickness: a.thickness, color: hexRgb(a.color) });
        else if (a.type === "pen") {
          const pts = a.points || [];
          for (let i = 1; i < pts.length; i++)
            pageObj.drawLine({
              start: { x: pts[i - 1].x, y: VH - pts[i - 1].y },
              end: { x: pts[i].x, y: VH - pts[i].y },
              thickness: a.thickness, color: hexRgb(a.color), lineCap: LineCapStyle.Round,
            });
        } else if (a.type === "symbol") {
          const th = Math.max(1.5, a.size * 0.12);
          for (const seg of symbolSegs(a.symbol, a.size))
            pageObj.drawLine({
              start: { x: a.x + seg[0].x, y: VH - a.y - seg[0].y },
              end: { x: a.x + seg[1].x, y: VH - a.y - seg[1].y },
              thickness: th, color: hexRgb(a.color), lineCap: LineCapStyle.Round,
            });
        } else if (a.type === "cover") {
          // opaco e sem borda: o contorno tracejado da tela é só guia de edição.
          // Cobre, não apaga — o texto por baixo continua no conteúdo do PDF.
          pageObj.drawRectangle({
            x: a.x, y: VH - a.y - a.h, width: a.w, height: a.h,
            color: hexRgb(a.color || "#ffffff"),
          });
        } else if (a.type === "highlight") {
          const x = Math.min(a.x1, a.x2), w = Math.abs(a.x2 - a.x1);
          const yTop = Math.min(a.y1, a.y2), h = Math.abs(a.y2 - a.y1);
          pageObj.drawRectangle({ x, y: VH - yTop - h, width: w, height: h, color: hexRgb(a.color || "#ffd600"), opacity: 0.38 });
        } else if (a.type === "text") {
          // desenha só o texto (sem caixa/borda/fundo), fixo e não editável
          String(a.text || "").split("\n").forEach((ln, i) => {
            if (!ln) return;
            pageObj.drawText(ln, {
              x: a.x + 1,
              y: VH - a.y - a.size * (i + 1), // baseline ~1 tamanho abaixo do topo (casa com a tela)
              size: a.size,
              font,
              color: hexRgb(a.color),
            });
          });
        } else if (a.type === "stamp") {
          const img = await embedStamp(a.url);
          pageObj.drawImage(img, { x: a.x, y: VH - a.y - a.h, width: a.w, height: a.h });
        }
      }
      if (M) pageObj.pushOperators(popGraphicsState());
    }
    gravarGlosas(out, d, usuario);
    // campo Autor: é o que aparece em Arquivo > Propriedades de qualquer leitor de PDF e nos
    // Detalhes do Windows. Metadado é editável, então isto é rastro, não prova.
    const nomes = [...new Set(listaAuditores(d, usuario).map((a) => a.nome).filter(Boolean))];
    if (nomes.length) out.setAuthor(nomes.join("; "));
    out.setProducer("Editor de Auditoria — Maida");
    return out.save();
  };
  const outName = (d) => nomeAuditado(d.name, ROTULO_PAPEL[usuario.papel] || "", rotulosHerdados(d));
  const dl = (bytes, name, type = "application/pdf") => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };
  const doSaveOne = async () => {
    const d = getActive(); if (!d) return;
    setSaving(true);
    try {
      dl(await buildPdf(d), outName(d));
      d.saved = true;
      // o PDF auditado saiu: o rascunho cumpriu o papel e é descartado
      if (d.key) { rascunho.apagarDoc(d.key); d.binarioGravado = false; }
      tick();
    }
    catch (e) { showAlert("Erro ao gerar", e.message); }
    finally { setSaving(false); }
  };
  const saveOne = () => {
    const d = getActive(); if (!d) return;
    const temCarimbo = Object.values(d.annotations).some((l) => l.some((a) => a.type === "stamp"));
    // o aviso é só para quem assina: para o administrativo seria ruído em toda exportação
    if (!temCarimbo && carimbaDoc)
      showConfirm("Salvar sem carimbo?",
        "Você não inseriu nenhum carimbo neste documento. Deseja salvar mesmo assim?",
        doSaveOne, { confirmText: "Salvar assim" });
    else doSaveOne();
  };
  const saveAll = async () => {
    const alvo = store.current.docs.filter((d) => Object.values(d.annotations).some((l) => l.length));
    if (!alvo.length) return;
    setSaving(true);
    try {
      const zip = new JSZip();
      for (const d of alvo) { zip.file(outName(d), await buildPdf(d)); d.saved = true; }
      const blob = await zip.generateAsync({ type: "blob" });
      dl(blob, "auditados.zip", "application/zip"); tick();
      // só depois do download: se a compactação falhasse, o rascunho ainda seria a
      // única cópia do trabalho (d.saved já foi marcado no laço acima).
      for (const d of alvo) if (d.key) { rascunho.apagarDoc(d.key); d.binarioGravado = false; }
      setSidebarOpen(false);
    } catch (e) { showAlert("Erro ao compactar", e.message); }
    finally { setSaving(false); }
  };

  // ---- atalhos de teclado ----
  // este bloco fica no fim de propósito: o kb.current abaixo lê saveOne/saveAll e companhia,
  // e ler um const antes da linha que o declara é ReferenceError na hora do render (tela branca).
  const irUltimaPagina = () => { const d = getActive(); if (d && d.numPages) goToPage(d.numPages); };
  // [ e ]: anda na fila de documentos (Ctrl+PageUp/Down não serve, o Chrome fica com elas)
  const stepDoc = (delta) => {
    const lista = store.current.docs; if (lista.length < 2) return;
    const i = lista.findIndex((d) => d.id === activeId);
    const alvo = lista[Math.min(lista.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))];
    if (alvo && alvo.id !== activeId) selectDoc(alvo.id);
  };
  // mesmos passos e limites dos botões de zoom do rodapé
  const zoomPasso = (d) => setScale((s) => Math.min(3, Math.max(0.5, Math.round((s + d) * 100) / 100)));
  // X: troca ✓/✗ e já deixa o Check ativo (igual ao botão da toolbar)
  const alternaMarca = () => {
    setCheckSymbol((s) => (s === "check" ? "cross" : "check"));
    if (tool !== "check") setTool("check");
  };
  const abrirCarimbos = () => { if (getActive()) setStampsOpen(true); };
  const confirmarDialog = () => { const cb = dialog && dialog.onConfirm; setDialog(null); if (cb) cb(); };
  // Esc fecha uma coisa de cada vez, começando pela que está por cima
  const escapar = () => {
    if (menuOpen) { setMenuOpen(false); return; }
    if (senhaOpen) { setSenhaOpen(false); return; }
    if (juntarOpen) { if (!saving) setJuntarOpen(false); return; } // no meio da junção, não
    if (ajudaOpen) { setAjudaOpen(false); return; }
    if (dialog) { if (!dialog.semBackdrop) setDialog(null); return; }
    if (stampsOpen) { setStampsOpen(false); return; }
    if (glosaTec) { setGlosaTec(null); return; }
    if (colGlosa) { setColGlosa(null); return; }
    if (ocr) { setOcr(null); setOcrHold(false); return; }
    if (selectedId) { setSelectedId(null); return; }
    if (tool !== "select") setTool("select");
  };

  // atalhos de teclado (lê versão atual via ref) — a lista para o usuário sai de montarAtalhos
  const kb = useRef({});
  kb.current = {
    ferramentas,
    undo, redoAction, prevPage, nextPage, nudgeSelected, deleteText, editingId, selectedId,
    selectTool, setTool, setSelectedId, setColor, alternaMarca, abrirCarimbos,
    goToPage, irUltimaPagina, stepDoc, zoomPasso, setScale, saveOne, saveAll, saving,
    escapar, confirmarDialog, dialog, setAjudaOpen, alternaCalc, calcAberta, bloqueado,
    modalAberto: !!(dialog || stampsOpen || ajudaOpen || senhaOpen || glosaTec || colGlosa || juntarOpen),
  };
  useEffect(() => {
    const h = (e) => {
      if (!e.key) return; // eventos sintéticos/IME podem chegar sem key
      // sessão caída: o editor está montado só para não perder o trabalho, atrás da
      // sobreposição de reentrada. Nada aqui pode responder por baixo dela.
      if (kb.current.bloqueado) return;
      // não interferir enquanto o usuário digita num campo
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;

      if (k === "Escape") { e.preventDefault(); kb.current.escapar(); return; }
      // com um modal aberto, o resto dos atalhos cala a boca (o Esc acima já o fecha)
      if (kb.current.modalAberto) {
        const d = kb.current.dialog;
        if (k === "Enter" && d && !d.semBackdrop) { e.preventDefault(); kb.current.confirmarDialog(); }
        return;
      }

      if ((k === "Delete" || k === "Backspace") && kb.current.selectedId && !kb.current.editingId) {
        e.preventDefault(); kb.current.deleteText(kb.current.selectedId); return;
      }
      if (ctrl && k.toLowerCase() === "s") { // preventDefault: senão o navegador salva a página
        e.preventDefault();
        if (!kb.current.saving) { if (e.shiftKey) kb.current.saveAll(); else kb.current.saveOne(); }
        return;
      }
      if (ctrl && k.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); kb.current.undo(); return; }
      if (ctrl && (k.toLowerCase() === "y" || (k.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault(); kb.current.redoAction(); return;
      }
      if (ctrl && k === "0") { e.preventDefault(); kb.current.setScale(1); return; }
      if (k === "?" || k === "F1") { e.preventDefault(); kb.current.setAjudaOpen(true); return; }

      // setas: movem o item selecionado; sem seleção, passam as páginas (como antes)
      if (k.startsWith("Arrow")) {
        const passo = e.shiftKey ? 10 : 1; // 1pt no ajuste fino, 10pt com Shift
        const dx = k === "ArrowLeft" ? -passo : k === "ArrowRight" ? passo : 0;
        const dy = k === "ArrowUp" ? -passo : k === "ArrowDown" ? passo : 0;
        if (!dx && !dy) return;
        if (kb.current.nudgeSelected(dx, dy)) { e.preventDefault(); return; }
        if (dx < 0) kb.current.prevPage();
        if (dx > 0) kb.current.nextPage(); // sem seleção, ↑/↓ seguem rolando a página
        return;
      }

      // daqui para baixo são teclas soltas: com Ctrl/Alt, deixa passar para o navegador
      if (ctrl || e.altKey) return;

      if (k === "+" || k === "=") { e.preventDefault(); kb.current.zoomPasso(0.15); return; }
      if (k === "-" || k === "_") { e.preventDefault(); kb.current.zoomPasso(-0.15); return; }
      if (k === "PageDown") { e.preventDefault(); kb.current.nextPage(); return; }
      if (k === "PageUp") { e.preventDefault(); kb.current.prevPage(); return; }
      if (k === "Home") { e.preventDefault(); kb.current.goToPage(1); return; }
      if (k === "End") { e.preventDefault(); kb.current.irUltimaPagina(); return; }
      if (k === "]") { e.preventDefault(); kb.current.stepDoc(1); return; }
      if (k === "[") { e.preventDefault(); kb.current.stepDoc(-1); return; }

      // ferramentas: 1..N na ordem da toolbar DESTE auditor; 0 volta ao modo navegar
      const fs = kb.current.ferramentas;
      if (k >= "1" && k <= String(fs.length)) {
        e.preventDefault(); kb.current.selectTool(fs[Number(k) - 1].id); return;
      }
      if (k === "0") { e.preventDefault(); kb.current.setTool("select"); kb.current.setSelectedId(null); return; }

      switch (k.toLowerCase()) {
        case "a": e.preventDefault(); kb.current.setColor(COR_ADM); break;
        case "t": e.preventDefault(); kb.current.setColor(COR_TEC); break;
        case "x": e.preventDefault(); kb.current.alternaMarca(); break;
        case "c": e.preventDefault(); kb.current.abrirCarimbos(); break;
        case "g": e.preventDefault(); kb.current.alternaCalc(!kb.current.calcAberta); break;
        default: break;
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // sair troca de auditor sem passar pelo beforeunload, que é quem avisa do trabalho não
  // exportado — o rascunho fica guardado e volta a ser oferecido no próximo login dele,
  // mas quem clicou precisa saber disso antes.
  const sair = () => {
    const pendente = store.current.docs.some(
      (d) => !d.saved && Object.values(d.annotations).some((l) => l.length));
    if (!pendente) return onSair();
    showConfirm("Sair do Editor",
      "Há marcações que ainda não foram baixadas. Elas ficam guardadas no rascunho deste navegador e voltam a ser oferecidas quando você entrar de novo.",
      onSair, { confirmText: "Sair mesmo assim" });
  };

  // ---- derivados ----
  const docs = store.current.docs;
  const marked = docs.filter((d) => Object.values(d.annotations).some((l) => l.length)).length;
  const pct = docs.length ? Math.round((marked / docs.length) * 100) : 0;
  const arrastoFila = useArrastarLista({
    ids: docs.map((d) => d.id), aoSoltar: reordenarFila,
    containerRef: filaRef, desligado: saving,
  });
  // durante o arrasto a ordem de trabalho é a do hook; fora dele é a da fila
  const docsNaTela = arrastoFila.ordem.map((id) => docs.find((d) => d.id === id)).filter(Boolean);
  // na ordem da fila, e não na ordem em que foram marcados: é ela que a janela de juntar
  // oferece como ordem inicial das partes
  const selecionadosNaFila = docsNaTela.filter((d) => selecionados.has(d.id));
  const active = getActive();
  const hasMarks = active && (active.annotations[page] || []).length > 0;
  const statusOf = (d) => {
    if (d.saved) return ["Salvo", "bg-green-100 text-green-700"];
    if (Object.values(d.annotations).some((l) => l.length)) return ["Marcado", "bg-amber-100 text-amber-700"];
    return ["Pendente", "bg-slate-100 text-slate-500"];
  };

  return (
    <div className={"flex flex-col app-shell text-[var(--text)] select-none tema-" + tema}
      style={{ background: "var(--bg)" }}>
      {/* barra da marca */}
      <div className="flex items-center justify-between gap-2 px-3 md:px-4 py-2.5">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <img src={LOGO_MAIDA} alt="Maida" className="h-6 md:h-8" />
          <div className="flex flex-col leading-tight text-white min-w-0">
            <b className="text-sm md:text-base truncate">Editor de Auditoria</b>
            <span className="text-xs opacity-80 hidden sm:block">Auditoria médica — marcação de cortes em lote</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* abre a fila de documentos no mobile — frequente demais para esconder no menu */}
          <button className="btn-tema md:hidden" onClick={() => setSidebarOpen(true)}>
            <Folder className="w-4 h-4" />
            Docs{docs.length ? ` (${docs.length})` : ""}
          </button>
          <MenuConta
            usuario={usuario}
            papel={papel}
            tema={tema}
            aberto={menuOpen}
            onAlternar={() => setMenuOpen((v) => !v)}
            onFechar={() => setMenuOpen(false)}
            onSenha={() => setSenhaOpen(true)}
            onAtalhos={() => setAjudaOpen(true)}
            onTema={() => setTema(tema === "claro" ? "escuro" : "claro")}
            onSair={sair}
          />
        </div>
      </div>

      {/* toolbar (compacta no celular: só ícones, quebra linha se precisar)
          flex-wrap em CADA grupo, não só no header: um grupo com shrink-0 e conteúdo que não
          quebra tem largura intrínseca fixa, e as 8 ferramentas + o carimbo somavam 415px —
          mais do que qualquer celular tem. O carimbo, último da fila, saía da tela.
          (o administrativo tem uma ferramenta a mais, a glosa em coluna — mais motivo ainda) */}
      <header className="flex flex-wrap items-center gap-1.5 sm:gap-2 md:gap-3 px-2 md:px-4 py-2 bg-[var(--surface)] border-y border-[var(--border)] shadow-sm z-10">
        <div className="flex flex-wrap items-center gap-1 sm:gap-1.5 pr-2 md:pr-3 border-r border-[var(--border)]">
          {ferramentas.map(({ id, label, Icon }, i) => (
            <button key={id} onClick={() => selectTool(id)} title={`${label} (${i + 1})`}
              className={"flex items-center gap-1.5 px-2 sm:px-2.5 md:px-3 py-2 rounded-lg text-sm border font-semibold transition-colors whitespace-nowrap " +
                (tool === id
                  ? "bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]"
                  : "bg-[var(--surface)] border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]")}>
              <Icon className="w-4 h-4" /><span className="hidden sm:inline">{label}</span>
            </button>
          ))}
          <button onClick={abrirCarimbos} title="Carimbo (C)"
            disabled={!active}
            className={"flex items-center gap-1.5 px-2 sm:px-2.5 md:px-3 py-2 rounded-lg text-sm border font-semibold transition-colors whitespace-nowrap disabled:opacity-40 " +
              (stampsOpen
                ? "bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]"
                : "bg-[var(--surface)] border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]")}>
            <Stamp className="w-4 h-4" /><span className="hidden sm:inline">Carimbo</span>
          </button>
        </div>

        {/* tipo de glosa — a cor É a classificação, por isso só estas duas */}
        <div className="flex flex-wrap items-center gap-1 sm:gap-1.5 pr-2 md:pr-3 border-r border-[var(--border)]">
          <span className="text-xs uppercase tracking-wide text-[var(--muted)] hidden sm:inline">Glosa</span>
          {CORES.map(({ id, hex, label, title }) => (
            <button key={id} onClick={() => setColor(hex)} title={title}
              className={"flex items-center gap-1.5 px-1.5 sm:px-2 md:px-2.5 py-2 rounded-lg text-sm border font-semibold transition-colors whitespace-nowrap " +
                (color === hex
                  ? "bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]"
                  : "bg-[var(--surface)] border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]")}>
              <span className="w-3.5 h-3.5 rounded-full border border-black/20 shrink-0"
                style={{ background: hex }} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 pr-2 md:pr-3 border-r border-[var(--border)]">
          <span className="text-xs uppercase tracking-wide text-[var(--muted)] hidden sm:inline">Espessura</span>
          <input type="range" min="1" max="5" step="0.5" value={thickness}
            onChange={(e) => setThickness(parseFloat(e.target.value))} className="w-16 md:w-20"
            style={{ accentColor: "var(--accent)" }} />
          <span className="text-xs text-[var(--muted)] w-5 text-center hidden sm:inline">{thickness}</span>
        </div>

        {/* corpo do texto: mexe no item selecionado (coluna inteira, se ele for de uma) e
            define o tamanho do próximo texto inserido */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 pr-2 md:pr-3 border-r border-[var(--border)]">
          <span className="text-xs uppercase tracking-wide text-[var(--muted)] hidden sm:inline">Tamanho</span>
          <input type="range" min="6" max={tetoFonte} step="1" value={tamanhoAtual}
            onChange={(e) => aplicarTamanho(parseInt(e.target.value, 10))} className="w-16 md:w-20"
            title={selText ? "Tamanho desta marcação" : "Tamanho do próximo texto inserido"}
            style={{ accentColor: "var(--accent)" }} />
          <span className="text-xs text-[var(--muted)] w-8 text-center hidden sm:inline">{tamanhoAtual}pt</span>
        </div>

        {/* seletor do símbolo de check (✓ / ✗) — usado pela ferramenta Check */}
        <div className="flex flex-wrap items-center gap-1 sm:gap-1.5 pr-2 md:pr-3 border-r border-[var(--border)]">
          <span className="text-xs uppercase tracking-wide text-[var(--muted)] hidden sm:inline">Marca</span>
          {[
            { id: "check", Icon: Check, title: "Marca de certo (✓) — tecla X alterna" },
            { id: "cross", Icon: X, title: "Marca de errado (✗) — tecla X alterna" },
          ].map(({ id, Icon, title }) => (
            <button key={id} onClick={() => { setCheckSymbol(id); if (tool !== "check") setTool("check"); }}
              title={title}
              className={"w-8 h-8 flex items-center justify-center rounded-md border transition-colors " +
                (checkSymbol === id
                  ? "bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]"
                  : "bg-[var(--surface)] border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]")}>
              <Icon className="w-4 h-4" strokeWidth={3} />
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1 sm:gap-1.5 pr-2 md:pr-3 border-r border-[var(--border)]">
          <button onClick={undo} disabled={!hasMarks} title="Desfazer (Ctrl+Z)"
            className="flex items-center gap-1.5 px-2 sm:px-2.5 md:px-3 py-2 rounded-lg text-sm border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40 whitespace-nowrap">
            <Undo2 className="w-4 h-4" /><span className="hidden sm:inline">Desfazer</span>
          </button>
          <button onClick={redoAction} disabled={redo.current.length === 0} title="Refazer (Ctrl+Y)"
            className="flex items-center gap-1.5 px-2 sm:px-2.5 md:px-3 py-2 rounded-lg text-sm border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40 whitespace-nowrap">
            <Redo2 className="w-4 h-4" /><span className="hidden sm:inline">Refazer</span>
          </button>
          <button onClick={clearPage} disabled={!hasMarks} title="Limpar página"
            className="flex items-center gap-1.5 px-2 sm:px-2.5 md:px-3 py-2 rounded-lg text-sm border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40 whitespace-nowrap">
            <Trash2 className="w-4 h-4" /><span className="hidden sm:inline">Limpar página</span>
          </button>
        </div>

        <button onClick={saveOne} disabled={!active || saving} title="Salvar este (Ctrl+S)"
          className="flex shrink-0 items-center gap-1.5 px-2 sm:px-2.5 md:px-3 py-2 rounded-lg text-sm font-semibold bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40 whitespace-nowrap">
          <Save className="w-4 h-4" /><span className="hidden sm:inline">Salvar este</span>
        </button>
      </header>

      <div className="flex flex-1 min-h-0 relative">
        {/* backdrop da gaveta (mobile) */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 bg-black/50 md:hidden"
            onClick={() => setSidebarOpen(false)} />
        )}
        {/* sidebar: gaveta no mobile, fixa no desktop */}
        <aside className={
          "w-72 flex flex-col bg-[var(--surface)] border-r border-[var(--border)] " +
          "fixed inset-y-0 left-0 z-40 transform transition-transform duration-200 " +
          (sidebarOpen ? "translate-x-0 " : "-translate-x-full ") +
          "md:static md:translate-x-0 md:min-h-0 md:z-auto md:transform-none"
        }>
          <div className="p-3 border-b border-[var(--border)]">
            <div className="flex gap-2">
              <button onClick={() => fileRef.current.click()}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]">
                <FilePlus className="w-4 h-4" />PDFs
              </button>
              <button onClick={() => folderRef.current.click()}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]">
                <Folder className="w-4 h-4" />Pasta
              </button>
            </div>
            <input ref={fileRef} type="file" accept="application/pdf" multiple hidden
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <input ref={folderRef} type="file" hidden
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <div className="flex justify-between text-xs text-[var(--muted)] mt-2.5">
              <span>{docs.length ? `${marked} de ${docs.length} com marcação` : "0 documentos"}</span>
              <span>{docs.length ? pct + "%" : ""}</span>
            </div>
            <div className="h-1.5 bg-[var(--panel)] rounded-full mt-1.5 overflow-hidden">
              <div className="h-full transition-all" style={{ width: pct + "%", background: "var(--accent)" }} />
            </div>
          </div>

          <div ref={filaRef} className="flex-1 overflow-auto p-2 maida-scroll">
            {docsNaTela.map((d) => {
              const [txt, cls] = statusOf(d);
              const autor = ultimoAuditor(d); // veio das Keywords do PDF, se ele já foi auditado
              const arrastando = arrastoFila.arrastandoId === d.id;
              return (
                <div key={d.id} {...arrastoFila.props(d.id)}
                  // soltar o card não pode abrir o documento
                  onClick={() => { if (!arrastoFila.engoliuClique()) selectDoc(d.id); }}
                  className={
                    // sem .animated-card enquanto arrasta: ela tem transition+transform no hover,
                    // e o card pularia a cada vez que passasse por baixo do ponteiro
                    (arrastando ? "" : "animated-card ") +
                    // mãozinha aberta, e fechada enquanto segura — igual à janela de juntar.
                    // Uma de cada vez: com as duas na string quem ganha é a ordem em que o
                    // Tailwind as emite, não a ordem em que eu as escrevo.
                    (arrastando ? "cursor-grabbing " : "cursor-grab ") +
                    "flex flex-col gap-1 p-2.5 rounded-xl border " +
                    (arrastando
                      ? "bg-[var(--panel)] border-[var(--accent)] opacity-80 shadow-lg"
                      : d.id === activeId
                        ? "bg-[var(--panel)] border-[var(--accent)]"
                        : "border-transparent hover:bg-[var(--hover)]")}>
                  <div className="flex items-center justify-between gap-1">
                    {/* pista de que o card se arrasta — o gesto vale no card inteiro */}
                    <GripVertical className="w-3.5 h-3.5 shrink-0 text-[var(--muted)] opacity-60" />
                    {/* marcar não é abrir: o clique da caixinha não pode subir para o card */}
                    <input type="checkbox" checked={selecionados.has(d.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => alternarSelecao(d.id)}
                      title="Selecionar para juntar"
                      className="w-4 h-4 shrink-0 accent-[var(--accent)] cursor-pointer" />
                    <span className={"text-xs font-bold px-2 py-0.5 rounded-full uppercase mr-auto " + cls}>{txt}</span>
                    <button onClick={(e) => { e.stopPropagation(); removeDoc(d.id); }}
                      title="Remover da fila"
                      // cursor próprio: o card manda uma mãozinha de arrastar, e a lixeira
                      // clica, não arrasta (o preflight do Tailwind v4 não põe cursor em button)
                      className="w-7 h-7 flex items-center justify-center rounded-md cursor-pointer text-[var(--muted)] hover:text-red-500 hover:bg-[var(--hover)]">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <span className="text-sm font-semibold truncate text-[var(--text)]">{d.name}</span>
                  {autor && (
                    <span className="text-[11px] text-[var(--muted)] truncate"
                      title={d.herdado.auditores.map((a) => `${a.nome} — ${dataCurta(a.em)}`).join("\n")}>
                      por {autor.nome} · {dataCurta(autor.em)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="p-3 border-t border-[var(--border)]">
            {/* só aparece com o que juntar: processo dividido pelo SEI é exceção, não rotina */}
            {selecionadosNaFila.length >= 2 && (
              <button onClick={() => setJuntarOpen(true)} disabled={saving}
                title="Juntar as partes selecionadas num documento só"
                className="w-full mb-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40">
                <Combine className="w-4 h-4" />Juntar {selecionadosNaFila.length} selecionados
              </button>
            )}
            <button onClick={saveAll} disabled={marked === 0 || saving} title="Baixar todos auditados (Ctrl+Shift+S)"
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40">
              <Download className="w-4 h-4" />Baixar todos auditados (.zip)
            </button>
          </div>
        </aside>

        {/* workspace */}
        {/* nada de justify-center aqui: com o conteúdo maior que a área visível ele joga a
            borda esquerda para um deslocamento negativo, que o scrollLeft não alcança.
            A centralização fica por conta do mx-auto do wrapper da página (vira 0 no zoom). */}
        <main ref={mainRef} className="flex-1 overflow-auto flex p-3 md:p-6 maida-scroll">
          {loadErr ? (
            <div className="m-auto max-w-md text-center text-red-500 text-sm">{loadErr}</div>
          ) : !ready ? (
            <div className="m-auto text-white/70 text-sm">Carregando bibliotecas…</div>
          ) : !active ? (
            <div className="m-auto max-w-md text-center text-[var(--text)]">
              <div onClick={() => fileRef.current.click()} role="button" tabIndex={0}
                title="Clique para carregar PDFs"
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current.click(); }}
                className="border-2 border-dashed border-[var(--border)] rounded-xl p-10 bg-[var(--surface)] cursor-pointer transition-colors hover:border-[var(--accent)] hover:bg-[var(--hover)]">
                <FilePlus className="w-10 h-10 mx-auto mb-3 text-[var(--accent)]" />
                <h2 className="text-lg text-[var(--text)] font-semibold mb-2">Nenhum documento na fila</h2>
                <p className="text-sm leading-relaxed text-[var(--muted)]">
                  <b>Clique aqui</b> para carregar os PDFs (ou use <b>PDFs</b> / <b>Pasta</b> na lateral).
                </p>
                <p className="text-sm leading-relaxed mt-3 text-[var(--muted)]">
                  Depois <b>marque</b> cada procedimento a auditar e clique em <b>Salvar este</b>.
                  No fim, <b>baixe todos</b> num .zip.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 mx-auto">
              <div ref={wrapRef} className="relative bg-white shadow rounded" style={{ lineHeight: 0 }}>
                <canvas ref={baseRef} className="block rounded" />
                <canvas ref={overlayRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
                  onPointerCancel={onUp} onDoubleClick={onDblClick}
                  className="absolute top-0 left-0 rounded"
                  style={{ cursor: tool === "text" ? "text" : isDrawTool ? "crosshair" : "grab", touchAction: "none" }} />
                {/* camada de linhas, textos, carimbos e símbolos (pointer-events só nos elementos) */}
                <div className="absolute top-0 left-0 w-full h-full" style={{ pointerEvents: "none" }}>
                  {(active.annotations[page] || [])
                    .filter((a) => a.type === "text" || a.type === "stamp" || a.type === "symbol"
                      || a.type === "strike" || a.type === "cover")
                    .map((a) => a.type === "cover" ? (
                      <CoverBox
                        key={a.id}
                        a={a}
                        scale={scale}
                        selected={selectedId === a.id}
                        interactive={!isDrawTool}
                        onMove={(x, y) => moveText(a.id, x, y)}
                        onResize={(w, h) => resizeStamp(a.id, w, h)}
                        onSelect={() => setSelectedId(a.id)}
                        onDelete={() => deleteText(a.id)}
                      />
                    ) : a.type === "strike" ? (
                      <LineBox
                        key={a.id}
                        a={a}
                        scale={scale}
                        selected={selectedId === a.id}
                        interactive={!isDrawTool}
                        onMove={(y) => moveLine(a.id, y)}
                        onSelect={() => setSelectedId(a.id)}
                        onDelete={() => deleteText(a.id)}
                      />
                    ) : a.type === "stamp" ? (
                      <StampBox
                        key={a.id}
                        a={a}
                        scale={scale}
                        tetoLargura={tetoLargura}
                        selected={selectedId === a.id}
                        interactive={!isDrawTool}
                        onMove={(x, y) => moveText(a.id, x, y)}
                        onResize={(w, h) => resizeStamp(a.id, w, h)}
                        onSelect={() => setSelectedId(a.id)}
                        onDelete={() => deleteText(a.id)}
                        onDuplicate={() => duplicateAnn(a.id)}
                      />
                    ) : a.type === "symbol" ? (
                      <SymbolBox
                        key={a.id}
                        a={a}
                        scale={scale}
                        tetoFonte={tetoFonte}
                        selected={selectedId === a.id}
                        interactive={!isDrawTool}
                        onMove={(x, y) => moveText(a.id, x, y)}
                        onResize={(s) => resizeText(a.id, s)}
                        onSelect={() => setSelectedId(a.id)}
                        onDelete={() => deleteText(a.id)}
                        onDuplicate={() => duplicateAnn(a.id)}
                      />
                    ) : (
                      <TextBox
                        key={a.id}
                        a={a}
                        scale={scale}
                        tetoFonte={tetoFonte}
                        editing={editingId === a.id}
                        selected={selectedId === a.id}
                        interactive={!isDrawTool}
                        onChange={(t) => updateText(a.id, t)}
                        onMove={(x, y) => moveText(a.id, x, y)}
                        onResize={(s) => resizeText(a.id, s)}
                        onMeasure={(w, h) => measureText(a.id, w, h)}
                        onStartEdit={() => startEditText(a.id)}
                        onEndEdit={() => endEditText(a.id)}
                        onSelect={() => setSelectedId(a.id)}
                        onDelete={() => deleteText(a.id)}
                        onCancel={() => cancelText(a.id)}
                        onDuplicate={() => duplicateAnn(a.id)}
                      />
                    ))}
                </div>
                {/* balão da leitura de código (OCR) */}
                {ocr && (
                  <div
                    onMouseEnter={() => setOcrHold(true)}
                    onMouseLeave={() => setOcrHold(false)}
                    onPointerDown={() => setOcrHold(true)}
                    onFocus={() => setOcrHold(true)}
                    onBlur={() => setOcrHold(false)}
                    style={{
                      position: "absolute", zIndex: 5, pointerEvents: "auto",
                      left: ocr.x * scale, top: (ocr.y + ocr.h) * scale + 8,
                      maxWidth: 320, lineHeight: 1.3,
                    }}>
                    <div className="flex items-center gap-1.5 p-2 rounded-lg shadow-lg text-sm
                      bg-[var(--surface)] border border-[var(--accent)] text-[var(--text)]">
                      {ocr.loading ? (
                        <span className="px-1 text-[var(--muted)]">
                          {ocr.primeira ? "Preparando leitor…" : "Lendo…"}
                        </span>
                      ) : ocr.err ? (
                        <span className="px-1 text-[var(--muted)]">{ocr.err}</span>
                      ) : (
                        <>
                          <input value={ocr.text}
                            onChange={(e) => setOcr((o) => ({ ...o, text: e.target.value, copiado: false }))}
                            onFocus={(e) => e.target.select()}
                            title="Corrija aqui se a leitura saiu errada"
                            className="w-40 px-1.5 py-1 rounded-md font-mono
                              border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
                              focus:outline-none focus:border-[var(--accent)]" />
                          <button onClick={async () => {
                            const ok = await copiar(ocr.text);
                            setOcr((o) => (o ? { ...o, copiado: ok } : o));
                          }}
                            title="Copiar para a área de transferência"
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold
                              bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90">
                            <Copy className="w-3.5 h-3.5" />{ocr.copiado ? "copiado!" : "Copiar"}
                          </button>
                        </>
                      )}
                      <button onClick={() => setOcr(null)} title="Fechar"
                        className="px-1.5 py-1 rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">×</button>
                    </div>
                  </div>
                )}
                {/* glosa em coluna: valor uma vez só, repetido em todas as linhas da faixa */}
                {colGlosa && (
                  <div
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.stopPropagation(); setColGlosa(null); }
                      if (e.key === "Enter") { e.stopPropagation(); aplicarColunaGlosa(); }
                    }}
                    style={{
                      position: "absolute", zIndex: 6, pointerEvents: "auto",
                      left: colGlosa.x * scale, top: (colGlosa.y + colGlosa.h) * scale + 8,
                      lineHeight: 1.3,
                    }}>
                    <div className="p-2.5 rounded-lg shadow-lg text-sm min-w-[15rem]
                      bg-[var(--surface)] border border-[var(--border)] text-[var(--text)]"
                      style={{ borderLeft: `4px solid ${COR_ADM}` }}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <b className="text-xs uppercase tracking-wide text-[var(--muted)]">Glosa em coluna</b>
                        <button onClick={() => setColGlosa(null)} title="Fechar"
                          className="px-1.5 rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">×</button>
                      </div>
                      {colGlosa.loading ? (
                        <div className="px-1 py-1 text-[var(--muted)]">
                          {colGlosa.primeira ? "Preparando leitor…" : "Contando as linhas…"}
                        </div>
                      ) : (
                        <>
                          {colGlosa.err && (
                            <div className="mb-2 text-xs text-[var(--muted)]">{colGlosa.err}</div>
                          )}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <label className="flex flex-col gap-0.5">
                              <span className="text-[10px] uppercase text-[var(--muted)]">Valor</span>
                              <input value={colGlosa.valor} autoFocus
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => setColGlosa((g) => ({ ...g, valor: e.target.value }))}
                                className="w-24 px-1.5 py-1 rounded-md text-right font-mono
                                  border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
                                  focus:outline-none focus:border-[var(--accent)]" />
                            </label>
                            <span className="text-[var(--muted)] self-end pb-1.5">em</span>
                            <label className="flex flex-col gap-0.5">
                              <span className="text-[10px] uppercase text-[var(--muted)]">Linhas</span>
                              <input value={colGlosa.qtd} inputMode="numeric"
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => setColGlosa((g) => ({ ...g, qtd: e.target.value }))}
                                title="Quantas linhas recebem a glosa. Corrija se a contagem saiu errada."
                                className="w-14 px-1.5 py-1 rounded-md text-right font-mono
                                  border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
                                  focus:outline-none focus:border-[var(--accent)]" />
                            </label>
                            <label className="flex flex-col gap-0.5">
                              <span className="text-[10px] uppercase text-[var(--muted)]">Tam.</span>
                              <input value={colGlosa.tamanho} inputMode="numeric"
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => setColGlosa((g) => ({ ...g, tamanho: e.target.value }))}
                                title="Corpo da fonte, em pontos. Sugerido pelo espaçamento das linhas."
                                className="w-12 px-1.5 py-1 rounded-md text-right font-mono
                                  border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
                                  focus:outline-none focus:border-[var(--accent)]" />
                            </label>
                          </div>
                          <div className="mt-2 text-right font-semibold" style={{ color: COR_ADM }}>
                            = R$ {moeda((Math.floor(numeroBR(colGlosa.qtd)) || 0) * (numeroBR(colGlosa.valor) || 0))}
                          </div>
                          <div className="flex items-center gap-1.5 mt-2">
                            <button onClick={aplicarColunaGlosa}
                              disabled={!(numeroBR(colGlosa.valor) > 0 && Math.floor(numeroBR(colGlosa.qtd)) >= 1)}
                              className="flex-1 px-2 py-1.5 rounded-md text-xs font-semibold
                                bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40">
                              Glosar coluna
                            </button>
                            <button onClick={() => setColGlosa(null)}
                              className="px-2 py-1.5 rounded-md text-xs font-semibold
                                border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)]">
                              Cancelar
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {/* confirmação da glosa técnica (qtd cortada × valor unitário) */}
                {glosaTec && (
                  <div
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.stopPropagation(); setGlosaTec(null); }
                      if (e.key === "Enter") { e.stopPropagation(); confirmarGlosaTec(); }
                    }}
                    style={{
                      position: "absolute", zIndex: 6, pointerEvents: "auto",
                      left: glosaTec.x * scale, top: (glosaTec.y + glosaTec.h) * scale + 8,
                      lineHeight: 1.3,
                    }}>
                    <div className="p-2.5 rounded-lg shadow-lg text-sm min-w-[15rem]
                      bg-[var(--surface)] border border-[var(--border)] text-[var(--text)]"
                      style={{ borderLeft: `4px solid ${COR_TEC}` }}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <b className="text-xs uppercase tracking-wide text-[var(--muted)]">Glosa técnica</b>
                        <button onClick={() => setGlosaTec(null)} title="Fechar"
                          className="px-1.5 rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">×</button>
                      </div>
                      {glosaTec.loading ? (
                        <div className="px-1 py-1 text-[var(--muted)]">
                          {glosaTec.primeira ? "Preparando leitor…" : "Lendo a linha…"}
                        </div>
                      ) : (
                        <>
                          {glosaTec.err && (
                            <div className="mb-2 text-xs text-[var(--muted)]">{glosaTec.err}</div>
                          )}
                          <div className="flex items-center gap-1.5">
                            <label className="flex flex-col gap-0.5">
                              <span className="text-[10px] uppercase text-[var(--muted)]">Qtde</span>
                              <input value={glosaTec.qtd} autoFocus
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => setGlosaTec((g) => ({ ...g, qtd: e.target.value }))}
                                className="w-14 px-1.5 py-1 rounded-md text-right font-mono
                                  border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
                                  focus:outline-none focus:border-[var(--accent)]" />
                            </label>
                            <span className="text-[var(--muted)] self-end pb-1.5">×</span>
                            <label className="flex flex-col gap-0.5">
                              <span className="text-[10px] uppercase text-[var(--muted)]">Vl unitário</span>
                              <input value={glosaTec.unit}
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => setGlosaTec((g) => ({ ...g, unit: e.target.value }))}
                                className="w-24 px-1.5 py-1 rounded-md text-right font-mono
                                  border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
                                  focus:outline-none focus:border-[var(--accent)]" />
                            </label>
                          </div>
                          <div className="mt-2 text-right font-semibold" style={{ color: COR_TEC }}>
                            = R$ {moeda((numeroBR(glosaTec.qtd) || 0) * (numeroBR(glosaTec.unit) || 0))}
                          </div>
                          <div className="flex items-center gap-1.5 mt-2">
                            <button onClick={confirmarGlosaTec}
                              disabled={!(numeroBR(glosaTec.qtd) > 0 && numeroBR(glosaTec.unit) > 0)}
                              className="flex-1 px-2 py-1.5 rounded-md text-xs font-semibold
                                bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40">
                              Glosar
                            </button>
                            <button onClick={() => setGlosaTec(null)}
                              className="px-2 py-1.5 rounded-md text-xs font-semibold
                                border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)]">
                              Não é glosa
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* calculadora de glosas — flutua sobre o PDF, sem cobrir a toolbar */}
        {active && (
          <CalculadoraGlosas
            g={glosas}
            aberto={calcAberta}
            alterna={alternaCalc}
            totalConta={active.totalConta}
            onTotalConta={setTotalConta}
            onInserirResumo={inserirResumo}
            onIrPara={goToPage}
            onRemover={removerGlosa}
          />
        )}
      </div>

      {/* diálogo customizado (alert/confirm) */}
      {dialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50"
            onClick={() => { if (!dialog.semBackdrop) setDialog(null); }} />
          <div className="relative bg-[var(--surface)] rounded-xl shadow-2xl p-5 w-full max-w-sm border border-[var(--border)]">
            <b className="text-[var(--text)] block mb-2">{dialog.title}</b>
            <p className="text-sm text-[var(--muted)] mb-4 leading-relaxed">{dialog.message}</p>
            <div className="flex justify-end gap-2">
              {!dialog.alert && (
                <button onClick={() => { const cb = dialog.onCancel; setDialog(null); if (cb) cb(); }}
                  className="px-3 py-2 rounded-lg text-sm border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]">
                  {dialog.cancelText || "Cancelar"}
                </button>
              )}
              <button onClick={() => { const cb = dialog.onConfirm; setDialog(null); if (cb) cb(); }}
                className="px-3 py-2 rounded-lg text-sm font-semibold bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90">
                {dialog.alert ? "OK" : dialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* tela de atalhos do teclado */}
      {ajudaOpen && (
        <AjudaAtalhos secoes={montarAtalhos(ferramentas)} onFechar={() => setAjudaOpen(false)} />
      )}

      {/* trocar a própria senha */}
      {senhaOpen && <TrocarSenha onFechar={() => setSenhaOpen(false)} />}

      {/* juntar partes de um processo dividido */}
      {juntarOpen && selecionadosNaFila.length >= 2 && (
        <JuntarDocs docs={selecionadosNaFila} limiteRascunho={rascunho.LIMITE_ARQUIVO}
          juntando={saving} onFechar={() => { if (!saving) setJuntarOpen(false); }}
          onJuntar={juntarSelecionados} />
      )}

      {/* painel de carimbos */}
      {stampsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setStampsOpen(false)} />
          <div className="relative bg-[var(--surface)] rounded-xl shadow-2xl p-4 w-full max-w-md max-h-[80vh] overflow-auto maida-scroll border border-[var(--border)]">
            <div className="flex items-center justify-between mb-3">
              <b className="text-[var(--text)]">Seu carimbo</b>
              <button onClick={() => setStampsOpen(false)} title="Fechar"
                className="w-8 h-8 flex items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">
                <X className="w-4 h-4" />
              </button>
            </div>
            {carimboOcupado ? (
              <p className="text-sm text-[var(--muted)] py-4 text-center">Falando com o servidor…</p>
            ) : carimboErro ? (
              /* recusa do servidor não pode virar "envie o seu carimbo": foi essa confusão
                 que escondeu uma policy sumida do bucket por uma investigação inteira */
              <p className="text-sm mb-3 leading-relaxed text-red-500">
                Não foi possível ler o seu carimbo: {carimboErro}
              </p>
            ) : !carimbo ? (
              <p className="text-sm text-[var(--muted)] mb-3 leading-relaxed">
                Você ainda não enviou o seu carimbo. Clique em <b>Enviar carimbo</b> e escolha a
                imagem (PNG). Ela fica guardada <b>na sua conta</b>, alcançável só por você — e
                por isso aparece também quando você entrar de outra máquina.
              </p>
            ) : (
              <div
                onClick={(e) => {
                  const img = e.currentTarget.querySelector("img");
                  addStamp({ url: carimbo },
                    img && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.4);
                }}
                className="relative border border-[var(--border)] rounded-lg p-2 mb-3 cursor-pointer bg-white hover:border-[var(--accent)] hover:shadow">
                <img src={carimbo} alt={"Carimbo de " + usuario.nome} draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                  className="w-full h-20 object-contain pointer-events-none" />
                <div className="text-xs font-bold text-center mt-1.5 truncate text-slate-800">
                  {usuario.nome}
                </div>
                <button onClick={(ev) => { ev.stopPropagation(); removerCarimbo(); }}
                  title="Remover o carimbo da minha conta"
                  className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-600 text-white text-xs shadow">
                  ×
                </button>
              </div>
            )}
            <button onClick={() => stampFileRef.current.click()} disabled={carimboOcupado}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40">
              <FilePlus className="w-4 h-4" />{carimbo ? "Substituir carimbo" : "Enviar carimbo"}
            </button>
            <input ref={stampFileRef} type="file" accept="image/png,image/jpeg" hidden
              onChange={(e) => { const f = e.target.files[0]; if (f) enviarCarimbo(f); e.target.value = ""; }} />
          </div>
        </div>
      )}

      {/* footer */}
      <footer className="app-footer flex flex-wrap items-center justify-center gap-2 md:gap-3 px-2 md:px-4 py-1.5 bg-[var(--surface)] border-t border-[var(--border)] text-xs text-[var(--muted)]">
        <span className="truncate max-w-xs hidden md:block">{active ? active.name : "—"}</span>
        <div className="flex-1 hidden md:block" />
        <div className="flex items-center gap-1.5">
          <button onClick={prevPage} disabled={!active || page <= 1} title="Página anterior (PageUp)"
            className="px-3 py-1.5 md:px-2.5 md:py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button>
          <span className="flex items-center gap-1">
            <span className="hidden sm:inline">Página</span>
            <input type="text" inputMode="numeric" value={pageInput}
              disabled={!active || !active.numPages}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitPageInput(); e.currentTarget.blur(); }
                if (e.key === "Escape") { e.preventDefault(); setPageInput(String(page)); e.currentTarget.blur(); }
              }}
              onBlur={commitPageInput}
              title="Digite o número da página e pressione Enter"
              className="w-12 px-1 py-0.5 text-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-40" />
            <span>/ {active ? active.numPages : 0}</span>
          </span>
          <button onClick={nextPage} disabled={!active || page >= (active ? active.numPages : 0)} title="Próxima página (PageDown)"
            className="px-3 py-1.5 md:px-2.5 md:py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
        </div>
        {/* giro: só a página aberta, e vale também no PDF exportado */}
        <div className="flex items-center gap-1.5">
          <button onClick={() => girarPagina(-90)} disabled={!active || !active.numPages}
            title="Girar esta página para a esquerda"
            className="px-3 py-1.5 md:px-2.5 md:py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40"><RotateCcw className="w-4 h-4" /></button>
          <button onClick={() => girarPagina(90)} disabled={!active || !active.numPages}
            title="Girar esta página para a direita"
            className="px-3 py-1.5 md:px-2.5 md:py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40"><RotateCw className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 hidden md:block" />
        <div className="flex items-center gap-1.5">
          <button onClick={() => zoomPasso(-0.15)} disabled={!active} title="Afastar (tecla −)"
            className="px-3 py-1.5 md:px-2.5 md:py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40"><Minus className="w-4 h-4" /></button>
          <button onClick={() => setScale(1)} disabled={!active} title="Voltar a 100% (Ctrl+0)"
            className="w-12 text-center rounded-md hover:bg-[var(--hover)] disabled:opacity-40">{Math.round(scale * 100)}%</button>
          <button onClick={() => zoomPasso(0.15)} disabled={!active} title="Aproximar (tecla +)"
            className="px-3 py-1.5 md:px-2.5 md:py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40"><Plus className="w-4 h-4" /></button>
        </div>
      </footer>
    </div>
  );
}
