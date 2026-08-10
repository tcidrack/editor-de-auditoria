import { useState, useEffect, useRef } from "react";
import { LogIn, ShieldAlert, WifiOff, LockKeyhole } from "lucide-react";
import {
  configurado, entrar, sair, sessaoAtual, aoMudarSessao, lerPerfil,
} from "./conta";
import CampoSenha from "./CampoSenha";
import "./EditorAuditoria.css";

const LOGO_MAIDA =
  "https://maida.health/wp-content/themes/melhortema/assets/images/logo-light.svg";

const temaAtual = () =>
  (typeof localStorage !== "undefined" && localStorage.getItem("tema")) || "claro";

const Moldura = ({ children }) => (
  <div className={"app-shell flex flex-col tema-" + temaAtual()} style={{ background: "var(--bg)" }}>
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

// Portão de entrada. Estados:
//   naoConfigurado — faltam as variáveis do Supabase
//   carregando     — resolvendo a sessão guardada
//   instavel       — a sessão existe, mas o servidor não respondeu: NÃO é motivo para
//                    mandar ninguém para o login (ver o comentário de resolver)
//   fora           — sem sessão: tela de login inteira
//   reentrar       — a sessão caiu com o editor aberto: sobreposição por cima dele
//   dentro         — trabalhando
//
// O editor só monta em "dentro" e "reentrar" — ele lê localStorage e abre o IndexedDB já na
// montagem, então montar antes da sessão resolvida misturaria o trabalho de quem estava aqui antes.
export default function PortaoLogin({ children }) {
  // configurado é conhecido na carga do módulo: já começa no estado certo, sem piscar
  const [estado, setEstado] = useState(configurado ? "carregando" : "naoConfigurado");
  const [usuario, setUsuario] = useState(null);       // { id, nome, papel, email }
  const [semPerfil, setSemPerfil] = useState(false);
  const [erroServidor, setErroServidor] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [entrando, setEntrando] = useState(false);
  const [trocandoConta, setTrocandoConta] = useState(false); // confirmação do "outra conta"
  const emailRef = useRef(null);
  const senhaRef = useRef(null);

  // o callback do onAuthStateChange vive fora do render e enxergaria um `usuario` congelado
  // na primeira renderização — daí o espelho em ref
  const usuarioRef = useRef(null);
  const tentarDeNovo = useRef(null); // preenchido pelo efeito; usado pelo botão de "instavel"

  // resolve o usuário do Supabase para { id, nome, papel } lendo o perfil no banco
  useEffect(() => {
    if (!configurado) return;
    let vivo = true;
    let tentativa = 0;
    let timer = 0;

    const carregarPerfil = async (authUser) => {
      const { perfil, semPerfil: faltando, erro: falhou } = await lerPerfil(authUser.id);
      if (!vivo) return;
      if (perfil) {
        // o e-mail vem do auth, não de perfis: o editor grava a autoria no PDF exportado
        const u = { ...perfil, email: authUser.email || "" };
        usuarioRef.current = u;
        setUsuario(u); setSemPerfil(false); setErroServidor("");
        tentativa = 0;
        setEstado("dentro");
        return;
      }
      // conta sem linha em perfis: é cadastro faltando, e só quem administra resolve
      if (faltando) { usuarioRef.current = null; setSemPerfil(true); setEstado("fora"); return; }
      // falha de rede ou do servidor. A sessão continua valendo — insistir é o certo,
      // deslogar seria punir o auditor por uma oscilação de Wi-Fi.
      setErroServidor(falhou);
      setEstado("instavel");
      clearTimeout(timer);
      const espera = Math.min(30000, 1000 * 2 ** tentativa);
      tentativa++;
      timer = setTimeout(() => { if (vivo) carregarPerfil(authUser); }, espera);
      tentarDeNovo.current = () => { clearTimeout(timer); tentativa = 0; carregarPerfil(authUser); };
    };

    // Chamado a CADA evento de auth. E os eventos são muitos: o auth-js emite SIGNED_IN
    // toda vez que a aba volta a ficar visível e TOKEN_REFRESHED a cada renovação de token.
    // Tratar isso como "login novo" — indo ao banco buscar o perfil de novo — é o que
    // deslogava quem voltava de uma suspensão: o notebook acorda, a aba fica visível antes
    // do Wi-Fi reconectar, a consulta falha e o editor ia embora com o trabalho junto.
    const resolver = async (_evento, authUser) => {
      if (!vivo) return;

      if (!authUser) {
        clearTimeout(timer);
        // já houve um auditor nesta página: o editor NÃO desmonta. Ele fica montado atrás
        // da sobreposição de reentrada, com a fila de PDFs e as marcações intactas.
        if (usuarioRef.current) {
          setEmail(usuarioRef.current.email || "");
          setSenha(""); setErro(""); setTrocandoConta(false);
          setEstado("reentrar");
          return;
        }
        setUsuario(null); setSemPerfil(false); setEstado("fora");
        return;
      }

      // mesmo auditor de antes: nome e papel já estão em memória. Não vai ao banco — é
      // justamente isso que torna o refoco de aba e a reentrada imunes a uma queda de rede.
      if (usuarioRef.current && usuarioRef.current.id === authUser.id) {
        clearTimeout(timer);
        setSenha(""); setErro(""); setErroServidor("");
        setEstado("dentro"); // no-op quando já estava dentro
        return;
      }

      await carregarPerfil(authUser);
    };

    sessaoAtual().then((u) => resolver("SESSAO_INICIAL", u));
    const cancelar = aoMudarSessao(resolver);
    return () => { vivo = false; clearTimeout(timer); cancelar(); };
  }, []);

  useEffect(() => { if (estado === "fora" && emailRef.current) emailRef.current.focus(); }, [estado]);
  useEffect(() => { if (estado === "reentrar" && senhaRef.current) senhaRef.current.focus(); }, [estado]);

  const enviar = async (e) => {
    e.preventDefault();
    if (entrando) return;
    setEntrando(true); setErro("");
    const { erro: falhou } = await entrar(email, senha);
    if (falhou) { setErro(falhou); setSenha(""); }
    setEntrando(false); // no sucesso, aoMudarSessao leva para "dentro"
  };

  // desiste da sessão anterior e volta para a tela de login inteira. Descarta o que está
  // em memória — daí a confirmação; o rascunho no navegador continua guardado.
  const trocarDeConta = () => {
    usuarioRef.current = null;
    setUsuario(null); setSemPerfil(false); setTrocandoConta(false);
    setEmail(""); setSenha(""); setErro("");
    setEstado("fora");
  };

  const campos = (
    <>
      <label className="block text-xs text-[var(--muted)] mb-1">E-mail</label>
      <input ref={emailRef} type="email" autoComplete="username" value={email}
        readOnly={estado === "reentrar"}
        onChange={(e) => { setEmail(e.target.value); setErro(""); }}
        className={"w-full mb-3 px-2.5 py-2 rounded-lg border border-[var(--border)] "
          + "bg-[var(--surface)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)] "
          + (estado === "reentrar" ? "opacity-70 cursor-default" : "")} />

      <CampoSenha ref={senhaRef} label="Senha" autoComplete="current-password" value={senha}
        onChange={(e) => { setSenha(e.target.value); setErro(""); }} />

      {erro && <div className="mt-2 text-xs text-red-500">{erro}</div>}

      <button type="submit" disabled={!email || !senha || entrando}
        className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg
          text-sm font-semibold bg-[var(--accent)] text-[var(--accent-contrast)]
          hover:opacity-90 disabled:opacity-40">
        <LogIn className="w-4 h-4" />{entrando ? "Entrando…" : "Entrar"}
      </button>
    </>
  );

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

  // a sessão está válida; quem não respondeu foi o servidor. Fica insistindo em vez de
  // apresentar um formulário de login que não resolveria nada.
  if (estado === "instavel")
    return (
      <Moldura>
        <b className="flex items-center gap-2 mb-2">
          <WifiOff className="w-4 h-4 text-[var(--accent)]" />
          Sem resposta do servidor
        </b>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          Você continua conectado — só não conseguimos carregar o seu perfil agora. Estamos
          tentando de novo sozinhos; confira a rede se demorar.
        </p>
        {erroServidor && <p className="mt-2 text-xs text-[var(--muted)]">{erroServidor}</p>}
        <button onClick={() => tentarDeNovo.current && tentarDeNovo.current()}
          className="mt-3 w-full px-3 py-2 rounded-lg text-sm font-semibold
            bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90">
          Tentar de novo
        </button>
      </Moldura>
    );

  // "dentro" e "reentrar" devolvem a MESMA forma de árvore de propósito: o editor tem que
  // ficar no mesmo lugar nos dois. Trocar um `children(...)` solto por um fragmento mudaria
  // o tipo do elemento raiz, e o React remontaria o editor — que é exatamente o que a
  // sobreposição existe para evitar. Aqui o filho 0 é sempre o editor.
  if (estado === "dentro" || estado === "reentrar") {
    const reentrando = estado === "reentrar";
    return (
      <>
        {children(usuario, sair, reentrando)}
        {reentrando && (
          // não fecha por clique fora nem por Esc: sair daqui é entrar de novo ou trocar
          // de conta de propósito
          <div className={"fixed inset-0 z-[100] flex items-center justify-center p-4 tema-" + temaAtual()}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="relative w-full max-w-sm rounded-xl shadow-2xl border p-5
              bg-[var(--surface)] border-[var(--border)] text-[var(--text)]">
              <form onSubmit={enviar}>
                <b className="flex items-center gap-2 mb-1">
                  <LockKeyhole className="w-4 h-4 text-[var(--accent)]" />
                  Sua sessão expirou
                </b>
                <p className="text-xs text-[var(--muted)] mb-3 leading-relaxed">
                  Entre de novo para continuar. <b>Seu trabalho continua aqui</b> — os documentos
                  abertos e as marcações não foram perdidos.
                </p>
                {campos}
              </form>

              {!trocandoConta ? (
                <button onClick={() => setTrocandoConta(true)}
                  className="mt-3 w-full text-[11px] text-[var(--muted)] hover:underline">
                  Entrar com outra conta
                </button>
              ) : (
                <div className="mt-3 pt-3 border-t border-[var(--border)]">
                  <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                    Trocar de conta fecha os documentos abertos. As marcações ficam no rascunho
                    deste navegador e voltam a ser oferecidas quando <b>{usuario && usuario.nome}</b> entrar
                    de novo.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button onClick={trocarDeConta}
                      className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold
                        bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90">
                      Trocar mesmo assim
                    </button>
                    <button onClick={() => setTrocandoConta(false)}
                      className="flex-1 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)]
                        text-[var(--text)] hover:bg-[var(--hover)]">
                      Voltar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </>
    );
  }

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

        {campos}

        <p className="mt-4 pt-3 border-t border-[var(--border)] text-[11px] text-[var(--muted)] leading-relaxed">
          Os PDFs que você abrir <b>não saem deste navegador</b>: a marcação acontece toda no seu
          computador. O que fica no servidor é a sua conta e o seu carimbo.
        </p>
      </form>
    </Moldura>
  );
}
