// Guardar y leer datos en archivos del reloj (carpeta /data de la mini app).
// Usa hmFS (API 1.0) con el mismo formato que shared/fs.js del ejemplo oficial.

function str2buf(str) {
  const buf = new ArrayBuffer(str.length * 2)
  const view = new Uint16Array(buf)
  for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i)
  return buf
}

function buf2str(buf) {
  const view = new Uint16Array(buf)
  let out = ''
  for (let i = 0; i < view.length; i += 2048) {
    out += String.fromCharCode.apply(null, view.subarray(i, i + 2048))
  }
  return out
}

export function readJSON(name, fallback) {
  try {
    const [stat, err] = hmFS.stat(name)
    if (err !== 0 || !stat || !stat.size) return fallback
    const buf = new ArrayBuffer(stat.size)
    const file = hmFS.open(name, hmFS.O_RDONLY)
    hmFS.seek(file, 0, hmFS.SEEK_SET)
    hmFS.read(file, buf, 0, stat.size)
    hmFS.close(file)
    return JSON.parse(buf2str(buf))
  } catch (e) {
    console.log('readJSON error ' + name + ': ' + e)
    return fallback
  }
}

export function writeJSON(name, data) {
  try {
    const buf = str2buf(JSON.stringify(data))
    const file = hmFS.open(name, hmFS.O_CREAT | hmFS.O_RDWR | hmFS.O_TRUNC)
    hmFS.seek(file, 0, hmFS.SEEK_SET)
    hmFS.write(file, buf, 0, buf.byteLength)
    hmFS.close(file)
  } catch (e) {
    console.log('writeJSON error ' + name + ': ' + e)
  }
}

export function removeFile(name) {
  try {
    hmFS.remove(name)
  } catch (e) {}
}
