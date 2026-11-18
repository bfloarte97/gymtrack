# GymTrack

Registro de rutinas y entrenos, sincronizado con un reloj Amazfit GTR 3 Pro (Zepp OS 1.0).

- **Web** (`index.html`): rutinas, peso y repeticiones, progreso y medidas corporales. Se puede instalar en el móvil como app.
- **Reloj** (`gymtrack-watch/`): cronómetro de series y descansos con pulso, calorías y vibración.
- **Base de datos** (`supabase/`): archivos SQL que se ejecutan en orden (01 → 06) en Supabase.

Web publicada: https://bfloarte97.github.io/gymtrack/

Los datos de cada usuario están en Supabase, protegidos con Row Level Security. La clave que aparece en el código es la clave pública (*publishable*), pensada para estar en la web.
