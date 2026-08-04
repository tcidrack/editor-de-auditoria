import { useState, useEffect, useRef } from "react";
import { LogIn, ShieldAlert } from "lucide-react";
import {
  configurado, entrar, sair, sessaoAtual, aoMudarSessao, lerPerfil,
} from "./conta";
import "./EditorAuditoria.css";

const LOGO_MAIDA =
  "https://maida.health/wp-content/themes/melhortema/assets/images/logo-light.svg";

const Moldura = ({ children }) => {
  const tema = (typeof localStorage !== "undefined" && localStorage.getItem("tema")) || "claro";
  return (
    <div className={"app-shell flex flex-col tema-" + tema} style={{ background: "var(--bg)" }}>
      <div className="flex items-center gap-3 px-4 py-3">
        <img src={LOGO_MAIDA} alt="Maida" className="h-7" />
        <div className="flex flex-col leading-tight text-white">
          <b className="text-sm">Editor de Auditoria</b>
          <span className="text-xs opacity-80">Auditoria médica — marcação de cortes em lote</span>
        </div>
      </div>
      <div className="flex-1 flex items-start sm:items-center justify-center p-4 overflow-auto maida-scroll">
        <div className="w-full max-w-sm rounded-xl shadow-2xl border p-5
          bg-[var(--surface)] border-[var(--border)] text-[var(--text)]">
          {children}
        </div>
      </div>
    </div>
  );
};

// Portão de entrada. Três estados: resolvendo a sessão, sem sessão (login) e dentro.
// O editor só monta no terceiro — ele lê localStorage e abre o IndexedDB já na montagem,
// então montar antes da sessão resolvida misturaria o trabalho de quem estava aqui antes.
export default function PortaoLogin({ children }) {
  // configurado é conhecido na carga do módulo: já começa no estado certo, sem piscar
  const [estado, setEstado] = useState(configurado ? "carregando" : "naoConfigurado");
  const [usuario, setUsuario] = useState(null);       // { id, nome, papel }
  const [semPerfil, setSemPerfil] = useState(false);
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [entrando, setEntrando] = useState(false);
  const emailRef = useRef(null);

  // resolve o usuário do Supabase para { id, nome, papel } lendo o perfil no banco
  useEffect(() => {
    if (!configurado) return;
    let vivo = true;
    const resolver = async (authUser) => {
      if (!vivo) return;
      if (!authUser) { setUsuario(null); setSemPerfil(false); setEstado("fora"); return; }
      const perfil = await lerPerfil(authUser.id);
      if (!vivo) return;
      if (!perfil) { setSemPerfil(true); setEstado("fora"); return; } // conta sem linha em perfis
      setUsuario(perfil); setSemPerfil(false); setEstado("dentro");
    };
    sessaoAtual().then(resolver);
    const cancelar = aoMudarSessao(resolver);
    return () => { vivo = false; cancelar(); };
  }, []);

  useEffect(() => { if (estado === "fora" && emailRef.current) emailRef.current.focus(); }, [estado]);

  const enviar = async (e) => {
    e.preventDefault();
    if (entrando) return;
    setEntrando(true); setErro("");
    const { erro: falhou } = await entrar(email, senha);
    if (falhou) { setErro(falhou); setSenha(""); }
    setEntrando(false); // no sucesso, aoMudarSessao leva para "dentro"
  };

  if (estado === "naoConfigurado")
    return (
      <Moldura>
        <b className="flex items-center gap-2 mb-2">
          <ShieldAlert className="w-4 h-4 text-[var(--accent)]" />
          Configuração ausente
        </b>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          Faltam as variáveis <b>VITE_SUPABASE_URL</b> e <b>VITE_SUPABASE_ANON_KEY</b>. Em
          desenvolvimento elas ficam no <b>.env.local</b>; na Vercel, nas variáveis de ambiente
          do projeto.
        </p>
      </Moldura>
    );

  if (estado === "carregando")
    return <Moldura><p className="text-sm text-[var(--muted)]">Verificando o acesso…</p></Moldura>;

  if (estado === "dentro") return children(usuario, sair);

  return (
    <Moldura>
      <form onSubmit={enviar}>
        <b className="block mb-1">Entrar</b>
        <p className="text-xs text-[var(--muted)] mb-3 leading-relaxed">
          Use o seu e-mail da Maida.
        </p>

        {semPerfil && (
          <div className="mb-3 p-2.5 rounded-lg text-xs leading-relaxed
            border border-[var(--border)] bg-[var(--panel)]">
            A conta entrou, mas ainda não tem perfil cadastrado (nome e papel). Peça a quem
            administra o Editor para criar a sua linha na tabela <b>perfis</b>.
          </div>
        )}

        <label className="block text-xs text-[var(--muted)] mb-1">E-mail</label>
        <input ref={emailRef} type="email" autoComplete="username" value={email}
          onChange={(e) => { setEmail(e.target.value); setErro(""); }}
          className="w-full mb-3 px-2.5 py-2 rounded-lg
            border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
            focus:outline-none focus:border-[var(--accent)]" />

        <label className="block text-xs text-[var(--muted)] mb-1">Senha</label>
        <input type="password" autoComplete="current-password" value={senha}
          onChange={(e) => { setSenha(e.target.value); setErro(""); }}
          className="w-full px-2.5 py-2 rounded-lg
            border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]
            focus:outline-none focus:border-[var(--accent)]" />

        {erro && <div className="mt-2 text-xs text-red-500">{erro}</div>}

        <button type="submit" disabled={!email || !senha || entrando}
          className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg
            text-sm font-semibold bg-[var(--accent)] text-[var(--accent-contrast)]
            hover:opacity-90 disabled:opacity-40">
          <LogIn className="w-4 h-4" />{entrando ? "Entrando…" : "Entrar"}
        </button>

        <p className="mt-4 pt-3 border-t border-[var(--border)] text-[11px] text-[var(--muted)] leading-relaxed">
          Os PDFs que você abrir <b>não saem deste navegador</b>: a marcação acontece toda no seu
          computador. O que fica no servidor é a sua conta e o seu carimbo.
        </p>
      </form>
    </Moldura>
  );
}
