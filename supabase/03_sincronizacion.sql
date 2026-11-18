-- =====================================================================
-- GymTrack · Sincronización web ⇄ reloj del entreno en curso
-- Pegar entero en Supabase → SQL Editor → Run (después de 01 y 02). Se puede volver a ejecutar.
-- =====================================================================
-- Una fila por usuario con el entreno en curso:
--  * Empiezas en la web  → el reloj, al abrir GymTrack, arranca solo y se une.
--  * Empiezas en el reloj → la web muestra un aviso para elegir el día y se une.
--  * Terminas en un lado → el otro se cierra solo y guarda.
-- Un entreno se considera "en curso" durante un máximo de 4 horas.

alter table public.watch_sessions add column if not exists web_session_id text;

create table if not exists public.live_workouts (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  web_session_id    text,
  watch_session_id  text,
  routine_id        text,
  routine_name      text,
  day_id            text,
  day_name          text,
  source            text not null check (source in ('web','watch')),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  ended_by          text check (ended_by in ('web','watch')),
  updated_at        timestamptz not null default now()
);

alter table public.live_workouts enable row level security;
revoke all on public.live_workouts from anon, authenticated;
grant select on public.live_workouts to authenticated;  -- la web solo lee; escribe con las funciones
drop policy if exists "own_select" on public.live_workouts;
create policy "own_select" on public.live_workouts for select to authenticated
  using ((select auth.uid()) = user_id);

-- Formato común de respuesta
create or replace function public._live_json(l public.live_workouts)
returns jsonb language sql stable set search_path = '' as $$
  select case when l.user_id is null then null else jsonb_build_object(
    'webSessionId',   l.web_session_id,
    'watchSessionId', l.watch_session_id,
    'routineName',    l.routine_name,
    'dayName',        l.day_name,
    'source',         l.source,
    'startedAt',      l.started_at,
    'endedAt',        l.ended_at,
    'endedBy',        l.ended_by,
    'active',         l.ended_at is null and l.started_at > now() - interval '4 hours') end
$$;

create or replace function public._live_active(l public.live_workouts)
returns boolean language sql stable set search_path = '' as $$
  select l.user_id is not null and l.ended_at is null and l.started_at > now() - interval '4 hours'
$$;

