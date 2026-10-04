/** The runtime route: which version this Host runs, and which one is installed now. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOADED_VERSION, installedVersion, runtimeRoute, version } from '../src/runtime.js'
import * as Film from '../src/index.js'

let dir: string
let packageJson: URL

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-film-runtime-'))
  packageJson = pathToFileURL(join(dir, 'package.json'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const ask = async (route: ReturnType<typeof runtimeRoute>) => {
  const response = await route.fetch(new Request('http://host/api/dsh-film/runtime'))
  return { status: response.status, cache: response.headers.get('cache-control'), type: response.headers.get('content-type'), body: await response.json() }
}

describe('GET /api/dsh-film/runtime', () => {
  it('is a GET route on the Host channel that answers without a workspace and is never cached', async () => {
    await writeFile(packageJson, JSON.stringify({ name: 'dsh-film', version: '0.2.0' }))
    const route = runtimeRoute({ loaded: '0.2.0', packageJson })
    expect(route).toMatchObject({ path: '/api/dsh-film/runtime', methods: ['GET'], requestBody: 'buffered' })
    const answer = await ask(route)
    expect(answer).toMatchObject({ status: 200, cache: 'no-store', body: { version: '0.2.0', installed: '0.2.0' } })
    expect(answer.type).toMatch(/^application\/json/u)
  })

  it('answers the loaded version, with the installed one read now', async () => {
    await writeFile(packageJson, JSON.stringify({ version: '0.2.0' }))
    const route = runtimeRoute({ loaded: '0.2.0', packageJson })
    expect((await ask(route)).body).toEqual({ version: '0.2.0', installed: '0.2.0' })
    // Installed over in place: the file changes, the running version does not.
    await writeFile(packageJson, JSON.stringify({ version: '0.2.1' }))
    expect((await ask(route)).body).toEqual({ version: '0.2.0', installed: '0.2.1' })
    await rm(packageJson)
    expect((await ask(route)).body).toEqual({ version: '0.2.0', installed: null })
    await writeFile(packageJson, '{ not json')
    expect((await ask(route)).body).toEqual({ version: '0.2.0', installed: null })
  })

  it('reads this package\'s own version by default, the one the plugin exports', async () => {
    expect(LOADED_VERSION).toMatch(/^\d+\.\d+\.\d+/u)
    expect(version).toBe(LOADED_VERSION)
    expect(Film.version).toBe(LOADED_VERSION)
    expect(await installedVersion()).toBe(LOADED_VERSION)
    expect((await ask(runtimeRoute())).body).toEqual({ version: LOADED_VERSION, installed: LOADED_VERSION })
  })
})
