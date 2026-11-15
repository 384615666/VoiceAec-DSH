/**
 * VoiceAec for DeepSeek Harness — Client half (source).
 *
 * `build.mjs` inlines `createAecCore` from `aec-core.js` and writes `client.js`.
 *
 * The Client half patches `navigator.mediaDevices.getUserMedia` so the official
 * voice-input plugin records an echo-cancelled microphone while a video keeps
 * playing through the speakers. The echo reference arrives from
 * `/api/voiceaec/reference` (Host half) and is consumed by an AudioWorklet.
 */

window.__ModuleLoader__.load({
  id: 'dsh-voiceaec',
  factory (require) {
    const React = require('react')
    const h = React.createElement

    const createAecCore = function createAecCore (options = {}) {
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

    const NS = 'voiceaec'
    const ENABLED_KEY = 'dsh.voiceaec.enabled'
    const STATUS_URL = '/api/voiceaec/status'
    const REFERENCE_URL = '/api/voiceaec/reference'
    const SAMPLE_RATE = 16000
    const BLOCK = 256

    const messages = {
      zh: {
        title: '回声消除',
        on: '已开启，视频继续播放也没关系',
        off: '已关闭：麦克风按浏览器默认方式录音',
        unavailable: '当前系统不支持系统声音回采',
        idle: '正在检查…',
        armed: '已开启 · 点麦克风说话',
        noVoiceInput: '语音输入未就绪',
        starting: '正在启动参考声…',
        ready: '参考声就绪',
        silent: '参考声静默：请确认外放正在播放',
        recording: '正在消除回声',
        error: '回声消除启动失败，已回退浏览器降噪',
        toggleOn: '开启后语音输入会减去外放的声音',
        toggleOff: '点击重新开启',
        armedHint: '已开启：点语音输入的麦克风后会自动消除外放回声',
        noVoiceInputHint: '语音输入插件未生效：请在 Plugins 里启用 Voice input，或升级到与 Harness 相同的 0.2.1-rc.4（详见 docs/manual.md 附录 C）',
      },
      en: {
        title: 'Echo cancel',
        on: 'On — keep the video playing',
        off: 'Off — browser microphone processing only',
        unavailable: 'System audio capture is unavailable here',
        idle: 'Checking…',
        armed: 'On — click the microphone',
        noVoiceInput: 'Voice input is not ready',
        starting: 'Starting reference audio…',
        ready: 'Reference ready',
        silent: 'Reference silent — is playback audible?',
        recording: 'Cancelling echo',
        error: 'Echo cancellation failed; using browser processing',
        toggleOn: 'Voice input subtracts loudspeaker audio while on',
        toggleOff: 'Click to turn back on',
        armedHint: 'On: echo is cancelled whenever voice input records',
        noVoiceInputHint: 'Voice input plugin is not active: enable Voice input in Plugins, or update it to 0.2.1-rc.4 (see docs/manual.md, appendix C)',
      },
    }

    const state = {
      enabled: localStorage.getItem(ENABLED_KEY) !== '0',
      host: undefined,
      phase: 'idle',
      erle: 0,
      reference: -120,
      error: undefined,
      recording: 0,
      localeTick: 0,
      listeners: new Set(),
    }

    let t = (key) => key
    let openVoiceInputPlugins
    let statusTimer

    function notify () {
      for (const listener of state.listeners) {
        try { listener() } catch (error) { console.error('[voiceaec]', error) }
      }
    }

    function subscribe (listener) {
      state.listeners.add(listener)
      return () => { state.listeners.delete(listener) }
    }

    function setEnabled (value) {
      state.enabled = value
      try { localStorage.setItem(ENABLED_KEY, value ? '1' : '0') } catch {}
      notify()
    }

    function snapshot () {
      return {
        enabled: state.enabled,
        host: state.host,
        phase: state.phase,
        erle: state.erle,
        reference: state.reference,
        error: state.error,
        recording: state.recording,
        localeTick: state.localeTick,
      }
    }

    /** Ask the Host half for its lifecycle and level state. */
    async function refreshHost () {
      try {
        const response = await fetch(STATUS_URL, { cache: 'no-store' })
        if (!response.ok) throw new Error(`status ${response.status}`)
        state.host = await response.json()
        if (state.host.error) state.error = state.host.error
        if (!state.recording && state.phase === 'idle' && state.host.running) state.phase = 'ready'
      } catch (error) {
        state.host = { supported: false, error: error.message }
      }
      notify()
    }

    /**
     * Rewrite the audio constraints so the browser does not apply its own
     * echo canceller on top of ours.
     * @param {MediaStreamConstraints} constraints - original request.
     * @returns {MediaStreamConstraints} request for the raw microphone.
     */
    function rawConstraints (constraints) {
      const audio = constraints.audio
      const base = typeof audio === 'object' && audio !== null ? { ...audio } : {}
      return { ...constraints, audio: { ...base, echoCancellation: false, noiseSuppression: false, autoGainControl: true } }
    }

    /** @param {MediaStreamConstraints} constraints - request to classify. */
    function wantsEchoCancellation (constraints) {
      if (!constraints || constraints.video) return false
      if (constraints.audio === undefined || constraints.audio === false) return false
      if (typeof constraints.audio === 'object' && constraints.audio !== null && constraints.audio.echoCancellation === false) return false
      return state.enabled
    }

    /** @returns {string} AudioWorklet source with the AEC core embedded. */
    function workletSource () {
      return `
${createAecCore.toString()}
class VoiceAecProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super()
    this.aec = createAecCore(options.processorOptions || {})
    this.input = new Float32Array(${BLOCK})
    this.filled = 0
    this.output = new Float32Array(${BLOCK})
    this.outputAt = ${BLOCK}
    this.reported = 0
    this.port.onmessage = (event) => {
      const message = event.data
      if (message.type === 'reference') this.aec.pushReference(message.samples)
      else if (message.type === 'reset') this.aec.reset()
    }
  }
  process (inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    const output = outputs[0][0]
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.input[this.filled++] = input[i]
        if (this.filled === ${BLOCK}) {
          this.output.set(this.aec.process(this.input))
          this.outputAt = 0
          this.filled = 0
        }
      }
    }
    for (let i = 0; i < output.length; i++) {
      output[i] = this.outputAt < ${BLOCK} ? this.output[this.outputAt++] : 0
    }
    this.reported += output.length
    if (this.reported >= ${SAMPLE_RATE * 0.25}) {
      this.reported = 0
      const stats = this.aec.stats()
      this.port.postMessage({ type: 'stats', erle: stats.erle, micPower: stats.micPower, outPower: stats.outPower })
    }
    return true
  }
}
registerProcessor('voiceaec-aec', VoiceAecProcessor)
`
    }

    /**
     * Fetch the reference stream and forward PCM to the canceller.
     * @param {{feed: (samples: Float32Array) => void}} sink - receives 16 kHz mono.
     * @param {AbortSignal} signal - stops the stream.
     */
    async function pumpReference (sink, signal) {
      const response = await fetch(REFERENCE_URL, {
        cache: 'no-store',
        signal,
        headers: { accept: 'application/octet-stream' },
      })
      if (!response.ok || !response.body) throw new Error(`reference stream ${response.status}`)
      const reader = response.body.getReader()
      let carry = new Uint8Array(0)
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        let bytes = value
        if (carry.length > 0) {
          bytes = new Uint8Array(carry.length + value.length)
          bytes.set(carry)
          bytes.set(value, carry.length)
        }
        const paired = bytes.length - (bytes.length % 2)
        carry = paired === bytes.length ? new Uint8Array(0) : bytes.slice(paired)
        if (paired === 0) continue
        const view = new DataView(bytes.buffer, bytes.byteOffset, paired)
        const samples = new Float32Array(paired / 2)
        let sum = 0
        for (let i = 0; i < samples.length; i++) {
          const sample = view.getInt16(i * 2, true) / 32768
          samples[i] = sample
          sum += sample * sample
        }
        state.reference = samples.length > 0 ? Math.sqrt(sum / samples.length) : 0
        sink.feed(samples)
      }
    }

    /**
     * Build the echo-cancelled microphone stream.
     * @param {MediaStream} raw - microphone stream acquired with browser AEC off.
     * @returns {Promise<MediaStream>} stream whose single track carries clean audio.
     */
    async function attachCanceller (raw) {
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
      if (audioContext.state === 'suspended') await audioContext.resume()
      if (audioContext.state !== 'running') {
        await audioContext.close().catch(() => {})
        throw new Error(`AudioContext stayed ${audioContext.state}`)
      }
      const source = audioContext.createMediaStreamSource(raw)
      const destination = audioContext.createMediaStreamDestination()
      const controller = new AbortController()

      let processor
      let node
      try {
        const url = URL.createObjectURL(new Blob([workletSource()], { type: 'application/javascript' }))
        try {
          await audioContext.audioWorklet.addModule(url)
        } finally {
          URL.revokeObjectURL(url)
        }
        node = new AudioWorkletNode(audioContext, 'voiceaec-aec', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { blockSize: 512, partitions: 28, stepSize: 0.35, suppression: 0.6 },
        })
        processor = {
          node,
          feed (samples) { node.port.postMessage({ type: 'reference', samples }, [samples.buffer]) },
        }
        node.port.onmessage = (event) => {
          if (event.data?.type !== 'stats') return
          state.erle = event.data.erle
          notify()
        }
      } catch (error) {
        console.warn('[voiceaec] AudioWorklet unavailable, using ScriptProcessor', error)
        const aec = createAecCore({ blockSize: 512, partitions: 28, stepSize: 0.35, suppression: 0.6 })
        node = audioContext.createScriptProcessor(BLOCK, 1, 1)
        node.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0)
          const output = event.outputBuffer.getChannelData(0)
          output.set(aec.process(input))
        }
        processor = { node, feed (samples) { aec.pushReference(samples) } }
      }

      source.connect(node)
      node.connect(destination)

      state.phase = 'recording'
      state.recording++
      state.error = undefined
      notify()

      pumpReference(processor, controller.signal).catch((error) => {
        if (controller.signal.aborted) return
        state.error = error.message
        state.phase = 'error'
        notify()
      })

      const outputTrack = destination.stream.getAudioTracks()[0]
      const rawTracks = raw.getAudioTracks()
      let released = false
      const release = () => {
        if (released) return
        released = true
        controller.abort()
        try { source.disconnect() } catch {}
        try { node.disconnect() } catch {}
        for (const track of rawTracks) {
          try { track.stop() } catch {}
        }
        audioContext.close().catch(() => {})
        state.recording = Math.max(0, state.recording - 1)
        if (state.recording === 0) {
          state.phase = 'ready'
          state.erle = 0
          notify()
        }
      }
      for (const track of rawTracks) track.addEventListener('ended', release, { once: true })
      const stop = outputTrack.stop.bind(outputTrack)
      try {
        outputTrack.stop = () => { release(); stop() }
      } catch (error) {
        console.warn('[voiceaec] cannot observe track stop', error)
      }
      return new MediaStream([outputTrack])
    }

    /** Install the microphone interceptor. */
    function patchMicrophone () {
      const devices = navigator.mediaDevices
      if (!devices || typeof devices.getUserMedia !== 'function') return () => {}
      const original = devices.getUserMedia.bind(devices)
      devices.getUserMedia = async (constraints) => {
        if (!wantsEchoCancellation(constraints)) return original(constraints)
        if (state.host && state.host.supported === false) return original(constraints)
        let raw
        try {
          raw = await original(rawConstraints(constraints))
        } catch (error) {
          throw error
        }
        try {
          return await attachCanceller(raw)
        } catch (error) {
          console.warn('[voiceaec] echo cancellation failed, falling back', error)
          state.error = error.message
          state.phase = 'error'
          notify()
          raw.getTracks().forEach((track) => { try { track.stop() } catch {} })
          return original(constraints)
        }
      }
      return () => { devices.getUserMedia = original }
    }

    function phaseKey () {
      if (!state.host) return 'idle'
      if (state.host.supported === false) return 'unavailable'
      if (state.phase === 'recording') return 'recording'
      if (state.error) return 'error'
      if (state.host.running) return state.host.level > -70 ? 'ready' : 'silent'
      if (state.host.voiceInput === false) return 'noVoiceInput'
      return state.phase === 'starting' ? 'starting' : 'armed'
    }

    function tone (phase) {
      switch (phase) {
        case 'recording':
        case 'ready': return 'var(--dsw-alias-state-success-primary)'
        case 'silent':
        case 'noVoiceInput': return 'var(--dsw-alias-state-warn-primary)'
        case 'error':
        case 'unavailable': return 'var(--dsw-alias-state-error-primary)'
        default: return 'var(--dsw-alias-state-idle-primary)'
      }
    }

    function label (phase) {
      if (!state.enabled) return t('off')
      return t(phase)
    }

    function reportClientError (error) {
      const message = String(error && error.message ? error.message : error).slice(0, 300)
      console.error('[voiceaec]', message)
      fetch(`${STATUS_URL}?clientError=${encodeURIComponent(message)}`, { cache: 'no-store' }).catch(() => {})
    }

    function Pill () {
      const [current, setCurrent] = React.useState(snapshot())
      React.useEffect(() => {
        // One heartbeat proves this bundle's Client half rendered and can
        // reach the Host half; the pill shows the same state it reports.
        fetch(`${STATUS_URL}?mounted=1`, { cache: 'no-store' }).catch(() => {})
        return subscribe(() => setCurrent(snapshot()))
      }, [])
      try {
        return renderPill(current)
      } catch (error) {
        reportClientError(error)
        return null
      }
    }

    function renderPill (current) {
      const phase = current.enabled ? phaseKey() : 'off'
      const colors = tone(phase)
      const detail = phase === 'recording' ? `${Math.max(0, Math.round(current.erle))} dB` : ''
      const status = phase === 'recording' ? t('recording') : label(phase)
      const hint = phase === 'noVoiceInput'
        ? t('noVoiceInputHint')
        : phase === 'armed'
          ? t('armedHint')
          : state.enabled ? t('toggleOn') : t('toggleOff')
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '6px', margin: '0 0 0 2px',
          font: 'var(--dsw-font-caption, 11px/16px system-ui)', color: 'var(--dsw-alias-label-secondary)',
          userSelect: 'none',
        },
      },
      h('button', {
        type: 'button',
        onClick: () => {
          if (phase === 'noVoiceInput' && openVoiceInputPlugins) {
            openVoiceInputPlugins()
            return
          }
          setEnabled(!state.enabled)
        },
        title: phase === 'noVoiceInput' ? t('noVoiceInputHint') : hint,
        'aria-pressed': state.enabled,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '2px 8px 2px 7px', height: '22px', borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
          fontSize: '11px', lineHeight: '16px',
        },
      },
      h('span', {
        'aria-hidden': true,
        style: {
          width: '6px', height: '6px', borderRadius: '50%', background: colors,
          boxShadow: phase === 'recording' ? `0 0 0 3px color-mix(in srgb, ${colors} 22%, transparent)` : 'none',
        },
      }),
      h('span', null, t('title')),
      phase === 'recording'
        ? h('span', { style: { opacity: 0.75, fontVariantNumeric: 'tabular-nums' } }, detail)
        : null),
      h('span', { style: { opacity: 0.8 } }, status))
    }

    return {
      inject: ['slots', 'locale'],
      apply (ctx) {
        t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, messages))
        ctx.effect(() => ctx.locale.subscribe(() => { state.localeTick++; notify() }))

        ctx.effect(() => patchMicrophone())

        // Without the official voice-input plugin there is nothing to cancel;
        // clicking the pill then opens that bundle's page instead of toggling.
        ctx.inject(['pluginNavigation'], (scope) => {
          const navigation = scope.pluginNavigation
          openVoiceInputPlugins = () => navigation?.openBundle?.('@deepseek-ai/dsh-experimental-voice-input-bundle')
          return () => { openVoiceInputPlugins = undefined }
        })

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'voiceaec',
          order: 2,
          label: () => t('title'),
        }, Pill))

        // Keep an eye on the Host half: the pill mirrors whether the reference
        // capture is running and whether any system audio reaches it.
        refreshHost()
        if (!statusTimer) {
          statusTimer = setInterval(refreshHost, 5000)
        }
        ctx.effect(() => () => {
          if (statusTimer) clearInterval(statusTimer)
          statusTimer = undefined
        })

      },
    }
  },
})
