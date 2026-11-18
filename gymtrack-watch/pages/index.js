// GymTrack para Amazfit GTR 3 Pro · Zepp OS API 1.0
// El reloj es un cronómetro de series y descansos con pulso y calorías.
// El peso y las repeticiones se registran en la web GymTrack del móvil.
// Pantallas: Inicio → Entreno (serie / descanso) → Opciones → Guardado.
//
// Botones físicos durante el entreno:
//   superior derecho (HOME)      → Opciones (Continuar / Guardar y terminar / Salir sin parar / Descartar)
//   inferior derecho (SHORTCUT)  → fin de serie ⇄ nueva serie
// La pantalla NO se fuerza encendida: se enciende al girar la muñeca y vuelve a GymTrack.
// Aunque la app se cierre, el tiempo sigue contando y una alarma la reabre para vibrar.
import { readJSON, writeJSON, removeFile } from '../utils/store'

const { messageBuilder } = getApp()._options.globalData

/* ---------- configuración ---------- */
const C = {
  tx: 0xeceef3, mu: 0x8d93a3, ac: 0xc6f432, ac2: 0x5ad1ff, ok: 0x3ddc84,
  warn: 0xff9f5a, dg: 0xff5d5d, card: 0x1e222b, cardP: 0x2a303c, black: 0x000000
}
const REST_FIRST_ALERT = 90 // primer aviso de descanso (s)
const REST_REPEAT = 30      // después, cada 30 s
const HR_SERIES_STEP = 10   // curva de pulso: un valor cada 10 s
const FILE_WORKOUT = 'workout.json' // entreno en curso
const FILE_QUEUE = 'queue.json'     // datos pendientes de enviar al móvil
const REQ_TIMEOUT = 10000
const PAGE = 'pages/index'

/* ---------- estado ---------- */
let vibrate = null
let heart = null
let calorie = null
let hrNow = 0
let hrAt = 0
let widgets = []
let tick = null
let syncing = false
let screen = ''
let ui = {}
let tickCount = 0

/* ---------- utilidades ---------- */
const newId = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
const pad = (n) => (n < 10 ? '0' : '') + n
function fmtT(s) {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60)
}
function toast(t) {
  hmUI.showToast({ text: t })
}
function safe(fn, fallback) {
  try {
    const v = fn()
    return v === undefined ? fallback : v
  } catch (e) {
    return fallback
  }
}
function queue() {
  return readJSON(FILE_QUEUE, [])
}
function enqueue(item) {
  const q = queue()
  q.push(item)
  writeJSON(FILE_QUEUE, q)
}
// Una sola copia del entreno en memoria (WK), respaldada en archivo
let WK
function getWorkout() {
  if (WK === undefined) WK = readJSON(FILE_WORKOUT, null)
  return WK
}
function saveWorkout(wk) {
  WK = wk
  writeJSON(FILE_WORKOUT, wk)
}
function removeWorkout() {
  WK = null
  removeFile(FILE_WORKOUT)
}

/* ---------- alarmas: reabren la app para vibrar aunque esté cerrada ---------- */
function cancelAlarm(wk) {
  if (wk && wk.alarmId != null) {
    try {
      hmApp.alarmCancel(wk.alarmId)
    } catch (e) {}
    wk.alarmId = null
  }
}
function scheduleAlarm(wk) {
  cancelAlarm(wk)
  if (!wk || wk.phase !== 'rest') return
  // +1 s: si la app está abierta, avisa ella primero y la alarma se cancela (sin vibrar dos veces)
  const delay = Math.max(1, Math.round((wk.phaseStart + wk.nextAlert * 1000 - Date.now()) / 1000) + 1)
  try {
    wk.alarmId = hmApp.alarmNew({ appid: hmApp.packageInfo().appId, url: PAGE, file: PAGE, delay: delay })
  } catch (e) {
    console.log('alarmNew error ' + e)
    wk.alarmId = null
  }
}

