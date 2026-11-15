/**
 * VoiceAec adaptive echo canceller.
 *
 * A partitioned block frequency-domain normalized LMS filter (overlap-save)
 * with double-talk detection and a residual-echo suppressor. It removes the
 * loudspeaker signal described by `pushReference()` from the microphone
 * signal passed to `process()`.
 *
 * The whole implementation lives inside one factory so a browser AudioWorklet
 * can receive its source text through `createAecCore.toString()` and run the
 * identical code off the main thread.
 *
 * @param {object} [options]
 * @param {number} [options.blockSize] FFT size; the hop is half of it.
 * @param {number} [options.partitions] Echo-path partitions (tail = partitions * hop).
 * @param {number} [options.stepSize] NLMS step size, 0..1.
 * @param {number} [options.suppression] Residual echo suppressor strength, 0 disables it.
 * @param {number} [options.targetDelay] Reference backlog kept ahead of the microphone, in samples.
 * @param {number} [options.micDelayBlocks] Microphone blocks held back so the streamed reference leads the echo.
 * @returns {{
 *   process: (mic: Float32Array) => Float32Array,
 *   pushReference: (samples: Float32Array) => void,
 *   reset: () => void,
 *   stats: () => { erle: number, micPower: number, outPower: number, echoPower: number, backlog: number, blocks: number },
 *   latencySamples: number,
 * }}
 */
