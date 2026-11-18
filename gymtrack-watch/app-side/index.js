// Side Service de GymTrack (corre dentro de la app Zepp del móvil) · API 1.0
// FASE 4: recibe los datos del reloj y los sube a Supabase con la llave del reloj.
// La llave se obtiene canjeando el código de 6 dígitos que genera la web.
//
// settingsStorage (compartido con la pantalla de ajustes en la app Zepp):
//   pairCode       → código escrito por el usuario (lo canjeamos y lo borramos)
//   unlinkRequest  → el usuario pulsó "Desvincular"
//   token          → llave del reloj (secreta, no se muestra)
//   link           → estado de la vinculación (JSON) para la pantalla de ajustes
//   received       → últimos datos recibidos del reloj (para comprobar)
import { MessageBuilder } from '../shared/message'

const SUPABASE_URL = 'https://rladavncydlbcgizznxx.supabase.co'
const SUPABASE_KEY = 'sb_publishable_Qj97veGjMCnT-1PfAmLysA_5sIBf_vP' // clave pública (segura gracias a RLS)
const DEVICE_NAME = 'Amazfit GTR 3 Pro'

const messageBuilder = new MessageBuilder()
const storage = settings.settingsStorage

function readJSON(key, fallback) {
  try {
    const v = storage.getItem(key)
    return v ? JSON.parse(v) : fallback
  } catch (e) {
    return fallback
  }
}
function setLink(obj) {
  storage.setItem('link', JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)))
}

// Llama a una función de Supabase (RPC). En 1.0, fetch solo admite url, method, headers y body,
// y en algunos móviles res.body llega como texto: se convierte siempre.
async function rpc(fn, args) {
  const res = await fetch({
    url: SUPABASE_URL + '/rest/v1/rpc/' + fn,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify(args)
  })
  let body = res && res.body
  if (typeof body === 'string') body = body ? JSON.parse(body) : null
  if (body && body.message && body.code && body.ok === undefined) throw new Error(body.message)
  return body
}

/* ---------- vinculación ---------- */
const PAIR_ERRORS = {
  INVALID_CODE: 'Código incorrecto o caducado. Genera uno nuevo en la web.',
  TOO_MANY_ATTEMPTS: 'Demasiados intentos. Espera 10 minutos.'
}
async function pair(code) {
  setLink({ state: 'working' })
  try {
    const r = await rpc('claim_pairing_code', { p_code: code, p_device_name: DEVICE_NAME })
    if (!r || !r.ok) {
      setLink({ state: 'error', msg: PAIR_ERRORS[r && r.error] || 'No se pudo vincular.' })
      return
    }
    storage.setItem('token', r.token)
    await refreshStatus()
  } catch (e) {
    setLink({ state: 'error', msg: 'Sin conexión a internet. Inténtalo de nuevo.' })
  }
}
async function refreshStatus() {
  const token = storage.getItem('token')
  if (!token) return setLink({ state: 'unlinked' })
  try {
    const s = await rpc('watch_status', { p_token: token })
    if (s && s.ok) setLink({ state: 'linked', account: s.account, since: s.linkedAt })
    else {
      storage.removeItem('token')
      setLink({ state: 'unlinked', msg: 'El reloj fue desvinculado desde la web.' })
    }
  } catch (e) {
    // sin internet: se mantiene el estado anterior
  }
}
async function unlink() {
  const token = storage.getItem('token')
  storage.removeItem('token')
  setLink({ state: 'unlinked' })
  if (token) {
    try {
      await rpc('watch_unlink', { p_token: token })
    } catch (e) {}
  }
}

/* ---------- datos del reloj ---------- */
function logReceived(items) {
  // Copia ligera (sin la curva de pulso) de los últimos 40 datos, para verlos en Ajustes
  const log = readJSON('received', [])
  const seen = {}
  log.forEach((x) => (seen[x.id] = true))
  items.forEach((it) => {
    if (seen[it.id]) return
    const light = Object.assign({}, it)
    if (light.hrSeries) {
      light.hrPoints = light.hrSeries.length
      delete light.hrSeries
    }
    log.push(light)
  })
  storage.setItem('received', JSON.stringify(log.slice(-40)))
}

async function pushItems(items) {
  logReceived(items)
  const token = storage.getItem('token')
  if (!token) return { ok: false, error: 'NOT_LINKED', accepted: [] }
  const r = await rpc('watch_push', { p_token: token, p_items: items })
  if (r && r.error === 'NOT_LINKED') {
    storage.removeItem('token')
    setLink({ state: 'unlinked', msg: 'El reloj fue desvinculado desde la web.' })
  }
  if (r && r.ok) storage.setItem('lastSync', new Date().toISOString())
  return { ok: !!(r && r.ok), error: r && r.error, accepted: (r && r.accepted) || [], live: (r && r.live) || null }
}

// ¿Hay un entreno en curso (empezado en la web o en el reloj)?
async function getLive() {
  const token = storage.getItem('token')
  if (!token) return { ok: false, error: 'NOT_LINKED' }
  const r = await rpc('watch_live', { p_token: token })
  if (r && r.error === 'NOT_LINKED') {
    storage.removeItem('token')
    setLink({ state: 'unlinked', msg: 'El reloj fue desvinculado desde la web.' })
  }
  return { ok: !!(r && r.ok), error: r && r.error, live: (r && r.live) || null }
}

AppSideService({
  onInit() {
    messageBuilder.listen(() => {})

    settings.settingsStorage.addListener('change', async ({ key, newValue }) => {
      if (key === 'pairCode' && newValue) {
        // formato "123456#marca-de-tiempo" (la marca fuerza el aviso aunque repitas el código)
        const code = String(newValue).split('#')[0].replace(/\D/g, '')
        if (code.length === 6) await pair(code)
        else setLink({ state: 'error', msg: 'El código debe tener 6 dígitos.' })
      } else if (key === 'unlinkRequest' && newValue) {
        await unlink()
      } else if (key === 'statusRequest' && newValue) {
        await refreshStatus()
      }
    })

    messageBuilder.on('request', async (ctx) => {
      let req = {}
      try {
        req = messageBuilder.buf2Json(ctx.request.payload)
      } catch (e) {}
      try {
        if (req.method === 'PUSH_SETS') {
          ctx.response({ data: await pushItems(Array.isArray(req.items) ? req.items : []) })
        } else if (req.method === 'GET_LIVE') {
          ctx.response({ data: await getLive() })
        } else {
          ctx.response({ data: { ok: false, error: 'UNKNOWN_METHOD' } })
        }
      } catch (e) {
        // Sin internet u otro fallo: el reloj conserva los datos y reintentará
        console.log('side error ' + e)
        ctx.response({ data: { ok: false, error: 'NETWORK', accepted: [] } })
      }
    })
  },
  onRun() {},
  onDestroy() {}
})