/* ---------- pulso, calorías y contexto de salud ---------- */
function onHeart() {
  const v = heart ? heart.current : 0
  if (v > 30 && v < 230) {
    hrNow = v
    hrAt = Date.now()
  }
}
function currentHr() {
  return hrNow && Date.now() - hrAt < 15000 ? hrNow : 0
}
let PROFILE = null
function profile() {
  if (PROFILE) return PROFILE
  const u = safe(() => hmSetting.getUserData(), {})
  PROFILE = { age: u.age || 0, weight: u.weight || 0, height: u.height || 0, gender: u.gender }
  return PROFILE
}
// Estimación por pulso (fórmula de Keytel et al., 2005), en kcal/min.
// Con pulso bajo (< 90) se usa el gasto de actividad ligera (1,5 MET).
function kcalPerMin(hr, p) {
  const light = (1.5 * 3.5 * p.weight) / 200
  if (hr < 90) return light
  const male = (-55.0969 + 0.6309 * hr + 0.1988 * p.weight + 0.2017 * p.age) / 4.184
  const female = (-20.4022 + 0.4472 * hr - 0.1263 * p.weight + 0.074 * p.age) / 4.184
  const v = p.gender === 0 ? male : p.gender === 1 ? female : (male + female) / 2
  return Math.max(light, v)
}
function hrColor(hr, age) {
  if (!hr) return C.mu
  const pct = hr / (220 - (age || 35))
  if (pct >= 0.9) return C.dg
  if (pct >= 0.8) return C.warn
  if (pct >= 0.7) return C.ac
  if (pct >= 0.6) return C.ok
  return C.tx
}
function calSensor() {
  return safe(() => (calorie ? calorie.current || 0 : 0), 0)
}
// Foto del estado de salud al empezar (cada dato es opcional: si falla, se omite)
function healthContext() {
  const ctx = { tzOffsetMin: -new Date().getTimezoneOffset() }
  const p = profile()
  ctx.age = p.age
  ctx.weightKg = p.weight
  ctx.heightCm = p.height
  ctx.gender = p.gender === 0 ? 'male' : p.gender === 1 ? 'female' : 'unspecified'
  ctx.hrAtStart = currentHr() || safe(() => heart.last, 0) || 0
  const sleep = safe(() => hmSensor.createSensor(hmSensor.id.SLEEP), null)
  if (sleep) {
    safe(() => sleep.updateInfo())
    const b = safe(() => sleep.getBasicInfo(), null)
    if (b) {
      ctx.sleepScore = b.score
      ctx.sleepDeepMin = b.deepMin
      ctx.sleepStartMin = b.startTime
      ctx.sleepEndMin = b.endTime
    }
    ctx.sleepTotalMin = safe(() => sleep.getTotalTime(), null)
    const shr = safe(() => sleep.getSleepHrData(), []) || []
    const valid = shr.filter((v) => v > 30 && v < 230)
    if (valid.length) ctx.sleepHrMin = Math.min.apply(null, valid)
  }
  const pai = safe(() => hmSensor.createSensor(hmSensor.id.PAI), null)
  if (pai) {
    const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10)
    ctx.paiToday = r1(safe(() => pai.dailypai, null))
    ctx.paiWeek = r1(safe(() => pai.totalpai, null))
  }
  const spo2 = safe(() => hmSensor.createSensor(hmSensor.id.SPO2), null)
  if (spo2 && safe(() => spo2.retcode, 0) === 2) {
    ctx.spo2Last = safe(() => spo2.current, null)
    ctx.spo2At = safe(() => spo2.time, null)
  }
  return ctx
}
function addHr(wk, hr, weight) {
  wk.hrSum += hr * weight
  wk.hrCnt += weight
  if (hr > wk.hrMax) wk.hrMax = hr
  if (wk.phase === 'set') {
    wk.cur.hrSum += hr * weight
    wk.cur.hrCnt += weight
    if (hr > wk.cur.hrMax) wk.cur.hrMax = hr
  }
}
// Curva de pulso: un valor cada 10 s desde el inicio (0 = sin dato)
function addSeries(wk, now, hr) {
  const idx = Math.floor((now - wk.startedAt) / 1000 / HR_SERIES_STEP)
  while (wk.hrSeries.length <= idx) wk.hrSeries.push(hr || 0)
}
// Rellena el tiempo en que la app estuvo cerrada con el pulso por minuto que guarda el reloj
function backfill(wk, from, to) {
  const today = safe(() => (heart && heart.today) || [], [])
  const p = profile()
  for (let t = from; t < to; t += 60000) {
    const secs = Math.min(60, (to - t) / 1000)
    const d = new Date(t)
    const hr = today[d.getHours() * 60 + d.getMinutes()] || 0
    const valid = hr > 30 && hr < 230
    if (valid) addHr(wk, hr, secs)
    if (wk.calMode === 'hr') wk.kcal += (kcalPerMin(valid ? hr : 0, p) * secs) / 60
    addSeries(wk, Math.min(to, t + secs * 1000), valid ? hr : 0)
  }
}
// Suma pulso y calorías desde la última vez
function sample(wk, now) {
  const gap = (now - wk.lastTick) / 1000
  const hr = currentHr()
  if (gap > 15) {
    backfill(wk, wk.lastTick, now)
  } else if (gap > 0) {
    if (hr) addHr(wk, hr, gap)
    if (wk.calMode === 'hr') wk.kcal += (kcalPerMin(hr || 0, profile()) * gap) / 60
    addSeries(wk, now, hr)
  }
  if (wk.calMode !== 'hr') wk.kcal = Math.max(0, calSensor() - wk.calStart)
  // Recuperación: pulso a los 60 s de descanso
  if (wk.phase === 'rest' && wk.restHr60 == null && now - wk.phaseStart >= 60000) {
    wk.restHr60 = hr || 0
  }
  wk.lastTick = now
  return hr
}

