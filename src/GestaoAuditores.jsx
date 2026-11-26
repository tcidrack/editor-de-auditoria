// ---- "Gerenciar auditores": as gestoras criam e cuidam dos acessos ----
// Antes, cada auditor novo era um usuário criado no painel do Supabase mais um SQL para o
// nome e o papel. Aqui a gestora faz isso sozinha. Quem executa de verdade é a Edge Function
// gestao-auditores (conta.js → gestaoAuditores), que confere se quem pede é gestor.
//
// A senha de primeiro acesso fica só no estado desta janela: não vai para o localStorage.
// O auditor entra com ela e o portão de login o obriga a criar a própria.
import { useState, useEffect, useMemo } from "react";
import { X, UserPlus, KeyRound, RefreshCw, Search } from "lucide-react";
import { PAPEIS, gestaoAuditores } from "./conta";
import CampoSenha from "./CampoSenha";

const DOMINIO = "@maida.health";

// "thalison.silva" → "Thalison Silva"; "raquel_feijao2" → "Raquel Feijao"
export const nomeDoEmail = (email) =>
  String(email || "").split("@")[0].replace(/\d+/g, "").split(/[._-]+/).filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(" ");

// a gestora digita só o começo ("thalison.silva") ou o e-mail inteiro
const emailCompleto = (v) => {
  const s = String(v || "").trim().toLowerCase();
  return !s ? "" : s.includes("@") ? s : s + DOMINIO;
};

const dataCurta = (iso) => {
  if (!iso) return "nunca entrou";
  try { return "último acesso " + new Date(iso).toLocaleDateString("pt-BR"); } catch { return ""; }
};

const campo = "w-full px-2.5 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] " +
  "text-[var(--text)] text-sm focus:outline-none focus:border-[var(--accent)]";

function SeletorPapel({ valor, onEscolher, disabled }) {
  return (
    <div className="flex rounded-md border border-[var(--border)] overflow-hidden text-xs">
      {Object.entries(PAPEIS).map(([k, p]) => (
        <button key={k} type="button" disabled={disabled} onClick={() => onEscolher(k)}
          className={`flex-1 px-2 py-1.5 whitespace-nowrap ${valor === k
            ? "bg-[var(--accent)] text-[var(--accent-contrast)] font-semibold"
            : "text-[var(--muted)] hover:bg-[var(--hover)]"} disabled:opacity-50`}>
          {p.label.replace("Auditor ", "")}
        </button>
      ))}
    </div>
  );
}

