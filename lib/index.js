/**
 * VoiceAec for DeepSeek Harness — Host half.
 *
 * Captures the system's playback mix with a Core Audio process tap (macOS
 * 14.4+), downsamples it to 16 kHz mono and streams it to the Web UI as the
 * echo reference for {@link ./client.js}. The Client half runs the adaptive
 * echo canceller inside an AudioWorklet while voice input records, so the
 * microphone keeps working while a video keeps playing through the speakers.
 *
 * Routes:
 *   GET /api/voiceaec/status     JSON lifecycle and level information
 *   GET /api/voiceaec/reference  s16le 16 kHz mono reference PCM
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(here, '..')
const SOURCE = path.join(packageDir, 'native', 'voiceaec-tap.swift')
const SHIPPED = path.join(packageDir, 'native', 'voiceaec-tap')
const VERSION = '0.1.0'
const IDLE_STOP_MS = 20_000
const CHUNK_BYTES = 640 // 20 ms of s16le mono at 16 kHz

/** @returns {string} Where a locally built helper is cached. */
function cacheDir () {
  const dir = path.join(homedir(), '.dsh', 'voiceaec', 'bin')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Pick the helper executable: a shipped binary when present, otherwise a
 * cached build, otherwise compile the Swift source once.
 * @returns {Promise<string>} Absolute helper path.
 */
async function resolveHelper () {
  const cached = path.join(cacheDir(), 'voiceaec-tap')
  const fresh = (p) => existsSync(p) && statSync(p).size > 0
  if (fresh(SHIPPED) && statSync(SHIPPED).mtimeMs >= statSync(SOURCE).mtimeMs) return SHIPPED
  if (fresh(cached)) return cached
  await new Promise((resolve, reject) => {
    const builder = spawn('swiftc', ['-O', SOURCE, '-o', cached], { stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    builder.stdout.on('data', (chunk) => { diagnostics += chunk })
    builder.stderr.on('data', (chunk) => { diagnostics += chunk })
    builder.on('error', (error) => reject(new Error(`swiftc unavailable: ${error.message}`)))
    builder.on('exit', (code) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`swiftc failed (${code}): ${diagnostics.slice(-800)}`))
    })
  })
  return cached
}

/**
 * One shared reference capture process plus its fan-out to route listeners.
 */
class ReferenceCapture {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {{ device?: string }} [config] - plugin configuration.
   */
  constructor (ctx, config) {
    this.ctx = ctx
    this.config = config ?? {}
    this.child = undefined
    this.starting = undefined
    this.listeners = new Set()
    this.remainder = Buffer.alloc(0)
    this.level = 0
    this.peak = 0
    this.events = []
    this.error = undefined
    this.inputRate = 0
    this.failures = 0
    this.idleTimer = undefined
    this.stderr = ''
    this.bytes = 0
    this.clientMountedAt = 0
    this.clientError = undefined
  }

  get supported () {
    if (process.platform !== 'darwin') return false
    if (parseInt(process.versions.napi ?? '0', 10) < 0) return false
    const [major] = process.versions.node.split('.').map(Number)
    return major >= 18
  }

  get running () {
    return this.child !== undefined && this.child.exitCode === null
  }

  status () {
    return {
      version: VERSION,
      platform: process.platform,
      supported: this.supported,
      running: this.running,
      sampleRate: 16000,
      channels: 1,
      format: 's16le',
      inputRate: this.inputRate,
      level: round(this.level),
      peak: round(this.peak),
      listeners: this.listeners.size,
      error: this.error,
      device: this.config.device ?? 'system-default',
      bytes: this.bytes,
      clientMounted: this.clientMountedAt > 0,
      clientError: this.clientError,
    }
  }

