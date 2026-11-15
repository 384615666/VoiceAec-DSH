/**
 * Inline the AEC core into the browser artifact.
 *
 * The Client half is served as one classic module to the Harness page, so it
 * cannot import the Host-side source. `createAecCore` is self-contained; its
 * source text is embedded both for the main-thread fallback and for the
 * AudioWorklet module the page builds at runtime.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createAecCore } from './lib/aec-core.js'

const source = readFileSync(new URL('./src/client.js', import.meta.url), 'utf8')
const core = `const createAecCore = ${createAecCore.toString()}`
if (!source.includes('/*__AEC_CORE__*/')) throw new Error('client source lost its AEC placeholder')
const output = source.replace('/*__AEC_CORE__*/', core)
writeFileSync(new URL('./client.js', import.meta.url), output)
console.log(`client.js written (${output.length} bytes, core ${core.length} bytes)`)
