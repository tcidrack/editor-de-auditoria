-- ============================================================
-- Editor de Auditoria — estrutura no Supabase
-- Rode no SQL Editor do projeto. É idempotente: pode rodar de novo sem estragar nada.
--
-- É Postgres puro de propósito: migrar isto para um banco da Maida depois é pg_dump
-- mais a troca do src/conta.js, sem nada específico de fornecedor no caminho.
-- ============================================================

-- ---- perfis: nome e papel de cada auditor ----
-- O papel mora aqui, e não no bundle, porque é o que impede alguém de se promover a
-- técnico mexendo no JS do navegador.
create table if not exists public.perfis (
  id uuid primary key references auth.users on delete cascade,
  nome text not null,
  papel text not null check (papel in ('tecnico', 'administrativo')),
  criado_em timestamptz not null default now()
);

alter table public.perfis enable row level security;

drop policy if exists "le o proprio perfil" on public.perfis;
create policy "le o proprio perfil" on public.perfis
  for select using (auth.uid() = id);
-- sem policy de insert/update de propósito: quem cadastra auditor é o admin, pelo painel

-- ---- bucket dos carimbos (privado) ----
-- Caminho: <user_id>/carimbo.png — a primeira pasta é o dono, e é isso que a policy confere.
insert into storage.buckets (id, name, public)
values ('carimbos', 'carimbos', false)
on conflict (id) do update set public = false;

drop policy if exists "carimbo proprio" on storage.objects;
create policy "carimbo proprio" on storage.objects
  for all
  using (
    bucket_id = 'carimbos'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'carimbos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---- perfil criado junto com o usuário ----
-- Este projeto tinha dois triggers herdados de outra coisa (on_auth_user_created e
-- on_auth_user_created_email). Como rodavam AFTER INSERT na mesma transação, o erro deles
-- desfazia a criação do usuário e o painel só mostrava "Failed to create user: {}".
drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_created_email on auth.users;

create or replace function public.criar_perfil_novo_usuario()
returns trigger
language plpgsql
security definer          -- grava em public.perfis a partir do contexto do auth
set search_path = public
as $$
begin
  insert into public.perfis (id, nome, papel)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'nome'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Auditor'
    ),
    -- papel NUNCA sai do metadata: com cadastro público aberto, bastaria mandar
    -- papel='tecnico' na chamada de signup para se promover sozinho
    'administrativo'
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  -- o perfil é conveniência e não pode impedir a criação do usuário — foi exatamente
  -- assim que os triggers herdados derrubaram tudo com 500
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_perfil on auth.users;
create trigger on_auth_user_created_perfil
  after insert on auth.users
  for each row execute function public.criar_perfil_novo_usuario();

-- ============================================================
-- Cadastrar um auditor:
--   1. Authentication > Users > Add user: e-mail @maida e senha, "Auto Confirm User"
--      ligado. O perfil nasce junto, com papel 'administrativo' e o nome tirado do e-mail.
--   2. Ajuste o nome e, se for técnico, promova (pelo e-mail, sem copiar UUID):
--
--      update public.perfis
--         set nome = 'Nome do Auditor', papel = 'tecnico'
--       where id = (select id from auth.users where email = 'pessoa@maida.health');
--
--   Promover é manual de propósito: não há policy de insert/update em perfis, então
--   ninguém muda o próprio papel pela aplicação.
--
--   Vale também desligar o cadastro público em Authentication > Providers > Email
--   (o app não tem tela de criar conta; sem isso, qualquer um com a anon key cria a sua).
--
-- Conferir quem está cadastrado:
--      select u.email, p.nome, p.papel
--        from public.perfis p join auth.users u on u.id = p.id
--       order by p.nome;
--
-- Preencher perfil de usuário criado antes deste trigger existir:
--      insert into public.perfis (id, nome, papel)
--      select u.id, coalesce(nullif(split_part(u.email, '@', 1), ''), 'Auditor'), 'administrativo'
--        from auth.users u left join public.perfis p on p.id = u.id
--       where p.id is null;
-- ============================================================
