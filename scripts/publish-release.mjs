// Verify a tested GitHub Release archive before the OIDC publication job may publish it.
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function publicationDecision(input) {
  const { tag, expectedName, expectedRepository, actualRepository, source, archive, integrity, sha256, assetDigest, registryVersion, tagCommit, workflowCommit } = input
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error('Use an exact vX.Y.Z release tag')
  const version = tag.slice(1)
  if (actualRepository !== expectedRepository) throw new Error('Unexpected GitHub repository')
  if (source?.name !== expectedName || source?.version !== version || archive?.name !== expectedName || archive?.version !== version) throw new Error('Tag, source and archive must identify the same package and version')
  if (assetDigest !== 'sha256:' + sha256) throw new Error('Archive differs from the GitHub Release asset digest')
  if (registryVersion !== undefined) {
    if (registryVersion?.name !== expectedName || registryVersion?.version !== version || registryVersion?.dist?.integrity !== integrity) throw new Error('An existing npm version has different contents; do not overwrite or republish')
    return { publish: false, version, npmTag: version.includes('-') ? 'next' : 'latest' }
  }
  const canonical = 'https://github.com/' + expectedRepository
  const repositoryOf = manifest => String(typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
  if (repositoryOf(source) !== canonical || repositoryOf(archive) !== canonical) throw new Error('Set repository.url to the canonical GitHub repository before creating the next archive')
  if (!tagCommit || tagCommit !== workflowCommit) throw new Error('Run an unpublished release on its tag ref so the attestation identifies the source commit')
  return { publish: true, version, npmTag: version.includes('-') ? 'next' : 'latest' }
}

async function verify() {
  const [expectedName, expectedRepository, tag, tarballFile, archiveFile, sourceFile, assetsFile] = process.argv.slice(2)
  const archive = JSON.parse(readFileSync(archiveFile, 'utf8'))
  const source = JSON.parse(readFileSync(sourceFile, 'utf8'))
  const release = JSON.parse(readFileSync(assetsFile, 'utf8'))
  const bytes = readFileSync(tarballFile)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  if (release.tagName !== tag || release.isDraft) throw new Error('Use a published release for the exact tag')
  const filename = tarballFile.replace(/\\/g, '/').split('/').at(-1)
  const assets = release.assets.filter(asset => asset.name === filename)
  if (assets.length !== 1) throw new Error('The release must contain exactly one matching package archive')
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error('Invalid release tag')
  const response = await fetch('https://registry.npmjs.org/' + expectedName.replace('/', '%2F') + '/' + tag.slice(1), { signal: AbortSignal.timeout(20000), redirect: 'error' })
  let registryVersion
  if (response.status === 200) registryVersion = await response.json()
  else { await response.body?.cancel(); if (response.status !== 404) throw new Error('npm version lookup HTTP ' + response.status) }
  const decision = publicationDecision({ tag, expectedName, expectedRepository, actualRepository: process.env.GITHUB_REPOSITORY, source, archive, integrity, sha256, assetDigest: assets[0].digest, registryVersion, tagCommit: process.env.TAG_COMMIT, workflowCommit: process.env.GITHUB_SHA })
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'publish=' + decision.publish + '\nnpm_tag=' + decision.npmTag + '\n')
  console.log(`${expectedName}@${decision.version}: ${decision.publish ? 'verified release archive, ready for OIDC publication' : 'already published with identical bytes; publication skipped'}`)
}

async function confirmPublished() {
  const [expectedName, tag, tarballFile] = process.argv.slice(3)
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error('Invalid release tag')
  const local = readFileSync(tarballFile)
  const expected = 'sha512-' + createHash('sha512').update(local).digest('base64')
  const deadline = Date.now() + 10 * 60 * 1000
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  while (Date.now() < deadline) {
    const r = await fetch('https://registry.npmjs.org/' + expectedName.replace('/', '%2F') + '/' + tag.slice(1), { signal: AbortSignal.timeout(20000), redirect: 'error' })
    if (r.status === 200) {
      const j = await r.json()
      if (j.name !== expectedName || j.version !== tag.slice(1) || j.dist?.integrity !== expected) throw new Error('Published npm metadata differs from the verified archive')
      const url = new URL(j.dist.tarball)
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') throw new Error('Unexpected npm tarball destination')
      const archive = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' })
      if (archive.status === 200) {
        if (!Buffer.from(await archive.arrayBuffer()).equals(local)) throw new Error('Published tarball bytes differ')
        console.log(`${expectedName}@${tag.slice(1)}: registry tarball verified byte for byte`)
        return
      }
      await archive.body?.cancel()
      if (archive.status !== 404) throw new Error('npm tarball HTTP ' + archive.status)
    } else { await r.body?.cancel(); if (r.status !== 404) throw new Error('npm metadata HTTP ' + r.status) }
    console.log('Waiting for the published npm artifact to become available')
    await delay(10000)
  }
  throw new Error('The published tarball is still unavailable; inspect the release before retrying publication')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--confirm') await confirmPublished()
  else await verify()
}