  /** Start the capture process if it is not already running. */
  async ensure () {
    if (this.running) return
    if (!this.supported) throw new Error('System audio capture is available on macOS only')
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  async start () {
    const binary = await resolveHelper()
    if (this.running) return
    const env = { ...process.env }
    if (this.config.device) env.VOICEAEC_DEVICE = this.config.device
    const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'], env })
    this.child = child
    this.error = undefined
    this.stderr = ''

    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.stderr.on('data', (chunk) => this.onDiagnostics(chunk.toString('utf8')))
    child.on('error', (error) => {
      this.error = error.message
      this.child = undefined
    })
    child.on('exit', (code, signal) => {
      this.child = undefined
      this.level = 0
      if (this.listeners.size > 0 && !this.stopping) {
        this.failures += 1
        this.error = code === 0 ? 'capture stopped unexpectedly' : `capture exited with code ${code}${signal ? ` (${signal})` : ''}`
        if (this.failures <= 3) setTimeout(() => { this.ensure().catch(() => {}) }, 800)
      }
    })
    this.ctx.logger?.info?.('voiceaec: reference capture started')
  }

  /** @param {Buffer} chunk - raw s16le bytes from the helper. */
  consume (chunk) {
    this.bytes += chunk.length
    const data = this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk
    const usable = data.length - (data.length % CHUNK_BYTES)
    this.remainder = usable === data.length ? Buffer.alloc(0) : data.subarray(usable)
    if (usable === 0) return
    const frame = Buffer.from(data.subarray(0, usable))
    let sum = 0
    let peak = 0
    for (let i = 0; i < frame.length - 1; i += 2) {
      const value = frame.readInt16LE(i) / 32768
      sum += value * value
      const magnitude = Math.abs(value)
      if (magnitude > peak) peak = magnitude
    }
    const samples = frame.length / 2
    this.level = Math.sqrt(sum / samples) * 0.7 + this.level * 0.3
    this.peak = Math.max(peak, this.peak * 0.9)
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch (error) {
        this.ctx.logger?.warn?.(`voiceaec: listener failed: ${error.message}`)
      }
    }
  }

  /** @param {string} text - JSON lines from the helper's stderr. */
  onDiagnostics (text) {
    this.stderr = (this.stderr + text).slice(-4000)
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line)
        if (event.event === 'ready') {
          this.inputRate = event.inputRate ?? 0
          this.failures = 0
          this.error = undefined
        } else if (event.event === 'error') {
          this.error = event.message ?? 'capture error'
        }
        this.events.push({ at: Date.now(), ...event })
        if (this.events.length > 20) this.events.shift()
      } catch {
        this.events.push({ at: Date.now(), event: 'stderr', text: line.slice(0, 300) })
        if (this.events.length > 20) this.events.shift()
      }
    }
  }

  /**
   * Attach a listener for 20 ms PCM frames.
   * @param {(frame: Buffer) => void} listener - receives raw s16le frames.
   * @returns {() => void} detach.
   */
  subscribe (listener) {
    this.listeners.add(listener)
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.ensure().catch((error) => { this.error = error.message })
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.idleTimer === undefined) {
        this.idleTimer = setTimeout(() => { this.stop() }, IDLE_STOP_MS)
        this.idleTimer.unref?.()
      }
    }
  }

  stop () {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    const child = this.child
    if (!child) return
    this.stopping = true
    child.kill('SIGTERM')
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 1500)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      this.stopping = false
    })
  }

  dispose () {
    this.listeners.clear()
    this.stop()
  }
}

/** @param {number} value - linear level. @returns {number} dBFS, one decimal. */
function round (value) {
  if (!Number.isFinite(value) || value <= 0) return -120
  return Math.max(-120, Math.round(20 * Math.log10(value) * 10) / 10)
}

export const name = 'voiceaec'

export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ device?: string }} [config] - optional capture device name.
 */
export function apply (ctx, config) {
  const capture = new ReferenceCapture(ctx, config)
  ctx.effect(() => () => capture.dispose())

  const writeJson = (res, status, body) => {
    const payload = Buffer.from(JSON.stringify(body))
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': payload.length,
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/voiceaec/status',
    handler: (req, res) => {
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      if (query.get('mounted') === '1') this.clientMountedAt = Date.now()
      const reported = query.get('clientError')
      if (reported) this.clientError = reported.slice(0, 400)
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end()
        return
      }
      writeJson(res, 200, capture.status())
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/voiceaec/reference',
    handler: (req, res) => {
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      if (query.get('mounted') === '1') this.clientMountedAt = Date.now()
      const reported = query.get('clientError')
      if (reported) this.clientError = reported.slice(0, 400)
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store, no-transform' })
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store, no-transform',
        'x-voiceaec-format': 's16le',
        'x-voiceaec-rate': '16000',
      })
      res.flushHeaders?.()
      let closed = false
      let paused = false
      const detach = capture.subscribe((frame) => {
        // Drop rather than buffer an unbounded backlog: the reference must
        // stay real-time, and a stale backlog ruins the echo alignment.
        if (closed || paused) return
        if (!res.write(frame)) {
          paused = true
          res.once('drain', () => { paused = false })
        }
      })
      const finish = () => {
        if (closed) return
        closed = true
        detach()
        res.end()
      }
      req.on('close', finish)
      req.on('error', finish)
      res.on('error', finish)
    },
  }))
}
