-- =====================================================================
-- GymTrack · Fase 4 · Reloj: vinculación y datos del reloj
-- Pegar entero en Supabase → SQL Editor → Run. Se puede volver a ejecutar.
-- =====================================================================
-- Cómo funciona la vinculación:
--  1. En la web (con sesión iniciada) pides un código de 6 dígitos (válido 10 min).
--  2. Lo escribes en la app Zepp. El móvil lo canjea y recibe una LLAVE propia del reloj.
--  3. En la base de datos solo se guarda la huella (hash SHA-256) de esa llave.
--  4. El móvil envía los datos del reloj con esa llave. Desde la web puedes desvincularlo.
-- El móvil nunca conoce tu contraseña ni puede leer tus datos: solo puede AÑADIR datos del reloj.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tablas ----------
create table if not exists public.devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null default 'Amazfit GTR 3 Pro' check (char_length(name) <= 60),
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

create table if not exists public.pairing_codes (
  code        text primary key check (code ~ '^[0-9]{6}$'),
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- Intentos fallidos de canje (freno contra quien intente adivinar códigos)
create table if not exists public.pairing_failures (
  id  bigint generated always as identity primary key,
  at  timestamptz not null default now()
);

create table if not exists public.watch_sessions (
  id                  text primary key check (char_length(id) <= 64),
  user_id             uuid not null references auth.users(id) on delete cascade,
  device_id           uuid references public.devices(id) on delete set null,
  started_at          timestamptz not null,
  ended_at            timestamptz,
  duration_sec        int,
  sets                int,
  avg_hr              int,
  max_hr              int,
  kcal                int,
  kcal_method         text,
  hr_series_step_sec  int,
  hr_series           jsonb,   -- pulso cada N segundos desde el inicio (0 = sin dato)
  context             jsonb,   -- sueño, pulso mínimo en sueño, PAI, SpO2, perfil, zona horaria
  completed           boolean not null default false,
  created_at          timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.watch_sets (
  id               text primary key check (char_length(id) <= 80),
  user_id          uuid not null references auth.users(id) on delete cascade,
  session_id       text not null,
  set_number       int not null,
  set_start        timestamptz,
  set_end          timestamptz,
  duration_sec     int,
  rest_before_sec  int,
  rest_hr_drop60   int,     -- cuánto bajó el pulso en el primer minuto del descanso anterior
  hr_start         int,
  hr_end           int,
  avg_hr           int,
  max_hr           int,
  created_at       timestamptz not null default now(),
  foreign key (session_id, user_id) references public.watch_sessions(id, user_id) on delete cascade
);

create index if not exists devices_user_idx          on public.devices(user_id);
create index if not exists pairing_codes_user_idx    on public.pairing_codes(user_id);
create index if not exists pairing_failures_at_idx   on public.pairing_failures(at);
create index if not exists watch_sessions_user_idx   on public.watch_sessions(user_id, started_at desc);
create index if not exists watch_sets_session_idx    on public.watch_sets(session_id, user_id);

-- ---------- Seguridad (RLS): desde la web solo ves y gestionas lo tuyo ----------
alter table public.devices          enable row level security;
alter table public.pairing_codes    enable row level security;
alter table public.pairing_failures enable row level security;  -- sin políticas: nadie accede directo
alter table public.watch_sessions   enable row level security;
alter table public.watch_sets       enable row level security;

revoke all on public.devices, public.pairing_codes, public.pairing_failures,
              public.watch_sessions, public.watch_sets from anon, authenticated;
grant select, update, delete on public.devices        to authenticated;  -- ver / desvincular
grant select, delete         on public.pairing_codes  to authenticated;
grant select, delete         on public.watch_sessions to authenticated;
grant select, delete         on public.watch_sets     to authenticated;

do $$
declare t text;
begin
  foreach t in array array['devices','pairing_codes','watch_sessions','watch_sets'] loop
    execute format('drop policy if exists "own_select" on public.%I', t);
    execute format('drop policy if exists "own_delete" on public.%I', t);
    execute format('create policy "own_select" on public.%I for select to authenticated
                    using ((select auth.uid()) = user_id)', t);
    execute format('create policy "own_delete" on public.%I for delete to authenticated
                    using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;
drop policy if exists "own_update" on public.devices;
create policy "own_update" on public.devices for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ---------- 1) Web: generar código de 6 dígitos (10 minutos) ----------
create or replace function public.create_pairing_code()
returns table (pairing_code text, expires timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_exp  timestamptz := now() + interval '10 minutes';
  v_b    bytea;
  v_code text;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  delete from public.pairing_codes pc where pc.user_id = v_uid or pc.expires_at < now();
  loop
    v_b := extensions.gen_random_bytes(3);
    v_code := lpad(((get_byte(v_b,0) * 65536 + get_byte(v_b,1) * 256 + get_byte(v_b,2)) % 1000000)::text, 6, '0');
    begin
      insert into public.pairing_codes (code, user_id, expires_at) values (v_code, v_uid, v_exp);
      exit;
    exception when unique_violation then
      -- código repetido (muy raro): se genera otro
    end;
  end loop;
  return query select v_code, v_exp;
end $$;

-- Busca el reloj a partir de su llave (solo se compara la huella)
create or replace function public._device_by_token(p_token text)
returns public.devices
language sql stable security definer set search_path = '' as $$
  select d.* from public.devices d
  where d.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and d.revoked_at is null
$$;

-- ---------- 2) Móvil: canjear el código por una llave del reloj ----------
create or replace function public.claim_pairing_code(p_code text, p_device_name text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_token text;
begin
  -- Freno: máximo 30 intentos fallidos (de cualquiera) cada 10 minutos
  if (select count(*) from public.pairing_failures f where f.at > now() - interval '10 minutes') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS');
  end if;

  delete from public.pairing_codes pc
   where pc.code = trim(coalesce(p_code, '')) and pc.expires_at > now()
  returning pc.user_id into v_uid;

  if v_uid is null then
    insert into public.pairing_failures default values;
    delete from public.pairing_failures f where f.at < now() - interval '1 day';
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.devices (user_id, name, token_hash)
  values (v_uid,
          coalesce(left(nullif(trim(p_device_name), ''), 60), 'Amazfit GTR 3 Pro'),
          encode(extensions.digest(v_token, 'sha256'), 'hex'));
  return jsonb_build_object('ok', true, 'token', v_token);
end $$;

-- ---------- 3) Móvil: ¿a qué cuenta está vinculado? ----------
create or replace function public.watch_status(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dev   public.devices;
  v_email text;
begin
  v_dev := public._device_by_token(p_token);
  if v_dev.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_LINKED');
  end if;
  select u.email into v_email from auth.users u where u.id = v_dev.user_id;
  return jsonb_build_object(
    'ok', true,
    'device', v_dev.name,
    'linkedAt', v_dev.created_at,
    'account', left(coalesce(v_email, ''), 2) || '***@' || split_part(coalesce(v_email, ''), '@', 2));
end $$;

-- ---------- 4) Móvil: desvincular desde la app Zepp ----------
create or replace function public.watch_unlink(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_dev public.devices;
begin
  v_dev := public._device_by_token(p_token);
  if v_dev.id is not null then
    update public.devices d set revoked_at = now() where d.id = v_dev.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 5) Móvil: subir datos del reloj (series y fin de entreno) ----------
create or replace function public.watch_push(p_token text, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dev  public.devices;
  v_it   jsonb;
  v_id   text;
  v_sid  text;
  v_ok   jsonb := '[]'::jsonb;
begin
  v_dev := public._device_by_token(p_token);
  if v_dev.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_LINKED', 'accepted', '[]'::jsonb);
  end if;
  update public.devices d set last_seen_at = now() where d.id = v_dev.id;

  for v_it in select e.value from jsonb_array_elements(
                 case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as e(value) limit 50
  loop
    v_id  := v_it->>'id';
    v_sid := v_it->>'sessionId';
    continue when v_id is null or v_sid is null or char_length(v_id) > 80 or char_length(v_sid) > 64;
    begin
      -- La sesión se crea al llegar su primera serie (el "fin" puede llegar después)
      insert into public.watch_sessions (id, user_id, device_id, started_at)
      values (v_sid, v_dev.user_id, v_dev.id,
              to_timestamp(coalesce((v_it->>'startedAt')::numeric, extract(epoch from now()) * 1000) / 1000))
      on conflict (id) do nothing;

      -- Solo si la sesión es de esta cuenta
      if exists (select 1 from public.watch_sessions s where s.id = v_sid and s.user_id = v_dev.user_id) then
        if v_it->>'type' = 'set' then
          insert into public.watch_sets as w (id, user_id, session_id, set_number, set_start, set_end,
                 duration_sec, rest_before_sec, rest_hr_drop60, hr_start, hr_end, avg_hr, max_hr)
          values (v_id, v_dev.user_id, v_sid,
                  round((v_it->>'setNumber')::numeric)::int,
                  to_timestamp((v_it->>'setStart')::numeric / 1000),
                  to_timestamp((v_it->>'setEnd')::numeric / 1000),
                  round((v_it->>'durationSec')::numeric)::int,
                  round((v_it->>'restBeforeSec')::numeric)::int,
                  round((v_it->>'restHrDrop60')::numeric)::int,
                  round((v_it->>'hrStart')::numeric)::int,
                  round((v_it->>'hrEnd')::numeric)::int,
                  round((v_it->>'avgHr')::numeric)::int,
                  round((v_it->>'maxHr')::numeric)::int)
          on conflict (id) do update set
                  duration_sec = excluded.duration_sec, rest_before_sec = excluded.rest_before_sec,
                  rest_hr_drop60 = excluded.rest_hr_drop60, hr_start = excluded.hr_start,
                  hr_end = excluded.hr_end, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr
            where w.user_id = excluded.user_id;
        elsif v_it->>'type' = 'finish' then
          update public.watch_sessions s set
                 ended_at           = to_timestamp((v_it->>'endedAt')::numeric / 1000),
                 duration_sec       = round((v_it->>'durationSec')::numeric)::int,
                 sets               = round((v_it->>'sets')::numeric)::int,
                 avg_hr             = round((v_it->>'avgHr')::numeric)::int,
                 max_hr             = round((v_it->>'maxHr')::numeric)::int,
                 kcal               = round((v_it->>'kcal')::numeric)::int,
                 kcal_method        = left(v_it->>'kcalMethod', 10),
                 hr_series_step_sec = round((v_it->>'hrSeriesStepSec')::numeric)::int,
                 hr_series          = case when jsonb_typeof(v_it->'hrSeries') = 'array'
                                            and jsonb_array_length(v_it->'hrSeries') <= 5000
                                           then v_it->'hrSeries' end,
                 context            = case when jsonb_typeof(v_it->'context') = 'object' then v_it->'context' end,
                 completed          = true
           where s.id = v_sid and s.user_id = v_dev.user_id;
        end if;
      end if;
    exception when others then
      -- Dato defectuoso: se acepta para que el reloj no lo reintente sin fin
      raise warning 'watch_push: dato % descartado: %', v_id, sqlerrm;
    end;
    v_ok := v_ok || to_jsonb(v_id);
  end loop;

  return jsonb_build_object('ok', true, 'accepted', v_ok);
end $$;

-- ---------- Permisos de las funciones ----------
revoke all on function public.create_pairing_code()             from public, anon, authenticated;
revoke all on function public._device_by_token(text)            from public, anon, authenticated;
revoke all on function public.claim_pairing_code(text, text)    from public, anon, authenticated;
revoke all on function public.watch_status(text)                from public, anon, authenticated;
revoke all on function public.watch_unlink(text)                from public, anon, authenticated;
revoke all on function public.watch_push(text, jsonb)           from public, anon, authenticated;

grant execute on function public.create_pairing_code()          to authenticated;       -- web
grant execute on function public.claim_pairing_code(text, text) to anon, authenticated; -- móvil
grant execute on function public.watch_status(text)             to anon, authenticated; -- móvil
grant execute on function public.watch_unlink(text)             to anon, authenticated; -- móvil
grant execute on function public.watch_push(text, jsonb)        to anon, authenticated; -- móvil

-- ---------- Comprobación: 5 tablas nuevas con rls = true ----------
select c.relname as tabla, c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as politicas
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in ('devices','pairing_codes','pairing_failures','watch_sessions','watch_sets')
order by 1;