/* ---------- widgets (hmUI 1.0) ---------- */
function add(type, opts) {
  const w = hmUI.createWidget(type, opts)
  widgets.push(w)
  return w
}
function clearScreen() {
  stopTick()
  widgets.forEach((w) => hmUI.deleteWidget(w))
  widgets = []
  ui = {}
}
// En 1.0, setProperty(hmUI.prop.MORE, …) necesita x, y, w, h: guardo la configuración completa.
function label(x, y, w, h, text, size, color) {
  const opts = {
    x: px(x), y: px(y), w: px(w), h: px(h),
    text: text, text_size: px(size), color: color,
    align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V,
    text_style: hmUI.text_style.ELLIPSIS
  }
  const t = add(hmUI.widget.TEXT, opts)
  t._opts = opts
  return t
}
function setLabel(t, text, color) {
  if (!t) return
  if (t._opts.text === text && (color === undefined || t._opts.color === color)) return
  t._opts.text = text
  if (color !== undefined) t._opts.color = color
  t.setProperty(hmUI.prop.MORE, t._opts)
}
function button(x, y, w, h, text, onClick, style) {
  const s = style || 'normal'
  const bg = { primary: C.ac, danger: C.dg }[s] || C.card
  const pressed = { primary: 0x9cc21f, danger: 0xc94444 }[s] || C.cardP
  return add(hmUI.widget.BUTTON, {
    x: px(x), y: px(y), w: px(w), h: px(h),
    text: text, text_size: px(h >= 60 ? 32 : 26),
    color: s === 'primary' ? C.black : C.tx,
    radius: px(Math.floor(h / 2)),
    normal_color: bg, press_color: pressed,
    click_func: () => onClick()
  })
}
function startTick(fn) {
  stopTick()
  tick = timer.createTimer(1000, 1000, fn, {})
}
function stopTick() {
  if (tick !== null) {
    timer.stopTimer(tick)
    tick = null
  }
}

