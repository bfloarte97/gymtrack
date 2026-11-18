-- =====================================================================
-- GymTrack · El reloj muestra qué ejercicio toca (plan de la rutina en el entreno en curso)
-- Pegar entero en Supabase → SQL Editor → Run (después de 01, 02 y 03). Se puede volver a ejecutar.
-- ⚠️ Si alguna vez vuelves a ejecutar 03_sincronizacion.sql, ejecuta después este archivo otra vez.
-- =====================================================================
-- La web envía la lista de ejercicios del día (series, peso, reps y cuáles están hechas)
-- al empezar y cada vez que marcas una serie. El reloj la recibe y muestra el ejercicio actual.
-- Formato del plan: [{ "n": "Sentadilla", "r": "6-10", "w": [15,15,15,15], "d": [1,1,0,0] }, ...]

alter table public.live_workouts add column if not exists plan jsonb;
alter table public.live_workouts add column if not exists plan_at timestamptz;

-- Plan válido: lista de hasta 40 ejercicios y tamaño razonable
create or replace function public._valid_plan(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 40 and length(p::text) <= 20000
              then p end
$$;

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
    'plan',           l.plan,
    'planAt',         l.plan_at,
    'active',         l.ended_at is null and l.started_at > now() - interval '4 hours') end
$$;

-- Web: empezar entreno (ahora con el plan)
drop function if exists public.live_start_web(text, text, text, text, text);
create or replace function public.live_start_web(
  p_web_session_id text, p_routine_id text default null, p_routine_name text default null,
  p_day_id text default null, p_day_name text default null, p_plan jsonb default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_l    public.live_workouts;
  v_plan jsonb := public._valid_plan(p_plan);
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_l from public.live_workouts l where l.user_id = v_uid;

  if public._live_active(v_l) and v_l.web_session_id = p_web_session_id then
    update public.live_workouts l set plan = coalesce(v_plan, l.plan), plan_at = now(), updated_at = now()
     where l.user_id = v_uid returning * into v_l;
    return public._live_json(v_l);                       -- ya registrado (reintento)
  end if;

  if public._live_active(v_l) and v_l.web_session_id is null and v_l.watch_session_id is not null then
    -- El reloj empezó antes: la web se une a ese entreno
    update public.live_workouts l set
           web_session_id = p_web_session_id,
           routine_id = left(p_routine_id, 64), routine_name = left(p_routine_name, 120),
           day_id = left(p_day_id, 64), day_name = left(p_day_name, 120),
           plan = v_plan, plan_at = now(), updated_at = now()
     where l.user_id = v_uid returning * into v_l;
    update public.watch_sessions s set web_session_id = p_web_session_id
     where s.id = v_l.watch_session_id and s.user_id = v_uid;
  else
    insert into public.live_workouts as l (user_id, web_session_id, watch_session_id, routine_id, routine_name,
                                           day_id, day_name, source, started_at, ended_at, ended_by,
                                           plan, plan_at, updated_at)
    values (v_uid, left(p_web_session_id, 64), null, left(p_routine_id, 64), left(p_routine_name, 120),
            left(p_day_id, 64), left(p_day_name, 120), 'web', now(), null, null, v_plan, now(), now())
    on conflict (user_id) do update set
           web_session_id = excluded.web_session_id, watch_session_id = null,
           routine_id = excluded.routine_id, routine_name = excluded.routine_name,
           day_id = excluded.day_id, day_name = excluded.day_name, source = 'web',
           started_at = now(), ended_at = null, ended_by = null,
           plan = excluded.plan, plan_at = now(), updated_at = now()
    returning * into v_l;
  end if;
  return public._live_json(v_l);
end $$;

-- Web: actualizar el plan (al marcar series, cambiar pesos o añadir/quitar ejercicios)
create or replace function public.live_plan(p_web_session_id text, p_plan jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_l   public.live_workouts;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.live_workouts l set plan = public._valid_plan(p_plan), plan_at = now(), updated_at = now()
   where l.user_id = v_uid and l.web_session_id = p_web_session_id and l.ended_at is null
  returning * into v_l;
  return public._live_json(v_l);
end $$;

-- Permisos
revoke all on function public._valid_plan(jsonb) from public, anon, authenticated;
revoke all on function public._live_json(public.live_workouts) from public, anon, authenticated;
revoke all on function public.live_start_web(text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.live_plan(text, jsonb) from public, anon, authenticated;
grant execute on function public.live_start_web(text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.live_plan(text, jsonb) to authenticated;

-- Comprobación: debe mostrar plan y plan_at
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'live_workouts' and column_name in ('plan', 'plan_at')
order by 1;
