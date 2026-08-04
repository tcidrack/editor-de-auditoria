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
  if (/should be at least (\d+) characters/i.test(m))
    return `A senha precisa ter pelo menos ${/at least (\d+)/i.exec(m)[1]} caracteres.`;
  if (/different from the old password/i.test(m)) return "A nova senha precisa ser diferente da atual.";
  if (/reauthentication/i.test(m)) return "Por segurança, entre de novo antes de trocar a senha.";
  // a policy do bucket sumir do storage.objects já aconteceu uma vez: sem policy o RLS nega
  // tudo, e a tela precisa dizer isso em vez de fingir que a pasta está vazia
  if (/row-level security|not authorized|unauthorized|403/i.test(m))
    return "Sem permissão para ler o seu carimbo — confira a policy do bucket.";
  if (/not found|404/i.test(m)) return "Bucket ou arquivo não encontrado no servidor.";
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

// troca a senha de quem está logado. Exige a senha atual de propósito: a sessão não expira
// sozinha, então sem isso quem passasse por uma máquina destravada tomaria a conta do colega.
// (O cadastro segue fechado — isto muda senha, não cria conta.)
export const trocarSenha = async (senhaAtual, novaSenha) => {
  if (!sb) return { erro: "Supabase não configurado." };
  const { data } = await sb.auth.getUser();
  const email = data && data.user && data.user.email;
  if (!email) return { erro: "Sessão expirada. Entre de novo." };
  const { error: erroLogin } = await sb.auth.signInWithPassword({ email, password: senhaAtual });
  if (erroLogin) return { erro: "Senha atual incorreta." };
  const { error } = await sb.auth.updateUser({ password: novaSenha });
  if (error) return { erro: traduzir(error.message) };
  return {};
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

// o que há na pasta do usuário (o RLS já limita a busca à pasta dele).
// Devolve { nomes, erro }: "pasta vazia" e "o servidor recusou" são coisas diferentes, e
// confundir as duas foi o que nos custou uma caçada inteira atrás de uma policy sumida.
const arquivosDoCarimbo = async (userId) => {
  const { data, error } = await sb.storage.from(BUCKET).list(userId);
  if (error) return { nomes: [], erro: traduzir(error.message) };
  if (!Array.isArray(data)) return { nomes: [], erro: "Resposta inesperada do servidor." };
  // .emptyFolderPlaceholder é criado pelo painel do Supabase — pasta com só ele é pasta vazia
  return { nomes: data.filter((o) => o && o.name && /\.(png|jpe?g)$/i.test(o.name)).map((o) => o.name) };
};

// devolve { url, erro }. Lista a pasta em vez de exigir o nome "carimbo.png": quando o admin
// sobe o carimbo pelo painel do Supabase, um arquivo com outro nome sumiria em silêncio.
export const lerCarimbo = async (userId) => {
  if (!sb) return { erro: "Supabase não configurado." };
  const { nomes, erro } = await arquivosDoCarimbo(userId);
  if (erro) return { erro };
  if (!nomes.length) return {}; // pasta vazia: não é falha, é carimbo ainda não enviado
  const { data, error } = await sb.storage.from(BUCKET).download(`${userId}/${nomes[0]}`);
  if (error) return { erro: traduzir(error.message) };
  if (!data) return { erro: "O arquivo do carimbo veio vazio." };
  try { return { url: await blobParaDataUrl(data) }; }
  catch { return { erro: "Não foi possível ler a imagem do carimbo." }; }
};

export const salvarCarimbo = async (userId, file) => {
  if (!sb) return { erro: "Supabase não configurado." };
  const { nomes: antigos } = await arquivosDoCarimbo(userId);
  const { error } = await sb.storage.from(BUCKET)
    .upload(caminhoCarimbo(userId), file, { upsert: true, contentType: file.type || "image/png" });
  if (error) return { erro: traduzir(error.message) };
  // a pasta fica com um arquivo só: sem isso, um carimbo subido pelo painel com outro nome
  // continuaria lá e não daria para saber qual dos dois é o válido
  const sobrando = antigos.filter((n) => n !== "carimbo.png").map((n) => `${userId}/${n}`);
  if (sobrando.length) await sb.storage.from(BUCKET).remove(sobrando);
  return lerCarimbo(userId);
};

export const apagarCarimbo = async (userId) => {
  if (!sb) return { erro: "Supabase não configurado." };
  const { nomes } = await arquivosDoCarimbo(userId);
  const alvos = nomes.length ? nomes.map((n) => `${userId}/${n}`) : [caminhoCarimbo(userId)];
  const { error } = await sb.storage.from(BUCKET).remove(alvos);
  return error ? { erro: traduzir(error.message) } : {};
};
