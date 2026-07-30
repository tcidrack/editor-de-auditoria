// Rascunho automático da sessão de auditoria (IndexedDB).
//
// O trabalho vive só na memória (store.current.docs no editor): uma queda de energia
// levava tudo junto. Aqui ele é gravado no próprio navegador enquanto o auditor marca,
// e devolvido na próxima abertura.
//
// Duas object stores, porque o custo de cada uma é muito diferente:
//   arquivos → o PDF cru e as imagens de carimbo. Pesado, mas escrito UMA vez (não muda).
//   sessao   → marcações, glosas e página atual. Leve, reescrito a cada poucos segundos.
// Juntar as duas faria o autosave regravar megabytes a cada traço.
//
// REGRA DO MÓDULO: nenhuma função lança nem rejeita. Falha vira null/false e um aviso
// pelo callback de aoFalhar(). Gravar rascunho é uma rede de segurança — se o IndexedDB
// estiver indisponível (janela anônima, cota estourada), a auditoria segue normalmente.

const DB = "editor-auditoria";
const VERSAO = 1;
const ARQUIVOS = "arquivos";
const SESSAO = "sessao";

// PDFs acima disso não entram no rascunho: um lote de digitalizações estoura a cota
// e derrubaria a gravação de todos os outros documentos junto.
export const LIMITE_ARQUIVO = 60 * 1024 * 1024;

let conexao = null;     // Promise<IDBDatabase|null> — memoizada (ver getOcrWorker no editor)
let onFalha = () => {};

export function aoFalhar(cb) { onFalha = typeof cb === "function" ? cb : () => {}; }

const falhou = (e) => { try { onFalha(e); } catch { /* o aviso não pode derrubar nada */ } };

// chave estável de documento. crypto.randomUUID não existe fora de contexto seguro
// (o app roda em http interno — ver o fallback do clipboard em EditorAuditoria).
export const novaChave = () => {
  try {
    if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* segue para o fallback */ }
  return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
};

// hash curto do data-URL de um carimbo (FNV-1a 32 bits). Serve só para desduplicar
// imagens iguais; crypto.subtle também é bloqueado fora de contexto seguro.
export const hashUrl = (url) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36) + "-" + url.length;
};

// ---- conversão das anotações ----
// O registro de sessão é reescrito a cada poucos segundos, então precisa ser leve.
// Dois cuidados: o carimbo guarda a imagem inteira em base64 dentro da anotação
// (os carimbos entram no bundle como ?inline), e o traço da caneta é uma lista
// longa de pontos.
const arred = (n) => Math.round(n * 100) / 100;

// `imagens` sai preenchido com hash → data-URL dos carimbos encontrados, para o
// chamador gravá-los na store de arquivos.
export const serializarAnns = (annotations, imagens) => {
  const saida = {};
  for (const [pg, lista] of Object.entries(annotations || {})) {
    saida[pg] = (lista || []).map((a) => {
      const c = { ...a };
      if (c.type === "pen" && Array.isArray(c.points))
        c.points = c.points.map((p) => ({ x: arred(p.x), y: arred(p.y) }));
      // a imagem vai uma única vez para a store `arquivos`; aqui fica só a referência
      if (c.type === "stamp" && typeof c.url === "string") {
        const h = hashUrl(c.url);
        if (imagens) imagens.set(h, c.url);
        c.urlRef = h; delete c.url;
      }
      return c;
    });
  }
  return saida;
};

// devolve as anotações prontas para uso, com os carimbos reidratados.
// A imagem volta como data-URL (e não blob:) porque o buildPdf faz fetch(a.url) ao
// exportar — um blob: revogado quebraria a geração do PDF.
export const restaurarAnns = async (annotations, cacheImg) => {
  const saida = {};
  for (const [pg, lista] of Object.entries(annotations || {})) {
    const out = [];
    for (const a of lista || []) {
      const c = { ...a };
      if (c.type === "stamp" && c.urlRef) {
        const url = await cacheImg(c.urlRef);
        if (!url) continue; // imagem perdida: descarta o carimbo, mantém o resto da página
        c.url = url; delete c.urlRef;
      }
      out.push(c);
    }
    saida[pg] = out;
  }
  return saida;
};

// data:image/png;base64,… → Blob (o binário ocupa ~25% menos que o base64)
export const dataUrlParaBlob = (url) => {
  try {
    const [cab, b64] = String(url).split(",");
    if (!b64) return null;
    const tipo = (cab.match(/data:([^;]+)/) || [])[1] || "image/png";
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: tipo });
  } catch { return null; } // carimbo com url estranha: fica de fora do rascunho
};

