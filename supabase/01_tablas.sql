-- =====================================================================
-- GymTrack · Fase 1 · Tablas y seguridad (Row Level Security)
-- Pegar entero en Supabase → SQL Editor → Run. Se puede volver a ejecutar.
-- =====================================================================
-- Notas:
--  * Los "id" son texto: la web y el reloj crean el id ellos mismos. Así, si
--    el reloj reenvía una serie por falta de conexión, no se duplica.
--  * user_id se rellena solo con el usuario que ha iniciado sesión.
--  * Las claves foráneas incluyen user_id: nadie puede colgar datos suyos
--    de una rutina o sesión de otra persona.

-- ---------- RUTINAS ----------
create table if not exists public.routines (
  id          text primary key default gen_random_uuid()::text,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null default 'Mi rutina' check (char_length(name) <= 120),
  goal        text check (char_length(goal) <= 120),
  position    int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.routine_days (
  id          text primary key default gen_random_uuid()::text,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  routine_id  text not null,
  name        text not null default 'Día' check (char_length(name) <= 120),
  position    int  not null default 0,
  updated_at  timestamptz not null default now(),
  unique (id, user_id),
  foreign key (routine_id, user_id) references public.routines(id, user_id) on delete cascade
);

create table if not exists public.routine_exercises (
  id            text primary key default gen_random_uuid()::text,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day_id        text not null,
  name          text not null check (char_length(name) <= 120),
  muscle_group  text check (char_length(muscle_group) <= 60),
  sets          int  not null default 3  check (sets between 1 and 20),
  reps          text not null default '8-12' check (char_length(reps) <= 20),  -- admite "8-12"
  rest_sec      int  not null default 90 check (rest_sec between 0 and 1800),
  position      int  not null default 0,
  updated_at    timestamptz not null default now(),
  foreign key (day_id, user_id) references public.routine_days(id, user_id) on delete cascade
);

-- ---------- ENTRENAMIENTOS ----------
-- routine_id / day_id sin clave foránea a propósito: si borras una rutina,
-- tu historial se conserva (igual que hace la app ahora).
create table if not exists public.sessions (
  id            text primary key default gen_random_uuid()::text,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  routine_id    text,
  routine_name  text check (char_length(routine_name) <= 120),
  day_id        text,
  day_name      text check (char_length(day_name) <= 120),
  started_at    timestamptz not null default now(),
  duration_sec  int  not null default 0 check (duration_sec >= 0),
  notes         text check (char_length(notes) <= 2000),
  volume_kg     numeric(10,1) not null default 0,
  source        text not null default 'web' check (source in ('web','watch')),
  created_at    timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.session_sets (
  id              text primary key default gen_random_uuid()::text,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id      text not null,
  exercise_name   text not null check (char_length(exercise_name) <= 120),
  muscle_group    text check (char_length(muscle_group) <= 60),
  exercise_order  int  not null default 0,
  set_number      int  not null default 1 check (set_number between 1 and 50),
  weight_kg       numeric(6,2) not null default 0 check (weight_kg between 0 and 1000),
  reps            int  not null check (reps between 0 and 500),
  done_at         timestamptz not null default now(),
  foreign key (session_id, user_id) references public.sessions(id, user_id) on delete cascade
);

-- ---------- EXTRA: tu app también guarda peso corporal y ajustes ----------
create table if not exists public.body_entries (
  id          text primary key default gen_random_uuid()::text,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date  date not null default current_date,
  weight_kg   numeric(5,1),
  fat_pct     numeric(4,1),
  waist_cm    numeric(5,1),
  chest_cm    numeric(5,1),
  arm_cm      numeric(5,1)
);

create table if not exists public.user_settings (
  user_id        uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  weekly_goal    int not null default 3 check (weekly_goal between 1 and 7),
  body_goal_kg   numeric(5,1),
  height_cm      numeric(5,1),
  updated_at     timestamptz not null default now()
);

-- ---------- Índices (búsquedas rápidas) ----------
create index if not exists routines_user_idx          on public.routines(user_id);
create index if not exists routine_days_routine_idx   on public.routine_days(routine_id, user_id);
create index if not exists routine_ex_day_idx         on public.routine_exercises(day_id, user_id);
create index if not exists sessions_user_date_idx     on public.sessions(user_id, started_at desc);
create index if not exists session_sets_session_idx   on public.session_sets(session_id, user_id);
create index if not exists session_sets_user_ex_idx   on public.session_sets(user_id, exercise_name);
create index if not exists body_entries_user_idx      on public.body_entries(user_id, entry_date);

-- ---------- updated_at automático (lo usará el reloj para saber si hay cambios) ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['routines','routine_days','routine_exercises','user_settings'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------- Row Level Security: cada usuario solo ve y toca lo suyo ----------
do $$
declare t text;
begin
  foreach t in array array['routines','routine_days','routine_exercises',
                           'sessions','session_sets','body_entries','user_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);

    execute format('drop policy if exists "own_select" on public.%I', t);
    execute format('drop policy if exists "own_insert" on public.%I', t);
    execute format('drop policy if exists "own_update" on public.%I', t);
    execute format('drop policy if exists "own_delete" on public.%I', t);

    execute format('create policy "own_select" on public.%I for select to authenticated
                    using ((select auth.uid()) = user_id)', t);
    execute format('create policy "own_insert" on public.%I for insert to authenticated
                    with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own_update" on public.%I for update to authenticated
                    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own_delete" on public.%I for delete to authenticated
                    using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

-- ---------- Comprobación: debe mostrar 7 tablas con rls = true y 4 políticas cada una ----------
select c.relname as tabla,
       c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as politicas
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;