/* ---------- envío al móvil (Side Service) ---------- */
function pendingText() {
  const n = queue().length
  return n ? [n + (n === 1 ? ' dato sin enviar' : ' datos sin enviar'), C.dg] : ['Todo sincronizado', C.ok]
}
function updatePending() {
  if (screen === 'home' && ui.pending) {
    const p = pendingText()
    setLabel(ui.pending, p[0], p[1])
  }
}
// Envía la cola en lotes de 10. Lo que el móvil confirma se borra del reloj.
function flush(done) {
  const q = queue()
  if (syncing || !q.length) {
    done && done(!q.length)
    return
  }
  syncing = true
  messageBuilder
    .request({ method: 'PUSH_SETS', items: q.slice(0, 10) }, { timeout: REQ_TIMEOUT })
    .then((res) => {
      syncing = false
      const ok = {}
      ;((res && res.accepted) || []).forEach((id) => (ok[id] = true))
      const rest = queue().filter((it) => !ok[it.id])
      writeJSON(FILE_QUEUE, rest)
      updatePending()
      if (res && res.live) handleLive(res.live)
      if (Object.keys(ok).length && rest.length) flush(done)
      else done && done(!rest.length, res)
    })
    .catch((e) => {
      syncing = false
      console.log('flush error ' + e)
      updatePending()
      done && done(false)
    })
}

/* ---------- sincronización con la web (entreno en curso) ---------- */
let polling = false
let lastPollSec = -1
function pollLive() {
  if (polling) return
  polling = true
  messageBuilder
    .request({ method: 'GET_LIVE' }, { timeout: REQ_TIMEOUT })
    .then((res) => {
      polling = false
      if (res && res.ok) handleLive(res.live)
    })
    .catch(() => {
      polling = false
    })
}
function handleLive(live) {
  if (!live) return
  const wk = getWorkout()
  if (wk) {
    if (live.watchSessionId !== wk.sessionId) return
    // Terminaste en la web → el reloj guarda y se cierra solo
    if (live.endedAt && live.endedBy === 'web') {
      toast('Terminado desde la web')
      return saveAndFinish()
    }
    // La web se unió después: guardo el día que eligió
    let changed = false
    if (live.webSessionId && wk.webSessionId !== live.webSessionId) {
      wk.webSessionId = live.webSessionId
      wk.dayName = live.dayName || wk.dayName
      changed = true
      if (screen === 'workout') setLabel(ui.day, dayTitle(wk))
    }
    // Plan de la rutina (qué ejercicio toca), actualizado cada vez que marcas en la web
    if (live.plan && live.planAt !== wk.planAt) {
      wk.plan = live.plan
      wk.planAt = live.planAt
      changed = true
    }
    if (changed) saveWorkout(wk)
    return
  }
  // Sin entreno en el reloj: si la web empezó uno, arranca solo
  if (screen === 'home' && live.active && live.webSessionId && !live.watchSessionId) {
    toast('Entreno de la web: ' + (live.dayName || 'libre'))
    startWorkout({ webSessionId: live.webSessionId, dayName: live.dayName, routineName: live.routineName, plan: live.plan, planAt: live.planAt })
  }
}
const fmtKg = (w) => String(Math.round(w * 100) / 100)
// Siguiente serie pendiente según la web. Si en el reloj vas por delante (pulsaste fin de serie
// pero aún no lo apuntaste en la web), avanza siguiendo el orden de la rutina.
function planTarget(wk) {
  const plan = wk.plan
  if (!plan || !plan.length) return null
  const pending = []
  let webDone = 0
  plan.forEach((e) => {
    const d = e.d || []
    for (let i = 0; i < d.length; i++) {
      if (d[i]) webDone++
      else pending.push({ name: e.n, k: i + 1, of: d.length, w: (e.w || [])[i] || 0, r: e.r || '' })
    }
  })
  return pending[Math.max(0, wk.sets.length - webDone)] || { done: true }
}
function planLines(wk) {
  const t = planTarget(wk)
  if (!t) return null
  if (t.done) return ['Rutina completa', 'Botón superior: guardar']
  const head = (wk.phase === 'set' ? '' : 'Sig.: ') + t.name + ' · ' + t.k + '/' + t.of
  const load = (t.w ? fmtKg(t.w) + ' kg' : '') + (t.w && t.r ? ' × ' : '') + (t.r ? t.r + ' reps' : '')
  return [head, load]
}
function dayTitle(wk) {
  return String(wk.dayName || 'Entreno').toUpperCase()
}

