/**
 * Offline AEC regression: synthetic room + real Chinese speech.
 *
 *   say -v "Flo (中文（中国大陆）)" -o far.aiff  "接下来播放的视频声音，会从扬声器里传出来。"
 *   say -v "Flo (中文（中国大陆）)" -o near.aiff "大肥鱼你好，帮我看一下今天的工作安排。"
 *   afconvert -f WAVE -d LEI16@16000 far.aiff far.wav
 *   afconvert -f WAVE -d LEI16@16000 near.aiff near.wav
 *   node docs/aec-regression.mjs far.wav near.wav
 *
 * Prints the far-end ERLE and the near-end correlation during double talk.
 */
import { readFileSync } from 'node:fs'
import { createAecCore } from '../lib/aec-core.js'

const SR = 16000
const [farPath, nearPath] = process.argv.slice(2)
if (!farPath || !nearPath) {
  console.error('usage: node docs/aec-regression.mjs far.wav near.wav')
  process.exit(1)
}

/** Read a 16 kHz mono PCM wav file. */
function readWav (file) {
  const bytes = readFileSync(file)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') {
      const samples = new Float32Array(size / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(offset + 8 + i * 2, true) / 32768
      return samples
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

const far = readWav(farPath)
const nearSrc = readWav(nearPath)
const total = far.length
const near = new Float32Array(total)
near.set(nearSrc.subarray(0, Math.min(nearSrc.length, total - SR * 3)), SR * 3)

// 220 ms synthetic room: 40 ms direct path then a decaying diffuse tail.
const rir = new Float32Array(Math.round(0.22 * SR))
let seed = 7
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1 }
const direct = Math.round(0.04 * SR)
rir[direct] = 1
for (let i = direct + 8; i < rir.length; i++) rir[i] = random() * 0.35 * Math.exp(-((i - direct) / SR) / 0.06)

const mic = new Float32Array(total)
for (let n = 0; n < total; n++) {
  let echo = 0
  for (let k = 0; k < rir.length && k <= n; k++) echo += rir[k] * far[n - k]
  mic[n] = echo * 0.45 + near[n]
}

const aec = createAecCore()
const out = new Float32Array(total)
for (let start = 0; start + 256 <= total; start += 256) {
  aec.pushReference(far.subarray(start, start + 256))
  out.set(aec.process(mic.subarray(start, start + 256)), start)
}

const power = (x, a, b) => { let sum = 0; for (let i = a; i < b; i++) sum += x[i] * x[i]; return sum / Math.max(1, b - a) }
const db = (value) => 10 * Math.log10(Math.max(value, 1e-14))
const erle = db(power(mic, SR * 7.5, SR * 9)) - db(power(out, SR * 7.5, SR * 9))
const lag = aec.latencySamples
let cross = 0; let a = 0; let b = 0
for (let i = SR * 5; i < SR * 8; i++) { const x = out[i]; const y = near[i - lag]; cross += x * y; a += x * x; b += y * y }
console.log(`far-end ERLE      ${erle.toFixed(1)} dB`)
console.log(`near-end corr     ${(cross / Math.sqrt(a * b + 1e-12)).toFixed(2)}`)
