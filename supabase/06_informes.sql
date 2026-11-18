-- =====================================================================
-- GymTrack · Fase 6: informes de progreso
-- Pegar entero en Supabase → SQL Editor → Run (después de 01 a 05). Se puede volver a ejecutar.
-- =====================================================================
-- Cada informe es el texto (Markdown) que te devuelve Claude a partir de tus datos.
-- source = 'manual' (lo pegas tú) o 'auto' (si en el futuro se automatiza).

create table if not exists public.reports (
  id            text primary key default gen_random_uuid()::text,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  source        text not null default 'manual' check (source in ('manual', 'auto')),
  content       text not null check (char_length(content) between 1 and 60000),
  created_at    timestamptz not null default now()
);
create index if not exists reports_user_idx on public.reports(user_id, created_at desc);

alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant select, insert, update, delete on public.reports to authenticated;

drop policy if exists "own_select" on public.reports;
drop policy if exists "own_insert" on public.reports;
drop policy if exists "own_update" on public.reports;
drop policy if exists "own_delete" on public.reports;
create policy "own_select" on public.reports for select to authenticated using ((select auth.uid()) = user_id);
create policy "own_insert" on public.reports for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own_update" on public.reports for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own_delete" on public.reports for delete to authenticated using ((select auth.uid()) = user_id);

-- Comprobación: reports | true | 4
select c.relname as tabla, c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as politicas
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'reports';
