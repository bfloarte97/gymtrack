// Ajustes de GymTrack dentro de la app Zepp del móvil · API 1.0
// FASE 4: vincular el reloj con tu cuenta (código de 6 dígitos de la web)
// y ver los últimos datos recibidos del reloj.

function mmss(s) {
  s = Math.max(0, Math.round(s || 0))
  return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60)
}
function when(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n) => (n < 10 ? '0' : '') + n
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function fmtItem(it) {
  if (it.type === 'finish' && it.sets !== undefined) {
    const c = it.context || {}
    let txt = '✔ Fin de entreno · ' + mmss(it.durationSec) + ' · ' + it.sets + ' series · ' + it.kcal + ' kcal' +
      (it.avgHr ? ' · pulso medio ' + it.avgHr + ' (máx ' + it.maxHr + ')' : '')
    const pts = it.hrPoints || (it.hrSeries && it.hrSeries.length)
    if (pts) txt += ' · curva de pulso: ' + pts + ' puntos'
    if (c.sleepTotalMin) txt += ' · sueño ' + Math.floor(c.sleepTotalMin / 60) + 'h' + (c.sleepTotalMin % 60) + 'm'
    if (c.sleepScore) txt += ' (puntuación ' + c.sleepScore + ')'
    if (c.sleepHrMin) txt += ' · pulso mín. sueño ' + c.sleepHrMin
    if (c.paiWeek != null) txt += ' · PAI ' + Math.round(c.paiWeek)
    return txt
  }
  if (it.type === 'set' && it.durationSec !== undefined) {
    return 'Serie ' + it.setNumber + ': ' + mmss(it.durationSec) +
      (it.restBeforeSec ? ' · descanso previo ' + mmss(it.restBeforeSec) : '') +
      (it.restHrDrop60 != null ? ' · recuperó ' + it.restHrDrop60 + ' lpm en 60 s' : '') +
      (it.avgHr ? ' · ' + it.avgHr + ' lpm (máx ' + it.maxHr + ')' : '')
  }
  if (it.type === 'start') return '▶ Inicio de entreno' + (it.webSessionId ? ' (unido a la web)' : '')
  return 'Dato de una versión anterior'
}

const S = {
  title: { fontSize: '20px', marginBottom: '6px' },
  h2: { fontSize: '16px', marginTop: '18px', marginBottom: '6px' },
  muted: { fontSize: '13px', color: '#888' },
  box: { border: '1px solid #eaeaea', borderRadius: '8px', padding: '10px 12px', marginTop: '8px', backgroundColor: 'white' }
}

AppSettingsPage({
  build(props) {
    const st = props.settingsStorage
    let link = {}
    let received = []
    try {
      link = JSON.parse(st.getItem('link') || '{}')
    } catch (e) {}
    try {
      received = JSON.parse(st.getItem('received') || '[]')
    } catch (e) {}
    const linked = link.state === 'linked' && !!st.getItem('token')
    const last = st.getItem('lastSync')

    /* ----- Vinculación ----- */
    const linkBlock = linked
      ? View({ style: S.box }, [
          Text({ bold: true, style: { fontSize: '15px', color: '#1a7f37' } }, '✅ Reloj vinculado'),
          Text({ style: { fontSize: '14px', marginTop: '4px' } }, 'Cuenta: ' + (link.account || '')),
          Text({ style: S.muted }, 'Desde ' + when(link.since)),
          Text(
            { style: Object.assign({}, S.muted, { marginTop: '4px' }) },
            last ? 'Último envío a tu cuenta: ' + when(last) : 'Aún no se ha enviado ningún entreno.'
          ),
          Button({
            label: 'Desvincular reloj',
            style: { fontSize: '13px', marginTop: '10px' },
            onClick: () => st.setItem('unlinkRequest', String(Date.now()))
          })
        ])
      : View({ style: S.box }, [
          Text({ bold: true, style: { fontSize: '15px' } }, 'Vincular con tu cuenta GymTrack'),
          Text(
            { paragraph: true, style: Object.assign({}, S.muted, { marginTop: '4px' }) },
            '1. Abre GymTrack en la web → Más → Reloj → «Conectar reloj».  2. Escribe aquí el código de 6 dígitos que aparece.'
          ),
          TextInput({
            label: 'Código de 6 dígitos',
            placeholder: '123456',
            value: '',
            onChange: (val) => st.setItem('pairCode', String(val || '').trim() + '#' + Date.now())
          }),
          link.state === 'working' && Text({ style: { fontSize: '14px', color: '#555', marginTop: '6px' } }, 'Vinculando…'),
          link.msg && Text({ style: { fontSize: '14px', color: link.state === 'error' ? '#c62828' : '#555', marginTop: '6px' } }, link.msg)
        ])

    /* ----- Últimos datos recibidos ----- */
    const rows = received
      .slice()
      .reverse()
      .slice(0, 20)
      .map((it) =>
        View({ style: { borderBottom: '1px solid #eaeaea', padding: '8px 0' } }, [
          Text({ style: { fontSize: '13px', color: '#333' } }, fmtItem(it))
        ])
      )

    return View({ style: { padding: '12px 20px' } }, [
      Text({ bold: true, style: S.title }, 'GymTrack · Reloj'),
      linkBlock,
      Text({ bold: true, style: S.h2 }, 'Últimos datos del reloj'),
      rows.length > 0
        ? View({ style: S.box }, rows)
        : Text({ style: S.muted }, 'Aún no se ha recibido nada del reloj.'),
      rows.length > 0 &&
        Button({
          label: 'Borrar esta lista',
          style: { fontSize: '13px', marginTop: '10px' },
          onClick: () => st.setItem('received', '[]')
        })
    ])
  }
})
