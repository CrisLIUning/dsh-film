import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { appFileCaching, appFileType, appRoutes, findApps, scanApp } from '../src/apps.js'
import * as Film from '../src/index.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-film-apps-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function file(relative: string, content: string | Uint8Array): Promise<void> {
  const path = join(root, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

async function canvasApp(): Promise<void> {
  await file('canvas/index.html', '<!doctype html><script src="./assets/index-Ab3dEf9_.js"></script>')
  await file('canvas/assets/index-Ab3dEf9_.js', 'console.log(1)')
  await file('canvas/assets/logo.svg', '<svg/>')
  await file('canvas/models/hero.glb', new Uint8Array(1000))
  await file('canvas/bad name.png', 'x')
  await file('canvas/models/人物.glb', 'x')
}

describe('appFileType and appFileCaching', () => {
  it('types app files by extension', () => {
    expect(appFileType('index.html')).toBe('text/html; charset=utf-8')
    expect(appFileType('a/b.WASM')).toBe('application/wasm')
    expect(appFileType('model.glb')).toBe('model/gltf-binary')
    expect(appFileType('blob.xyz')).toBe('application/octet-stream')
  })

  it('caches hashed bundles for good and revalidates the rest', () => {
    expect(appFileCaching('assets/index-Ab3dEf9_.js')).toBe('private, max-age=31536000, immutable')
    expect(appFileCaching('index.html')).toBe('no-cache')
    expect(appFileCaching('assets/logo.svg')).toBe('no-cache')
  })
})

describe('scanApp and findApps', () => {
  it('lists routable files and reports the rest', async () => {
    await canvasApp()
    const { files, skipped } = scanApp('canvas', join(root, 'canvas'))
    expect(files.map(item => item.route)).toEqual([
      '/api/dsh-film/apps/canvas/assets/index-Ab3dEf9_.js',
      '/api/dsh-film/apps/canvas/assets/logo.svg',
      '/api/dsh-film/apps/canvas/index.html',
      '/api/dsh-film/apps/canvas/models/hero.glb',
    ])
    expect(skipped.sort()).toEqual(['bad name.png', 'models/人物.glb'])
  })

  it('finds apps by their index.html', async () => {
    await canvasApp()
    await file('notes/readme.txt', 'not an app')
    expect(findApps(root).map(item => item.app)).toEqual(['canvas'])
    expect(findApps(join(root, 'missing'))).toEqual([])
  })

  it('refuses an app name that cannot be a route segment', () => {
    expect(() => scanApp('my app', root)).toThrow(/cannot be a route segment/)
  })
})

describe('appRoutes', () => {
  const routeFor = async (relative: string): Promise<ConnectionFetchRoute> => {
    await canvasApp()
    const routes = appRoutes(scanApp('canvas', join(root, 'canvas')).files)
    const route = routes.find(item => item.path.endsWith(`/canvas/${relative}`))
    if (route === undefined) throw new Error(`no route for ${relative}`)
    return route
  }

  it('serves the page with revalidation and framing limited to the Host', async () => {
    const route = await routeFor('index.html')
    const response = await route.fetch(new Request(`http://host${route.path}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
    expect(await response.text()).toContain('index-Ab3dEf9_.js')
  })

  it('answers a repeated request with 304 when the file has not changed', async () => {
    const route = await routeFor('assets/index-Ab3dEf9_.js')
    const first = await route.fetch(new Request(`http://host${route.path}`))
    expect(first.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    const tag = first.headers.get('etag')
    expect(tag).toMatch(/^W\//)
    const again = await route.fetch(new Request(`http://host${route.path}`, { headers: { 'if-none-match': tag ?? '' } }))
    expect(again.status).toBe(304)
  })

  it('serves large files by range', async () => {
    const route = await routeFor('models/hero.glb')
    const response = await route.fetch(new Request(`http://host${route.path}`, { headers: { range: 'bytes=10-19' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect((await response.arrayBuffer()).byteLength).toBe(10)
  })

  it('answers 404 when a file disappeared after the scan', async () => {
    const route = await routeFor('assets/logo.svg')
    await rm(join(root, 'canvas', 'assets', 'logo.svg'))
    expect((await route.fetch(new Request(`http://host${route.path}`))).status).toBe(404)
  })
})

describe('dsh-film plugin with apps', () => {
  it('registers a route per app file next to its own routes', async () => {
    await canvasApp()
    const registered: string[] = []
    const ctx = new Context()
    ctx.provide('connection')
    ctx.set('connection', {
      fetch: {
        register(route: ConnectionFetchRoute) {
          registered.push(route.path)
          return async () => {}
        },
      },
    })
    const fiber = await ctx.plugin(Film, { appsDir: root, modelsDir: join(root, 'models') })
    expect(registered).toContain('/api/dsh-film/project')
    expect(registered).toContain('/api/dsh-film/apps/canvas/index.html')
    expect(registered.filter(path => path.startsWith('/api/dsh-film/apps/'))).toHaveLength(4)
    await fiber.dispose()
  })
})