export const blobParaDataUrl = (blob) => new Promise((ok) => {
  try {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => ok(null);
    r.readAsDataURL(blob);
  } catch { ok(null); }
});

// todos os hashes de carimbo que os rascunhos ainda usam (para a coleta de lixo)
export const hashesDosRegistros = (regs) => {
  const s = new Set();
  for (const r of regs || [])
    for (const lista of Object.values(r.annotations || {}))
      for (const a of lista || []) if (a.urlRef) s.add(a.urlRef);
  return [...s];
};

// ---- conexão ----
// open() pode ficar pendurado sem disparar evento nenhum (onblocked, Firefox privado),
// e isso travaria o prompt de retomada no boot — daí o timeout.
export function iniciar() {
  if (conexao) return conexao;
  conexao = new Promise((resolve) => {
    let pronto = false;
    const acaba = (v) => { if (!pronto) { pronto = true; resolve(v); } };
    setTimeout(() => acaba(null), 3000);
    try {
      if (!globalThis.indexedDB) return acaba(null);
      const req = indexedDB.open(DB, VERSAO);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ARQUIVOS)) db.createObjectStore(ARQUIVOS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(SESSAO)) db.createObjectStore(SESSAO, { keyPath: "key" });
      };
      req.onsuccess = () => acaba(req.result);
      req.onerror = () => { falhou(req.error); acaba(null); };
      req.onblocked = () => acaba(null);
    } catch (e) { falhou(e); acaba(null); }
  }).then((db) => {
    // sem isso o Chrome pode descartar a base sob pressão de disco — justo no cenário
    // de muitos PDFs grandes, que é quando o rascunho mais importa.
    if (db) { try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* opcional */ } }
    return db;
  });
  return conexao;
}

// ---- helpers de transação ----
// QuotaExceededError chega no abort da TRANSAÇÃO, não no onerror do request: esperar
// pelo request faria uma escrita estourada reportar sucesso.
const escrever = async (store, fn) => {
  const db = await iniciar();
  if (!db) return false;
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(true);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } catch (e) { falhou(e); return false; }
};

const ler = async (store, fn) => {
  const db = await iniciar();
  if (!db) return null;
  try {
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(store, "readonly").objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { falhou(e); return null; }
};

// ---- binários (PDF e imagens de carimbo) ----
const salvarBin = (key, blob) => escrever(ARQUIVOS, (s) => s.put({ key, blob }));
const lerBin = async (key) => {
  const r = await ler(ARQUIVOS, (s) => s.get(key));
  return r ? r.blob : null;
};

export const salvarPdf = (key, blob) => salvarBin("pdf:" + key, blob);
export const lerPdf = (key) => lerBin("pdf:" + key);
export const salvarImagem = (hash, blob) => salvarBin("img:" + hash, blob);
export const lerImagem = (hash) => lerBin("img:" + hash);

// ---- sessão ----
export const salvarSessao = (registro) => escrever(SESSAO, (s) => s.put(registro));

export const listarSessoes = async () => {
  const r = await ler(SESSAO, (s) => s.getAll());
  return Array.isArray(r) ? r : [];
};

// tira o documento das duas stores. As imagens ficam: podem ser de outro documento —
// quem limpa as órfãs é coletarLixo, no boot.
export const apagarDoc = async (key) => {
  const a = await escrever(SESSAO, (s) => s.delete(key));
  const b = await escrever(ARQUIVOS, (s) => s.delete("pdf:" + key));
  return a && b;
};

export const limparTudo = async () => {
  const a = await escrever(SESSAO, (s) => s.clear());
  const b = await escrever(ARQUIVOS, (s) => s.clear());
  return a && b;
};

// remove imagens de carimbo que nenhum rascunho usa mais
export const coletarLixo = async (hashesEmUso) => {
  const chaves = await ler(ARQUIVOS, (s) => s.getAllKeys());
  if (!Array.isArray(chaves)) return false;
  const vivos = new Set(hashesEmUso || []);
  const orfas = chaves.filter((k) => typeof k === "string" && k.startsWith("img:") && !vivos.has(k.slice(4)));
  if (!orfas.length) return true;
  return escrever(ARQUIVOS, (s) => orfas.forEach((k) => s.delete(k)));
};