/* ---------- pantalla: INICIO ---------- */
function showHome() {
  clearScreen()
  screen = 'home'
  label(90, 40, 300, 40, 'GymTrack', 30, C.ac)
  label(90, 100, 300, 30, 'Pulso', 22, C.mu)
  ui.hr = label(90, 130, 300, 64, '--', 52, C.tx)
  const p = pendingText()
  ui.pending = label(70, 210, 340, 32, p[0], 22, p[1])
  button(90, 262, 300, 80, 'EMPEZAR', startWorkout, 'primary')
  button(150, 362, 180, 50, 'Sincronizar', () => {
    toast('Sincronizando...')
    flush((ok, res) => {
      if (ok) toast('Todo enviado')
      else toast(res && res.error === 'NOT_LINKED' ? 'Vincula el reloj en la app Zepp' : 'Sin conexión con el móvil')
    })
  })
  const age = profile().age
  const upd = () => {
    const hr = currentHr()
    setLabel(ui.hr, hr ? hr + ' lpm' : '--', hrColor(hr, age))
  }
  upd()
  startTick(upd)
}

/* ---------- entreno ---------- */
function startWorkout(opts) {
  const o = opts || {}
  const p = profile()
  const now = Date.now()
  const sessionId = newId()
  saveWorkout({
    sessionId: sessionId,
    webSessionId: o.webSessionId || null,
    dayName: o.dayName || null,
    plan: o.plan || null,
    planAt: o.planAt || null,
    routineName: o.routineName || null,
    startedAt: now,
    phase: 'set',
    phaseStart: now,
    setNum: 1,
    lastRestSec: 0,
    nextAlert: REST_FIRST_ALERT,
    alarmId: null,
    // calorías: por pulso si el reloj tiene tu edad y peso; si no, sensor del reloj
    calMode: p.age > 0 && p.weight > 0 ? 'hr' : 'sensor',
    calStart: calSensor(),
    kcal: 0,
    lastTick: now,
    hrSum: 0, hrCnt: 0, hrMax: 0,
    hrSeries: [],
    cur: { hrSum: 0, hrCnt: 0, hrMax: 0, hrStart: currentHr() },
    restHr60: null,
    prevHrEnd: 0,
    context: healthContext(),
    sets: []
  })
  // Avisa a tu cuenta: la web se une a este entreno (o el reloj se une al de la web)
  enqueue({ type: 'start', id: sessionId + '_start', sessionId: sessionId, startedAt: now, webSessionId: o.webSessionId || null })
  showWorkout()
  flush()
}

function closeSet(wk, now) {
  const hrEnd = currentHr()
  const set = {
    n: wk.setNum,
    start: wk.phaseStart,
    dur: Math.round((now - wk.phaseStart) / 1000),
    avgHr: wk.cur.hrCnt ? Math.round(wk.cur.hrSum / wk.cur.hrCnt) : 0,
    maxHr: wk.cur.hrMax
  }
  wk.sets.push(set)
  enqueue({
    type: 'set',
    id: wk.sessionId + '_s' + set.n,
    sessionId: wk.sessionId,
    startedAt: wk.startedAt,
    setNumber: set.n,
    setStart: set.start,
    setEnd: now,
    durationSec: set.dur,
    restBeforeSec: wk.lastRestSec,
    // recuperación del descanso anterior: cuánto bajó el pulso en 60 s
    restHrDrop60: wk.cur.restDrop60 != null ? wk.cur.restDrop60 : null,
    hrStart: wk.cur.hrStart || 0,
    hrEnd: hrEnd,
    avgHr: set.avgHr,
    maxHr: set.maxHr
  })
  wk.prevHrEnd = hrEnd
}