export function createAecCore (options = {}) {
  const N = options.blockSize ?? 512
  const R = N >> 1
  const P = Math.max(1, options.partitions ?? 28)
  const MU = options.stepSize ?? 0.35
  const SUPPRESS = options.suppression ?? 0.6
  const TARGET = options.targetDelay ?? R * 3
  const MAX_DELAY = Math.min(P * R - R, Math.max(TARGET * 4, R * 8))
  const MIC_DELAY = Math.max(0, Math.round(options.micDelayBlocks ?? 10))
  const DTD = options.doubleTalkDetection ?? false
  const BINS = N >> 1

  // --- FFT tables ---------------------------------------------------------
  const cosTable = new Float32Array(BINS)
  const sinTable = new Float32Array(BINS)
  for (let i = 0; i < BINS; i++) {
    cosTable[i] = Math.cos((2 * Math.PI * i) / N)
    sinTable[i] = Math.sin((2 * Math.PI * i) / N)
  }
  const reverse = new Uint16Array(N)
  const bits = Math.round(Math.log2(N))
  for (let i = 0; i < N; i++) {
    let value = i
    let mirror = 0
    for (let b = 0; b < bits; b++) {
      mirror = (mirror << 1) | (value & 1)
      value >>= 1
    }
    reverse[i] = mirror
  }

  /**
   * In-place radix-2 complex FFT.
   * @param {Float32Array} re - real part, length N.
   * @param {Float32Array} im - imaginary part, length N.
   */
  function fft (re, im) {
    for (let i = 0; i < N; i++) {
      const j = reverse[i]
      if (j > i) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp
        tmp = im[i]; im[i] = im[j]; im[j] = tmp
      }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1
      const twiddleStep = N / size
      for (let start = 0; start < N; start += size) {
        for (let k = 0; k < half; k++) {
          const tw = k * twiddleStep
          const wr = cosTable[tw]
          const wi = -sinTable[tw]
          const a = start + k
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }

  /** Inverse FFT: conjugate, transform, conjugate, scale. */
  function ifft (re, im) {
    for (let i = 0; i < N; i++) im[i] = -im[i]
    fft(re, im)
    const scale = 1 / N
    for (let i = 0; i < N; i++) {
      re[i] *= scale
      im[i] = -im[i] * scale
    }
  }

  // --- Adaptive filter state ---------------------------------------------
  const weightRe = new Float32Array(P * N)
  const weightIm = new Float32Array(P * N)
  const refRe = new Float32Array(P * N)
  const refIm = new Float32Array(P * N)

  const micTime = new Float32Array(N)
  const errTime = new Float32Array(N)
  const echoRe = new Float32Array(N)
  const echoIm = new Float32Array(N)
  const echoSpecRe = new Float32Array(N)
  const echoSpecIm = new Float32Array(N)
  const errRe = new Float32Array(N)
  const errIm = new Float32Array(N)
  const xRe = new Float32Array(N)
  const xIm = new Float32Array(N)
  const power = new Float32Array(N)
  const gradRe = new Float32Array(N)
  const gradIm = new Float32Array(N)

  const gainSmoothed = new Float32Array(BINS + 1).fill(1)
  const output = new Float32Array(R)
  const refBlock = new Float32Array(R)
  const prevRef = new Float32Array(R)
  const micRing = new Float32Array(R * Math.max(1, MIC_DELAY))
  let micIndex = 0
  let micFilled = 0

  let refQueue = new Float32Array(R * 16)
  let refHead = 0
  let refCount = 0
  let dropped = 0

  let muScale = 1
  let erleSmoothed = 0
  let micPower = 0
  let outPower = 0
  let echoPower = 0
  let pump = 0

  function pushReference (samples) {
    if (samples.length === 0) return
    if (refCount + samples.length > refQueue.length) {
      const grown = new Float32Array(Math.max(refQueue.length * 2, refCount + samples.length))
      for (let i = 0; i < refCount; i++) grown[i] = refQueue[(refHead + i) % refQueue.length]
      refQueue = grown
      refHead = 0
    }
    const tail = (refHead + refCount) % refQueue.length
    const first = Math.min(samples.length, refQueue.length - tail)
    refQueue.set(samples.subarray(0, first), tail)
    if (first < samples.length) refQueue.set(samples.subarray(first), 0)
    refCount += samples.length
  }

  /**
   * Take one block for the filter. A reference that arrives faster than the
   * microphone clock is trimmed one sample at a time so the echo path stays
   * inside the filter tail; starvation repeats the newest sample.
   * @returns {boolean} whether the block was fully backed by reference audio.
   */
  function takeReference () {
    if (refCount > MAX_DELAY) {
      const excess = refCount - TARGET
      const trim = Math.min(excess, Math.max(1, Math.round(excess / 16)))
      refHead = (refHead + trim) % refQueue.length
      refCount -= trim
      dropped += trim
    }
    const usable = Math.min(refCount, R)
    for (let i = 0; i < usable; i++) refBlock[i] = refQueue[(refHead + i) % refQueue.length]
    const filler = usable > 0 ? refBlock[usable - 1] : 0
    for (let i = usable; i < R; i++) refBlock[i] = filler
    refHead = (refHead + usable) % refQueue.length
    refCount -= usable
    return usable === R
  }

  function process (mic) {
    const usableMic = Math.min(mic.length, R)

    micTime.copyWithin(0, R)
    if (MIC_DELAY === 0) {
      micTime.set(mic.subarray(0, usableMic), R)
      for (let i = usableMic; i < R; i++) micTime[R + i] = 0
    } else {
      const slot = micIndex * R
      for (let i = 0; i < R; i++) micTime[R + i] = micRing[slot + i]
      for (let i = 0; i < usableMic; i++) micRing[slot + i] = mic[i]
      for (let i = usableMic; i < R; i++) micRing[slot + i] = 0
      micIndex = (micIndex + 1) % MIC_DELAY
      if (micFilled < MIC_DELAY) micFilled++
    }

    const fresh = takeReference()

    // Newest reference block: [previous R samples][this block].
    xRe.set(prevRef, 0)
    xRe.set(refBlock, R)
    prevRef.set(refBlock)
    xIm.fill(0)
    fft(xRe, xIm)

    // Rotate partition spectra so index 0 stays the newest.
    for (let p = P - 1; p >= 1; p--) {
      refRe.copyWithin(p * N, (p - 1) * N, p * N)
      refIm.copyWithin(p * N, (p - 1) * N, p * N)
    }
    refRe.set(xRe, 0)
    refIm.set(xIm, 0)

    // Echo estimate and reference power.
    echoRe.fill(0)
    echoIm.fill(0)
    power.fill(0)
    for (let p = 0; p < P; p++) {
      const offset = p * N
      for (let k = 0; k < N; k++) {
        const xr = refRe[offset + k]
        const xi = refIm[offset + k]
        const wr = weightRe[offset + k]
        const wi = weightIm[offset + k]
        echoRe[k] += wr * xr - wi * xi
        echoIm[k] += wr * xi + wi * xr
        power[k] += xr * xr + xi * xi
      }
    }
    echoSpecRe.set(echoRe)
    echoSpecIm.set(echoIm)
    ifft(echoRe, echoIm)

    let micSum = 0
    let echoSum = 0
    let errSum = 0
    errTime.fill(0)
    for (let i = 0; i < R; i++) {
      const micValue = micTime[R + i]
      const echo = echoRe[R + i]
      const err = micValue - echo
      errTime[R + i] = err
      micSum += micValue * micValue
      echoSum += echo * echo
      errSum += err * err
    }

    const micP = micSum / R + 1e-12
    const echoP = echoSum / R + 1e-12
    const errP = errSum / R + 1e-12
    const erleDb = 10 * Math.log10(micP / Math.max(errP, 1e-12))
    erleSmoothed = 0.98 * erleSmoothed + 0.02 * erleDb

    // Freeze adaptation during near-end speech; idle when there is no echo.
    let target = 1
    if (echoP < 1e-8) target = 0.02
    else if (DTD && errP > 0.6 * micP && micP > 4 * echoP) target = 0.02
    else if (errP > 0.85 * micP) target = 0.2
    muScale = 0.7 * muScale + 0.3 * target
    const mu = fresh ? MU * muScale : 0

    // Error spectrum for the normalized gradient.
    errRe.set(errTime)
    errIm.fill(0)
    fft(errRe, errIm)
    for (let p = 0; p < P; p++) {
      const offset = p * N
      for (let k = 0; k < N; k++) {
        const xr = refRe[offset + k]
        const xi = refIm[offset + k]
        const er = errRe[k]
        const ei = errIm[k]
        const denominator = power[k] + 1e-6
        gradRe[k] = (xr * er + xi * ei) / denominator
        gradIm[k] = (xr * ei - xi * er) / denominator
      }
      for (let k = 0; k < N; k++) {
        weightRe[offset + k] += mu * gradRe[k]
        weightIm[offset + k] += mu * gradIm[k]
      }
    }

    // Residual echo suppression, mirrored onto the negative frequencies.
    let outSum = 0
    if (SUPPRESS > 0) {
      for (let k = 0; k <= BINS; k++) {
        const echoBand = echoSpecRe[k] * echoSpecRe[k] + echoSpecIm[k] * echoSpecIm[k]
        const errBand = errRe[k] * errRe[k] + errIm[k] * errIm[k]
        const gain = Math.max(0.25, 1 - SUPPRESS * echoBand / (errBand + 1e-9))
        gainSmoothed[k] = 0.7 * gainSmoothed[k] + 0.3 * gain
        const g = gainSmoothed[k]
        errRe[k] *= g
        errIm[k] *= g
        outSum += errBand * g * g
        if (k > 0 && k < BINS) {
          const mirror = N - k
          errRe[mirror] = errRe[k]
          errIm[mirror] = -errIm[k]
        }
      }
      ifft(errRe, errIm)
      for (let i = 0; i < R; i++) output[i] = errRe[R + i]
    } else {
      for (let i = 0; i < R; i++) output[i] = errTime[R + i]
      outSum = errSum
    }

    micPower = micP
    outPower = outSum / (R + 1e-12)
    echoPower = echoP
    pump++
    return output
  }

  return {
    process,
    pushReference,
    reset () {
      weightRe.fill(0); weightIm.fill(0)
      refRe.fill(0); refIm.fill(0); prevRef.fill(0)
      gainSmoothed.fill(1)
      refHead = 0; refCount = 0; dropped = 0
      micRing.fill(0); micIndex = 0; micFilled = 0
      muScale = 1
      erleSmoothed = 0
      micPower = 0; outPower = 0; echoPower = 0
      pump++
    },
    stats () {
      return {
        erle: erleSmoothed,
        micPower,
        outPower,
        echoPower,
        backlog: refCount,
        micFilled,
        dropped,
        blocks: pump,
      }
    },
    latencySamples: R * MIC_DELAY,
  }
}
