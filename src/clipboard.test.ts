// Joue le presse-papiers sur de vrais petits scripts shell : jamais le vrai presse-papiers du système.
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import { ClipboardUnavailableError, clipboardCommands, runClipboardCommands } from './clipboard'

/** Dossiers temporaires de chaque test, supprimés après lui. */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-network-clipboard-'))
  roots.push(dir)
  return dir
}

/** Écrit un script exécutable dans `dir` et rend son chemin. */
async function makeScript(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
  return path
}

const HANDLE = 'term_27a740ab-0791'

test('clipboardCommands picks pbcopy on macOS', () => {
  assert.deepEqual(clipboardCommands('darwin', {}), [{ file: '/usr/bin/pbcopy', args: [] }])
})

test('clipboardCommands picks clip on Windows', () => {
  assert.deepEqual(clipboardCommands('win32', {}), [{ file: 'clip', args: [] }])
})

test('clipboardCommands tries wl-copy first under Wayland', () => {
  assert.deepEqual(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' }), [
    { file: 'wl-copy', args: [] },
    { file: 'xclip', args: ['-selection', 'clipboard'] }
  ])
})

test('clipboardCommands tries xclip first without Wayland', () => {
  assert.deepEqual(clipboardCommands('linux', {}), [
    { file: 'xclip', args: ['-selection', 'clipboard'] },
    { file: 'wl-copy', args: [] }
  ])
})

test("writes the text to the command's stdin", async () => {
  const dir = await makeDir()
  const outFile = join(dir, 'out.txt')
  const script = await makeScript(dir, 'copy-tool', 'cat > "$1"')
  await runClipboardCommands([{ file: script, args: [outFile] }], HANDLE)
  assert.equal(await readFile(outFile, 'utf8'), HANDLE)
})

test('falls back past a missing command', async () => {
  const dir = await makeDir()
  const outFile = join(dir, 'out.txt')
  const script = await makeScript(dir, 'copy-tool', 'cat > "$1"')
  await runClipboardCommands(
    [
      { file: join(dir, 'missing-tool'), args: [] },
      { file: script, args: [outFile] }
    ],
    HANDLE
  )
  assert.equal(await readFile(outFile, 'utf8'), HANDLE)
})

test('throws ClipboardUnavailableError when every command is missing', async () => {
  const dir = await makeDir()
  await assert.rejects(
    runClipboardCommands(
      [
        { file: join(dir, 'missing-one'), args: [] },
        { file: join(dir, 'missing-two'), args: [] }
      ],
      HANDLE
    ),
    (failure: unknown) => failure instanceof ClipboardUnavailableError
  )
})

test('a failing command is reported with its stderr and stops the fallback', async () => {
  const dir = await makeDir()
  const marker = join(dir, 'marker.txt')
  const failing = await makeScript(dir, 'failing-tool', "echo 'no display' >&2\nexit 1")
  const second = await makeScript(dir, 'second-tool', 'cat > "$1"')
  await assert.rejects(
    runClipboardCommands(
      [
        { file: failing, args: [] },
        { file: second, args: [marker] }
      ],
      HANDLE
    ),
    (failure: unknown) => failure instanceof Error && failure.message.includes('no display')
  )
  assert.equal(existsSync(marker), false)
})

test('succeeds when the command exits 0 while a forked server keeps the pipes open', async () => {
  const dir = await makeDir()
  // Comme xclip ou wl-copy : le serveur de sélection en arrière-plan hérite de stderr et survit au parent.
  const forking = await makeScript(dir, 'forking-tool', 'cat > /dev/null\nsleep 3 &\nexit 0')
  const startedAt = Date.now()
  await runClipboardCommands([{ file: forking, args: [] }], HANDLE, 1500)
  assert.ok(Date.now() - startedAt < 1000)
})

test('a hanging command is killed at the timeout', async () => {
  const dir = await makeDir()
  // `exec` : le shell est remplacé par sleep, le SIGKILL l'atteint donc directement.
  const hanging = await makeScript(dir, 'hanging-tool', 'exec sleep 10')
  const startedAt = Date.now()
  await assert.rejects(
    runClipboardCommands([{ file: hanging, args: [] }], HANDLE, 200),
    (failure: unknown) => failure instanceof Error && failure.message.includes('200')
  )
  assert.ok(Date.now() - startedAt < 2000)
})