function toggle() {
  const wk = getWorkout()
  if (!wk) return showHome()
  const now = Date.now()
  sample(wk, now)
  if (wk.phase === 'set') {
    closeSet(wk, now)
    wk.phase = 'rest'
    wk.phaseStart = now
    wk.nextAlert = REST_FIRST_ALERT
    wk.restHr60 = null
    scheduleAlarm(wk)
  } else {
    cancelAlarm(wk)
    const drop = wk.prevHrEnd && wk.restHr60 ? wk.prevHrEnd - wk.restHr60 : null
    wk.lastRestSec = Math.round((now - wk.phaseStart) / 1000)
    wk.setNum += 1
    wk.phase = 'set'
    wk.phaseStart = now
    wk.cur = { hrSum: 0, hrCnt: 0, hrMax: 0, hrStart: currentHr(), restDrop60: drop }
  }
  saveWorkout(wk)
  showWorkout()
  flush() // intenta enviar; si no hay móvil, queda en la cola
}

function restAlert(first) {
  if (!vibrate) return
  vibrate.stop()
  vibrate.scene = first ? 9 : 28 // 90 s: 4 pulsos fuertes · luego: 1 pulso largo
  vibrate.start()
}

// Si toca avisar (o el aviso llegó con la app cerrada), vibra y programa el siguiente
function checkRestAlert(wk) {
  if (wk.phase !== 'rest') return
  const el = (Date.now() - wk.phaseStart) / 1000
  if (el < wk.nextAlert) return
  restAlert(wk.nextAlert === REST_FIRST_ALERT)
  while (wk.nextAlert <= el) wk.nextAlert += REST_REPEAT
  scheduleAlarm(wk)
  saveWorkout(wk)
}

/* ---------- pantalla: ENTRENO (serie / descanso) ---------- */
// Solo información: el cambio de fase se hace con el botón inferior derecho
function showWorkout() {
  const wk = getWorkout()
  if (!wk) return showHome()
  clearScreen()
  screen = 'workout'

  const isSet = wk.phase === 'set'
  const color = isSet ? C.ac : C.ac2
  const age = profile().age

  // Estado actual, arriba (texto, no botón)
  ui.day = label(90, 28, 300, 24, dayTitle(wk), 18, C.mu)
  label(60, 50, 360, 46, isSet ? 'SERIE ' + wk.setNum : 'DESCANSO', 40, color)
  ui.timer = label(40, 96, 400, 100, '0:00', 88, color)
  // Ejercicio que toca (si la rutina viene de la web) o información de la serie
  ui.ex = label(40, 196, 400, 36, '', 28, C.tx)
  ui.sub = label(60, 232, 360, 28, '', 20, C.mu)

  // Pulso y calorías
  ui.hr = label(70, 262, 170, 48, '--', 40, C.tx)
  label(70, 308, 170, 22, 'lpm', 18, C.mu)
  ui.kcal = label(240, 262, 170, 48, '0', 40, C.tx)
  label(240, 308, 170, 22, 'kcal', 18, C.mu)
  ui.total = label(70, 334, 340, 28, '', 20, C.tx)

  // Ayuda de botones (texto)
  label(80, 370, 320, 24, (isSet ? 'Botón inferior: fin de serie' : 'Botón inferior: nueva serie'), 18, C.mu)
  label(110, 396, 260, 24, 'Botón superior: opciones', 18, C.mu)

  const upd = () => {
    if (getWorkout() !== wk) return
    const now = Date.now()
    const hr = sample(wk, now)
    const el = (now - wk.phaseStart) / 1000
    setLabel(ui.timer, fmtT(el))
    const last = wk.sets[wk.sets.length - 1]
    const info = wk.phase === 'set'
      ? (wk.lastRestSec ? 'Descanso anterior ' + fmtT(wk.lastRestSec) : 'Primera serie')
      : 'Serie ' + last.n + ': ' + fmtT(last.dur) + (last.avgHr ? ' · ' + last.avgHr + ' lpm' : '')
    const pl = planLines(wk)
    if (pl) {
      setLabel(ui.ex, pl[0])
      setLabel(ui.sub, pl[1] || info)
    } else {
      setLabel(ui.ex, info)
      setLabel(ui.sub, '')
    }
    if (wk.phase === 'rest') {
      checkRestAlert(wk)
      // Durante el descanso pregunta a la web qué apuntaste (a los 10 s y 30 s)
      const sec = Math.floor(el)
      if ((sec === 10 || sec === 30) && lastPollSec !== sec) {
        lastPollSec = sec
        pollLive()
      }
    }
    setLabel(ui.hr, hr ? String(hr) : '--', hrColor(hr, age))
    setLabel(ui.kcal, String(Math.round(wk.kcal)))
    setLabel(ui.total, 'Total ' + fmtT((now - wk.startedAt) / 1000) + ' · ' + wk.sets.length + (wk.sets.length === 1 ? ' serie' : ' series'))
    tickCount += 1
    if (tickCount % 10 === 0) saveWorkout(wk) // guarda cada 10 s por si se cierra la app
    if (tickCount % 45 === 0) pollLive() // ¿terminaste en la web?
  }
  upd()
  startTick(upd)
  pollLive()
}

