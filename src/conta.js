// ---- única porta de saída para o Supabase ----
// Nenhum outro arquivo importa @supabase/supabase-js. Isso é de propósito: migrar para um
// banco da Maida depois vira a troca deste arquivo, e não uma caça a chamadas espalhadas.
//
// A anon key vai no bundle e não tem problema: ela é pública por design, e quem protege os
// dados é o RLS do banco. A service_role key NUNCA pode entrar aqui nem no repositório.
import { createClient } from "@supabase/supabase-js";

export const PAPEIS = {
  tecnico: { label: "Auditor técnico", carimbo: true },
  administrativo: { label: "Auditor administrativo", carimbo: false },
};
export const usaCarimbo = (usuario) =>
  !!(usuario && PAPEIS[usuario.papel] && PAPEIS[usuario.papel].carimbo);

const URL_SB = import.meta.env.VITE_SUPABASE_URL;
const ANON_SB = import.meta.env.VITE_SUPABASE_ANON_KEY;

// sem as variáveis o app não pode explodir na importação: a tela mostra o recado e pronto
export const configurado = !!(URL_SB && ANON_SB);
const sb = configurado ? createClient(URL_SB, ANON_SB) : null;

const BUCKET = "carimbos";
const caminhoCarimbo = (userId) => `${userId}/carimbo.png`;

// o Supabase responde em inglês; o auditor não tem que ler isso
const traduzir = (msg) => {
  const m = String(msg || "");
  if (/invalid login credentials/i.test(m)) return "E-mail ou senha incorretos.";
  if (/email not confirmed/i.test(m)) return "Este e-mail ainda não foi confirmado.";
  if (/too many requests|rate limit/i.test(m)) return "Muitas tentativas seguidas. Espere um pouco e tente de novo.";
  if (/failed to fetch|network/i.test(m)) return "Sem conexão com o servidor. Verifique a rede.";
  return m || "Não foi possível entrar.";
};

// ---- sessão ----
export const entrar = async (email, senha) => {
  if (!sb) return { erro: "Supabase não configurado." };
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password: senha });
  if (error) return { erro: traduzir(error.message) };
  return { usuario: data.user };
};

export const sair = async () => { if (sb) await sb.auth.signOut(); };

export const sessaoAtual = async () => {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return (data && data.session && data.session.user) || null;
};

// devolve a função de cancelar, para o efeito do portão se desinscrever
export const aoMudarSessao = (cb) => {
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((_evento, sessao) => cb((sessao && sessao.user) || null));
  return () => { try { data.subscription.unsubscribe(); } catch { /* já cancelado */ } };
};

// ---- perfil (nome e papel) ----
// o papel vem do banco, não do bundle: é o que impede alguém de se promover no devtools
export const lerPerfil = async (userId) => {
  if (!sb) return null;
  const { data, error } = await sb.from("perfis").select("nome, papel").eq("id", userId).single();
  if (error || !data) return null;
  return { id: userId, nome: data.nome, papel: data.papel };
};

// ---- carimbo (bucket privado, uma pasta por usuário) ----
const blobParaDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// devolve data-URL (formato que addStamp e o rascunho já consomem) ou null se não houver
export const lerCarimbo = async (userId) => {
  if (!sb) return null;
  const { data, error } = await sb.storage.from(BUCKET).download(caminhoCarimbo(userId));
  if (error || !data) return null;
  try { return await blobParaDataUrl(data); } catch { return null; }
};

export const salvarCarimbo = async (userId, file) => {
  if (!sb) return { erro: "Supabase não configurado." };
  const { error } = await sb.storage.from(BUCKET)
    .upload(caminhoCarimbo(userId), file, { upsert: true, contentType: file.type || "image/png" });
  if (error) return { erro: traduzir(error.message) };
  return { url: await lerCarimbo(userId) };
};

export const apagarCarimbo = async (userId) => {
  if (!sb) return { erro: "Supabase não configurado." };
  const { error } = await sb.storage.from(BUCKET).remove([caminhoCarimbo(userId)]);
  return error ? { erro: traduzir(error.message) } : {};
};