-- ---------- Web: empezar entreno ----------
create or replace function public.live_start_web(
  p_web_session_id text, p_routine_id text default null, p_routine_name text default null,
  p_day_id text default null, p_day_name text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_l   public.live_workouts;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_l from public.live_workouts l where l.user_id = v_uid;

  if public._live_active(v_l) and v_l.web_session_id = p_web_session_id then
    return public._live_json(v_l);                       -- ya registrado (reintento)
  end if;

  if public._live_active(v_l) and v_l.web_session_id is null and v_l.watch_session_id is not null then
    -- El reloj empezó antes: la web se une a ese entreno
    update public.live_workouts l set
           web_session_id = p_web_session_id,
           routine_id = left(p_routine_id, 64), routine_name = left(p_routine_name, 120),
           day_id = left(p_day_id, 64), day_name = left(p_day_name, 120), updated_at = now()
     where l.user_id = v_uid returning * into v_l;
    update public.watch_sessions s set web_session_id = p_web_session_id
     where s.id = v_l.watch_session_id and s.user_id = v_uid;
  else
    insert into public.live_workouts as l (user_id, web_session_id, watch_session_id, routine_id, routine_name,
                                           day_id, day_name, source, started_at, ended_at, ended_by, updated_at)
    values (v_uid, left(p_web_session_id, 64), null, left(p_routine_id, 64), left(p_routine_name, 120),
            left(p_day_id, 64), left(p_day_name, 120), 'web', now(), null, null, now())
    on conflict (user_id) do update set
           web_session_id = excluded.web_session_id, watch_session_id = null,
           routine_id = excluded.routine_id, routine_name = excluded.routine_name,
           day_id = excluded.day_id, day_name = excluded.day_name, source = 'web',
           started_at = now(), ended_at = null, ended_by = null, updated_at = now()
    returning * into v_l;
  end if;
  return public._live_json(v_l);
end $$;

-- ---------- Web: terminar o descartar ----------
create or replace function public.live_end_web(p_web_session_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_l   public.live_workouts;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.live_workouts l set ended_at = now(), ended_by = 'web', updated_at = now()
   where l.user_id = v_uid and l.web_session_id = p_web_session_id and l.ended_at is null;
  select * into v_l from public.live_workouts l where l.user_id = v_uid;
  return public._live_json(v_l);
end $$;

-- ---------- Reloj: ¿hay un entreno en curso? ----------
create or replace function public.watch_live(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dev public.devices;
  v_l   public.live_workouts;
begin
  v_dev := public._device_by_token(p_token);
  if v_dev.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_LINKED');
  end if;
  select * into v_l from public.live_workouts l where l.user_id = v_dev.user_id;
  return jsonb_build_object('ok', true, 'live', public._live_json(v_l));
end $$;

-- ---------- Reloj: subir datos (ahora con "start" y respuesta con el entreno en curso) ----------
create or replace function public.watch_push(p_token text, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dev  public.devices;
  v_it   jsonb;
  v_id   text;
  v_sid  text;
  v_l    public.live_workouts;
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
      insert into public.watch_sessions (id, user_id, device_id, started_at)
      values (v_sid, v_dev.user_id, v_dev.id,
              to_timestamp(coalesce((v_it->>'startedAt')::numeric, extract(epoch from now()) * 1000) / 1000))
      on conflict (id) do nothing;

      if exists (select 1 from public.watch_sessions s where s.id = v_sid and s.user_id = v_dev.user_id) then
        if v_it->>'type' = 'start' then
          select * into v_l from public.live_workouts l where l.user_id = v_dev.user_id;
          if public._live_active(v_l) then
            -- Hay un entreno en curso: el reloj se une (si no estaba ya unido a otro)
            if v_l.watch_session_id is null or v_l.watch_session_id = v_sid then
              update public.live_workouts l set watch_session_id = v_sid, updated_at = now()
               where l.user_id = v_dev.user_id returning * into v_l;
              if v_l.web_session_id is not null then
                update public.watch_sessions s set web_session_id = v_l.web_session_id
                 where s.id = v_sid and s.user_id = v_dev.user_id;
              end if;
            end if;
          elsif to_timestamp((v_it->>'startedAt')::numeric / 1000) > now() - interval '4 hours' then
            -- No hay nada en curso: el reloj empieza uno nuevo
            insert into public.live_workouts as l (user_id, web_session_id, watch_session_id, source,
                                                   started_at, ended_at, ended_by, updated_at)
            values (v_dev.user_id, null, v_sid, 'watch',
                    to_timestamp((v_it->>'startedAt')::numeric / 1000), null, null, now())
            on conflict (user_id) do update set
                   web_session_id = null, watch_session_id = excluded.watch_session_id,
                   routine_id = null, routine_name = null, day_id = null, day_name = null,
                   source = 'watch', started_at = excluded.started_at,
                   ended_at = null, ended_by = null, updated_at = now();
          end if;
        elsif v_it->>'type' = 'set' then
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
          -- Terminar en el reloj cierra también el entreno de la web
          update public.live_workouts l set ended_at = now(), ended_by = 'watch', updated_at = now()
           where l.user_id = v_dev.user_id and l.watch_session_id = v_sid and l.ended_at is null;
        end if;
      end if;
    exception when others then
      raise warning 'watch_push: dato % descartado: %', v_id, sqlerrm;
    end;
    v_ok := v_ok || to_jsonb(v_id);
  end loop;

  select * into v_l from public.live_workouts l where l.user_id = v_dev.user_id;
  return jsonb_build_object('ok', true, 'accepted', v_ok, 'live', public._live_json(v_l));
end $$;

-- ---------- Permisos ----------
revoke all on function public._live_json(public.live_workouts)   from public, anon, authenticated;
revoke all on function public._live_active(public.live_workouts) from public, anon, authenticated;
revoke all on function public.live_start_web(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.live_end_web(text)                 from public, anon, authenticated;
revoke all on function public.watch_live(text)                   from public, anon, authenticated;
revoke all on function public.watch_push(text, jsonb)            from public, anon, authenticated;

grant execute on function public.live_start_web(text, text, text, text, text) to authenticated; -- web
grant execute on function public.live_end_web(text)              to authenticated;              -- web
grant execute on function public.watch_live(text)                to anon, authenticated;        -- móvil
grant execute on function public.watch_push(text, jsonb)         to anon, authenticated;        -- móvil

-- ---------- Comprobación ----------
select 'live_workouts' as tabla, c.relrowsecurity as rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'live_workouts';
