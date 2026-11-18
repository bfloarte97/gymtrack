-- =====================================================================
-- GymTrack · Fase 5: esfuerzo por serie (RPE) y medidas corporales ampliadas
-- Pegar entero en Supabase → SQL Editor → Run (después de 01 a 04). Se puede volver a ejecutar.
-- =====================================================================

-- Esfuerzo percibido de cada serie (RPE 6-10). La hora de cada serie va en done_at (ya existía).
alter table public.session_sets add column if not exists rpe smallint;
alter table public.session_sets drop constraint if exists session_sets_rpe_check;
alter table public.session_sets add constraint session_sets_rpe_check check (rpe is null or rpe between 1 and 10);

-- Perímetros nuevos (cm)
alter table public.body_entries add column if not exists abdomen_cm numeric(5,1);  -- a la altura del ombligo
alter table public.body_entries add column if not exists hip_cm     numeric(5,1);  -- cadera, parte más ancha
alter table public.body_entries add column if not exists thigh_cm   numeric(5,1);  -- muslo
alter table public.body_entries add column if not exists calf_cm    numeric(5,1);  -- pantorrilla
alter table public.body_entries add column if not exists neck_cm    numeric(5,1);  -- cuello

-- Comprobación: deben salir 6 filas
select table_name, column_name from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'session_sets' and column_name = 'rpe')
    or (table_name = 'body_entries' and column_name in ('abdomen_cm','hip_cm','thigh_cm','calf_cm','neck_cm')))
order by 1, 2;
