// ---- gestao-auditores: a tela "Gerenciar auditores" das gestoras ----
//
// Criar login e trocar senha de outra pessoa exige a service_role key, que ignora o RLS e por
// isso NUNCA pode ir para o navegador. Ela mora só aqui: o próprio Supabase injeta
// SUPABASE_SERVICE_ROLE_KEY nas Edge Functions, então nenhuma chave passa pelo repositório.
//
// Quem chama é o app, com o token da sessão. Toda ação confere primeiro se esse usuário é
// gestor (perfis.gestor) — o item no menu é só conveniência; a porta de verdade é esta.
//
// Publicar: painel > Edge Functions > Deploy a new function > Via Editor (nome
// gestao-auditores), ou `supabase functions deploy gestao-auditores --project-ref <ref>`.
import { createClient } from "jsr:@supabase/supabase-js@2";

const DOMINIO = "@maida.health";
const PAPEIS = ["tecnico", "administrativo"];
const SENHA_MIN = 6;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const responder = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const falha = (erro: string, status = 400) => responder({ erro }, status);

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// o Supabase pode exigir mais que o nosso mínimo (Authentication > Providers > Email)
const senhaRecusada = (msg: string) => {
  const m = /at least (\d+)/i.exec(msg);
  if (m) return `A senha precisa ter pelo menos ${m[1]} caracteres.`;
  return /password/i.test(msg) ? "O servidor recusou esta senha (fraca demais ou repetida). Escolha outra." : "";
};

const validarSenha = (s: unknown) =>
  typeof s === "string" && s.length >= SENHA_MIN ? "" : `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`;

// todos os logins, página a página (o listUsers devolve no máximo perPage por vez)
const todosUsuarios = async () => {
  const out = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 1000) return out;
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return falha("Método não permitido.", 405);

  try {
    // ---- quem está chamando, e se é gestor ----
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return falha("Sessão ausente. Entre de novo.", 401);
    const { data: quem, error: erroQuem } = await admin.auth.getUser(jwt);
    if (erroQuem || !quem?.user) return falha("Sessão expirada. Entre de novo.", 401);
    const { data: perfilQuem } = await admin.from("perfis").select("gestor").eq("id", quem.user.id).maybeSingle();
    if (!perfilQuem?.gestor) return falha("Só as gestoras podem gerenciar auditores.", 403);

    const corpo = await req.json().catch(() => ({}));
    const acao = corpo?.acao;

    if (acao === "listar") {
      const [usuarios, { data: perfis, error }] = await Promise.all([
        todosUsuarios(),
        admin.from("perfis").select("id, nome, papel, gestor"),
      ]);
      if (error) throw error;
      const porId = new Map((perfis || []).map((p) => [p.id, p]));
      const lista = usuarios.map((u) => {
        const p = porId.get(u.id);
        return {
          id: u.id, email: u.email || "",
          nome: p?.nome || "", papel: p?.papel || "", gestor: !!p?.gestor, semPerfil: !p,
          primeiroAcesso: !!u.user_metadata?.trocar_senha,
          ultimoAcesso: u.last_sign_in_at || null,
        };
      }).sort((a, b) => (a.nome || a.email).localeCompare(b.nome || b.email, "pt-BR"));
      return responder({ auditores: lista });
    }

    if (acao === "criar") {
      const email = String(corpo.email || "").trim().toLowerCase();
      const nome = String(corpo.nome || "").trim().replace(/\s+/g, " ");
      const papel = String(corpo.papel || "");
      if (!/^[a-z0-9._%+-]+@maida\.health$/.test(email)) return falha(`Use um e-mail ${DOMINIO}.`);
      if (!nome) return falha("Informe o nome do auditor.");
      if (!PAPEIS.includes(papel)) return falha("Escolha o papel: técnico ou administrativo.");
      const ruim = validarSenha(corpo.senha);
      if (ruim) return falha(ruim);

      const { data, error } = await admin.auth.admin.createUser({
        email, password: corpo.senha, email_confirm: true,
        user_metadata: { nome, trocar_senha: true },
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) return falha("Este e-mail já tem acesso ao Editor.", 409);
        if (senhaRecusada(error.message)) return falha(senhaRecusada(error.message));
        throw error;
      }
      // o trigger cria a linha como administrativo; aqui ficam o nome e o papel escolhidos
      const { error: erroPerfil } = await admin.from("perfis")
        .upsert({ id: data.user.id, nome, papel }, { onConflict: "id" });
      if (erroPerfil) throw erroPerfil;
      return responder({ ok: true, id: data.user.id });
    }

    if (acao === "redefinir") {
      const ruim = validarSenha(corpo.senha);
      if (ruim) return falha(ruim);
      const { data: alvo, error: erroAlvo } = await admin.auth.admin.getUserById(String(corpo.id || ""));
      if (erroAlvo || !alvo?.user) return falha("Auditor não encontrado.", 404);
      const { error } = await admin.auth.admin.updateUserById(alvo.user.id, {
        password: corpo.senha,
        user_metadata: { ...(alvo.user.user_metadata || {}), trocar_senha: true },
      });
      if (error) {
        if (senhaRecusada(error.message)) return falha(senhaRecusada(error.message));
        throw error;
      }
      return responder({ ok: true });
    }

    if (acao === "papel") {
      const papel = String(corpo.papel || "");
      if (!PAPEIS.includes(papel)) return falha("Papel inválido.");
      const { data, error } = await admin.from("perfis").update({ papel }).eq("id", String(corpo.id || "")).select("id");
      if (error) throw error;
      if (!data?.length) return falha("Auditor sem perfil cadastrado.", 404);
      return responder({ ok: true });
    }

    return falha("Ação desconhecida.");
  } catch (e) {
    console.error("gestao-auditores:", e);
    return falha("Erro no servidor: " + ((e as Error)?.message || String(e)), 500);
  }
});
