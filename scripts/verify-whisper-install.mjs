/**
 * Proves that the whisper.cpp Showoff downloads on this platform actually
 * arrives and actually runs. Windows is the reason this exists: the unpack
 * goes through PowerShell and the binary loads a dozen DLLs from beside
 * itself, and neither of those can be exercised from a developer's Mac.
 *
 *   node --experimental-strip-types scripts/verify-whisper-install.mjs
 *
 * Exits non-zero if the platform has a prebuilt build that fails to install
 * or fails to execute. Platforms with no prebuilt build (macOS) pass quietly.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  downloadWhisperBuild,
  whisperInstallRoute,
  whisperSpawnEnv
} from '../src/main/transcribe/install.ts'

const route = whisperInstallRoute()
console.log(`platform=${process.platform}/${process.arch} route=${route}`)

if (route !== 'download') {
  console.log('no prebuilt build for this platform, nothing to verify')
  process.exit(0)
}

const modelDir = mkdtempSync(join(tmpdir(), 'showoff-whisper-'))
const bin = await downloadWhisperBuild(modelDir, (f, note) =>
  console.log(`  ${Math.round(f * 100).toString().padStart(3)}% ${note}`)
)
console.log(`installed ${bin} (${statSync(bin).size} bytes)`)

// The real question is whether it runs -- on Windows a missing DLL only shows
// up here, not at unpack time.
const res = spawnSync(bin, ['--help'], { env: whisperSpawnEnv(bin), encoding: 'utf8' })
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
if (res.error) throw new Error(`whisper-cli would not start: ${res.error.message}`)
if (!/usage:|whisper/i.test(output)) {
  throw new Error(`whisper-cli ran but printed nothing recognisable:\n${output.slice(0, 500)}`)
}
console.log(`whisper-cli runs: ${output.trim().split('\n')[0]}`)