/* ---------- pantalla: OPCIONES (botón superior derecho) ---------- */
function showMenu() {
  const wk = getWorkout()
  if (!wk) return showHome()
  sample(wk, Date.now())
  saveWorkout(wk)
  clearScreen()
  screen = 'menu'
  label(90, 34, 300, 40, 'Opciones', 30, C.tx)
  button(90, 84, 300, 66, 'Continuar', showWorkout)
  button(90, 162, 300, 66, 'Guardar y terminar', saveAndFinish, 'primary')
  button(90, 240, 300, 66, 'Salir sin parar', () => {
    // La app se cierra pero el tiempo sigue contando; la alarma la reabre para el aviso
    scheduleAlarm(wk)
    saveWorkout(wk)
    hmApp.gotoHome()
  })
  button(130, 318, 220, 56, 'Descartar', showDiscardConfirm, 'danger')
  label(70, 388, 340, 30, 'El tiempo sigue contando', 19, C.mu)
}

function showDiscardConfirm() {
  clearScreen()
  screen = 'confirm'
  label(60, 110, 360, 44, '¿Descartar entreno?', 32, C.tx)
  label(60, 160, 360, 32, 'No se guardará nada', 22, C.mu)
  button(90, 220, 300, 66, 'Sí, descartar', () => finishWorkout(false), 'danger')
  button(90, 300, 300, 66, 'No, volver', showMenu)
}

/* ---------- guardar ---------- */
function saveAndFinish() {
  const wk = getWorkout()
  if (!wk) return showHome()
  const now = Date.now()
  sample(wk, now)
  // Si estabas en mitad de una serie (más de 5 s), cuenta como hecha
  if (wk.phase === 'set' && (now - wk.phaseStart) / 1000 >= 5) closeSet(wk, now)
  if (!wk.sets.length) {
    toast('Sin series: no se guarda')
    return finishWorkout(false)
  }
  const summary = {
    durationSec: Math.round((now - wk.startedAt) / 1000),
    sets: wk.sets.length,
    avgHr: wk.hrCnt ? Math.round(wk.hrSum / wk.hrCnt) : 0,
    maxHr: wk.hrMax,
    kcal: Math.round(wk.kcal)
  }
  finishWorkout(true, summary)
  showSaved(summary)
}

function finishWorkout(save, summary) {
  const wk = getWorkout()
  if (wk) cancelAlarm(wk)
  if (wk && save) {
    enqueue({
      type: 'finish',
      id: wk.sessionId + '_fin',
      sessionId: wk.sessionId,
      startedAt: wk.startedAt,
      endedAt: Date.now(),
      durationSec: summary.durationSec,
      sets: summary.sets,
      avgHr: summary.avgHr,
      maxHr: summary.maxHr,
      kcal: summary.kcal,
      kcalMethod: wk.calMode,
      hrSeriesStepSec: HR_SERIES_STEP,
      hrSeries: wk.hrSeries,
      context: wk.context
    })
  }
  if (wk && !save && wk.webSessionId) {
    enqueue({
      type: 'finish', id: wk.sessionId + '_fin', sessionId: wk.sessionId, startedAt: wk.startedAt,
      endedAt: Date.now(), durationSec: Math.round((Date.now() - wk.startedAt) / 1000),
      sets: 0, avgHr: 0, maxHr: 0, kcal: 0, kcalMethod: wk.calMode, hrSeriesStepSec: HR_SERIES_STEP,
      hrSeries: [], context: wk.context, discarded: true
    })
  }
  removeWorkout()
  if (!save) {
    toast('Entreno descartado')
    showHome()
  }
  flush()
}

