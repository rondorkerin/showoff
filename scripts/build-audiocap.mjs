#!/usr/bin/env node
/**
 * Compiles the ScreenCaptureKit audio sidecar into a universal binary.
 *
 * Only macOS can build this, and only macOS needs it -- Windows captures what
 * the machine is playing through Electron's own loopback option. On any other
 * platform, and when Swift is missing, this exits successfully without
 * producing anything: the app treats a missing binary as "this route is not
 * available here" and falls back to a virtual audio device, so a Linux CI box
 * building a Windows installer must not fail here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'native', 'audiocap', 'AudioCap.swift')
const outDir = join(root, 'resources')
const out = join(outDir, 'audiocap')

// macOS 13 is where SCStreamConfiguration.capturesAudio arrives.
const DEPLOYMENT_TARGET = '13.0'
const ARCHES = ['arm64', 'x86_64']

function skip(why) {
  console.log(`audiocap: skipped (${why})`)
  process.exit(0)
}

if (process.platform !== 'darwin') skip('not macOS')
try {
  execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' })
} catch {
  skip('swiftc not found — install the Xcode command line tools')
}

// Rebuilding on every `npm run build` costs two swiftc invocations for a file
// that changes about once a year, so skip when the binary is already current.
if (existsSync(out) && statSync(out).mtimeMs > statSync(source).mtimeMs) {
  console.log(`audiocap: up to date (${out})`)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const slices = []
for (const arch of ARCHES) {
  const slice = join(outDir, `audiocap-${arch}`)
  execFileSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-swift-version',
      '5',
      // @main in a single file needs library parsing; without it swiftc looks
      // for top-level statements and finds two entry points.
      '-parse-as-library',
      '-target',
      `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
      '-o',
      slice,
      source
    ],
    { stdio: 'inherit' }
  )
  slices.push(slice)
}

rmSync(out, { force: true })
execFileSync('xcrun', ['lipo', '-create', '-output', out, ...slices], { stdio: 'inherit' })
for (const slice of slices) rmSync(slice, { force: true })

const arches = execFileSync('xcrun', ['lipo', '-archs', out]).toString().trim()
console.log(`audiocap: ${out} (${arches}, ${(statSync(out).size / 1024).toFixed(0)} KB)`)