export default function GestaoAuditores({ onFechar }) {
  // ---- criar ----
  const [email, setEmail] = useState("");
  const [nome, setNome] = useState("");
  const [nomeEditado, setNomeEditado] = useState(false); // a gestora mexeu: para de seguir o e-mail
  const [papel, setPapel] = useState("administrativo");
  const [senha, setSenha] = useState("");
  const [criando, setCriando] = useState(false);
  const [erroCriar, setErroCriar] = useState("");
  const [criado, setCriado] = useState(null); // { email, nome } — recado para repassar

  // ---- lista ----
  const [lista, setLista] = useState(null);
  const [erroLista, setErroLista] = useState("");
  const [busca, setBusca] = useState("");
  const [pendente, setPendente] = useState(null); // { id, tipo: "senha" | "papel", papel? }
  const [ocupado, setOcupado] = useState(""); // id em andamento
  const [aviso, setAviso] = useState(null); // { id, texto, erro? }

  const carregar = async () => {
    setErroLista("");
    const r = await gestaoAuditores("listar");
    if (r.erro) { setErroLista(r.erro); return; }
    setLista(r.auditores || []);
  };
  useEffect(() => { carregar(); }, []);

  const mudarEmail = (v) => {
    setEmail(v); setErroCriar(""); setCriado(null);
    if (!nomeEditado) setNome(nomeDoEmail(v));
  };

  const emailFinal = emailCompleto(email);
  const emailOk = /^[a-z0-9._%+-]+@maida\.health$/.test(emailFinal);
  const jaExiste = !!(lista && lista.some((a) => a.email.toLowerCase() === emailFinal));

  const criar = async (e) => {
    e.preventDefault();
    if (criando) return;
    if (!emailOk) return setErroCriar(`Use um e-mail ${DOMINIO}.`);
    if (jaExiste) return setErroCriar("Este e-mail já tem acesso ao Editor.");
    if (!nome.trim()) return setErroCriar("Informe o nome do auditor.");
    if (senha.length < 6) return setErroCriar("A senha de primeiro acesso precisa ter pelo menos 6 caracteres.");
    setCriando(true); setErroCriar("");
    const r = await gestaoAuditores("criar", { email: emailFinal, nome: nome.trim(), papel, senha });
    setCriando(false);
    if (r.erro) return setErroCriar(r.erro);
    setCriado({ email: emailFinal, nome: nome.trim(), papel });
    setEmail(""); setNome(""); setNomeEditado(false); // a senha fica: serve para o próximo
    carregar();
  };

  const executar = async (a) => {
    const p = pendente;
    setPendente(null); setOcupado(a.id); setAviso(null);
    const r = p.tipo === "senha"
      ? await gestaoAuditores("redefinir", { id: a.id, senha })
      : await gestaoAuditores("papel", { id: a.id, papel: p.papel });
    setOcupado("");
    if (r.erro) return setAviso({ id: a.id, texto: r.erro, erro: true });
    setAviso({ id: a.id, texto: p.tipo === "senha"
      ? "Senha redefinida. Na próxima entrada, o auditor cria uma nova."
      : "Papel alterado. Vale a partir da próxima entrada do auditor." });
    carregar();
  };

  const filtrada = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (lista || []).filter((a) => !q || a.nome.toLowerCase().includes(q) || a.email.toLowerCase().includes(q));
  }, [lista, busca]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onFechar(); } }}>
      <div className="absolute inset-0 bg-black/50" onClick={onFechar} />
      <div className="relative bg-[var(--surface)] rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh]
        flex flex-col border border-[var(--border)] text-[var(--text)]">
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
          <b>Gerenciar auditores</b>
          <button onClick={onFechar} title="Fechar (Esc)"
            className="w-8 h-8 flex items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto maida-scroll">
          {/* ---- novo auditor ---- */}
          <form onSubmit={criar} className="px-5 py-4 border-b border-[var(--border)]">
            <b className="flex items-center gap-2 text-sm mb-3">
              <UserPlus className="w-4 h-4 text-[var(--accent)]" />Novo auditor
            </b>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">E-mail</label>
                <div className="flex items-center rounded-lg border border-[var(--border)] focus-within:border-[var(--accent)]">
                  <input value={email} onChange={(e) => mudarEmail(e.target.value)} autoComplete="off"
                    placeholder="nome.sobrenome" autoFocus
                    className="flex-1 min-w-0 px-2.5 py-2 rounded-lg bg-transparent text-sm text-[var(--text)] focus:outline-none" />
                  {!email.includes("@") && <span className="pr-2.5 text-sm text-[var(--muted)]">{DOMINIO}</span>}
                </div>
                {jaExiste && <div className="mt-1 text-[11px] text-red-500">Este e-mail já tem acesso.</div>}
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Nome</label>
                <input value={nome} className={campo} autoComplete="off"
                  onChange={(e) => { setNome(e.target.value); setNomeEditado(true); setErroCriar(""); }} />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Papel</label>
                <SeletorPapel valor={papel} onEscolher={setPapel} />
              </div>
              <div>
                <CampoSenha label="Senha de primeiro acesso" autoComplete="new-password" value={senha}
                  onChange={(e) => { setSenha(e.target.value); setErroCriar(""); }} />
              </div>
            </div>
            <p className="mt-2 text-[11px] text-[var(--muted)] leading-relaxed">
              O auditor entra com esta senha e, no primeiro acesso, cria a própria. A mesma senha é
              usada no "Redefinir senha" da lista abaixo.
            </p>
            {erroCriar && <div className="mt-2 text-xs text-red-500">{erroCriar}</div>}
            {criado && (
              <div className="mt-2 p-2.5 rounded-lg text-xs leading-relaxed border border-[var(--border)] bg-[var(--panel)]">
                Acesso criado para <b>{criado.nome}</b> ({PAPEIS[criado.papel].label.toLowerCase()}). Passe ao
                auditor: e-mail <b>{criado.email}</b> e a senha de primeiro acesso.
              </div>
            )}
            <button type="submit" disabled={!email || !nome || !senha || criando}
              className="mt-3 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold
                bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40">
              <UserPlus className="w-4 h-4" />{criando ? "Criando…" : "Criar acesso"}
            </button>
          </form>

          {/* ---- lista ---- */}
          <div className="px-5 py-4">
            <div className="flex items-center gap-2 mb-3">
              <b className="text-sm flex-1">Auditores{lista ? ` (${lista.length})` : ""}</b>
              <div className="relative w-48">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar"
                  className={campo + " pl-7 py-1.5 text-xs"} />
              </div>
              <button onClick={carregar} title="Atualizar a lista"
                className="w-8 h-8 flex items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {erroLista && <div className="text-xs text-red-500">{erroLista}</div>}
            {!lista && !erroLista && <div className="text-xs text-[var(--muted)]">Carregando…</div>}

            <div className="flex flex-col divide-y divide-[var(--border)]">
              {filtrada.map((a) => {
                const p = pendente && pendente.id === a.id ? pendente : null;
                return (
                  <div key={a.id} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <div className="flex-1 min-w-[12rem]">
                        <div className="text-sm font-semibold truncate">
                          {a.nome || a.email}
                          {a.gestor && <span className="ml-1.5 text-[10px] font-normal text-[var(--muted)]">gestão</span>}
                        </div>
                        <div className="text-xs text-[var(--muted)] truncate">
                          {a.email} · {a.primeiroAcesso
                            ? <span className="text-amber-600 font-semibold">aguardando 1º acesso</span>
                            : dataCurta(a.ultimoAcesso)}
                        </div>
                      </div>
                      {a.semPerfil ? (
                        <span className="text-xs text-red-500">sem perfil cadastrado</span>
                      ) : (
                        <div className="w-48">
                          <SeletorPapel valor={p && p.tipo === "papel" ? p.papel : a.papel} disabled={ocupado === a.id}
                            onEscolher={(k) => { setAviso(null); setPendente(k === a.papel ? null : { id: a.id, tipo: "papel", papel: k }); }} />
                        </div>
                      )}
                      <button disabled={ocupado === a.id}
                        onClick={() => { setAviso(null); setPendente({ id: a.id, tipo: "senha" }); }}
                        className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs border border-[var(--border)]
                          text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50">
                        <KeyRound className="w-3.5 h-3.5" />Redefinir senha
                      </button>
                    </div>

                    {p && (
                      <div className="mt-2 p-2.5 rounded-lg text-xs border border-[var(--border)] bg-[var(--panel)]">
                        {p.tipo === "senha" ? (
                          senha.length >= 6
                            ? <>A senha de <b>{a.nome || a.email}</b> volta para a senha de primeiro acesso digitada acima, e ele cria uma nova ao entrar.</>
                            : <>Digite a senha de primeiro acesso no campo acima (mínimo 6 caracteres) para redefinir.</>
                        ) : (
                          <>Mudar <b>{a.nome || a.email}</b> para <b>{PAPEIS[p.papel].label.toLowerCase()}</b>?</>
                        )}
                        <div className="mt-2 flex gap-2">
                          <button disabled={p.tipo === "senha" && senha.length < 6} onClick={() => executar(a)}
                            className="px-3 py-1 rounded-md font-semibold bg-[var(--accent)] text-[var(--accent-contrast)]
                              hover:opacity-90 disabled:opacity-40">
                            Confirmar
                          </button>
                          <button onClick={() => setPendente(null)}
                            className="px-3 py-1 rounded-md border border-[var(--border)] hover:bg-[var(--hover)]">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                    {ocupado === a.id && <div className="mt-1 text-xs text-[var(--muted)]">Salvando…</div>}
                    {aviso && aviso.id === a.id && (
                      <div className={"mt-1 text-xs " + (aviso.erro ? "text-red-500" : "text-[var(--muted)]")}>{aviso.texto}</div>
                    )}
                  </div>
                );
              })}
              {lista && !filtrada.length && <div className="py-2 text-xs text-[var(--muted)]">Ninguém encontrado.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