/* ---------- pantalla: GUARDADO ---------- */
function showSaved(s) {
  clearScreen()
  screen = 'saved'
  label(60, 50, 360, 44, 'Entreno guardado', 32, C.ok)
  label(60, 100, 360, 80, fmtT(s.durationSec), 64, C.ac)
  label(60, 180, 360, 36, s.sets + (s.sets === 1 ? ' serie' : ' series') + ' · ' + s.kcal + ' kcal', 28, C.tx)
  label(60, 218, 360, 32, s.avgHr ? 'Pulso medio ' + s.avgHr + ' · máx ' + s.maxHr : 'Sin datos de pulso', 22, C.mu)
  button(90, 290, 300, 70, 'Listo', showHome, 'primary')
}

/* ---------- botones físicos y gestos ---------- */
function onKey(key, action) {
  const inWorkout = !!getWorkout() && (screen === 'workout' || screen === 'menu' || screen === 'confirm')
  if (!inWorkout) return false // fuera del entreno, los botones funcionan como siempre
  if (key === hmApp.key.HOME) {
    if (action === hmApp.action.CLICK) {
      if (screen === 'workout') showMenu()
      else showWorkout()
    }
    return true // no salir de la app
  }
  if (key === hmApp.key.SHORTCUT) {
    if (action === hmApp.action.CLICK && screen === 'workout') toggle()
    return true
  }
  return false
}
function onGesture(event) {
  // Durante el entreno, deslizar a la derecha no cierra la app
  if (event === hmApp.gesture.RIGHT && getWorkout()) {
    if (screen !== 'workout') showWorkout()
    return true
  }
  return false
}

/* ---------- ciclo de vida ---------- */
Page({
  onInit() {
    vibrate = hmSensor.createSensor(hmSensor.id.VIBRATE)
    calorie = hmSensor.createSensor(hmSensor.id.CALORIE)
    heart = hmSensor.createSensor(hmSensor.id.HEART)
    heart.addEventListener(heart.event.CURRENT, onHeart) // activa la medición continua
    hmApp.setScreenKeep(true) // al girar la muñeca, la pantalla vuelve a GymTrack
    hmSetting.setBrightScreenCancel() // la pantalla se apaga normal (ahorra batería)
    hmApp.registerKeyEvent(onKey)
    hmApp.registerGestureEvent(onGesture)
  },
  build() {
    const wk = getWorkout()
    if (wk && (!wk.phase || !wk.hrSeries)) removeWorkout() // entreno a medias de una versión anterior
    removeFile('plan.json') // ya no se usa
    const cur = getWorkout()
    if (cur) {
      sample(cur, Date.now()) // rellena pulso y calorías del tiempo con la app cerrada
      checkRestAlert(cur) // si la alarma reabrió la app, vibra aquí
      saveWorkout(cur)
      showWorkout()
    } else {
      showHome()
      flush()
      pollLive() // si empezaste en la web, el reloj arranca solo
    }
  },
  onDestroy() {
    stopTick()
    const wk = getWorkout()
    if (wk) {
      sample(wk, Date.now())
      if (wk.phase === 'rest') scheduleAlarm(wk) // el aviso llegará aunque la app esté cerrada
      saveWorkout(wk)
    }
    vibrate && vibrate.stop()
    try {
      heart && heart.removeEventListener(heart.event.CURRENT, onHeart)
    } catch (e) {}
    try {
      hmApp.unregisterKeyEvent()
      hmApp.unregisterGestureEvent()
    } catch (e) {}
  }
})
