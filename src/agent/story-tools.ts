/**
 * The screenwriter's tools (Studio's `story_*` MCP tools,
 * apps/daemon/src/screenwriter/mcp-tools.ts) over the film's screenplays in
 * `film/story/`. Each one is a call to the screenwriter API the 剧本 tab uses,
 * so writes are compare-and-swap on the saved revision, versioned, and
 * announced to open views. The film is the conversation's workspace, so the
 * Studio tools' `project` argument is gone.
 * @module dsh-film/agent/story-tools
 */

import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { mediaKindFor } from '../canvas/assets.js'
import { DigestCache, digestFile } from '../film-files.js'
import { listWorkspaceMedia } from '../media.js'
import { FilmToolError, callStudio } from './studio-client.js'
import type { StudioCall } from './studio-client.js'
import { filmPathFor, filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices, FilmWorkspace } from './context.js'

const documentId = { type: 'string', description: 'Stable screenplay document id from story_query.' } as const
const expectedRevision = { type: 'string', description: 'The saved revision last read. A different current revision is answered with a conflict and nothing is overwritten.' } as const

/** The longest stretch of a historic version's Markdown returned in one answer. */
const VERSION_CONTENT_LIMIT = 48_000
/** How many library images and workspace images one listing returns. */
const LIBRARY_LIMIT = 200
const WORKSPACE_IMAGE_LIMIT = 100

const OPERATION_SHAPES = [
  '{kind:"appendBlock",block:{id,kind,markdown},afterBlockId?} — block kinds: scene-heading, action, speech (dialogue: a "**名字**" line, a blank line, then the line), outline, beat, brief, structure, shot-plan; unfamiliar kinds are kept',
  '{kind:"replaceBlock",blockId,markdown,expectedMarkdown?} — only that block\'s Markdown',
  '{kind:"upsertEntity",entity:{id,kind:"person"|"place"|"prop",profileBlockId},profileMarkdown?} — profileMarkdown such as "### 名字\\n" creates the profile block',
  '{kind:"upsertScene",scene:{id,headingBlockId,blockIds,placeId?},blocks?:[{id,kind,markdown}],beforeSceneId?} — headingBlockId is also first in blockIds; blocks supplies every new block',
  '{kind:"upsertShot",shot:{id,descriptionBlockId,sourceBlockIds,entityIds,sceneId?},descriptionMarkdown?}',
  '{kind:"upsertRecord",collection:"speech",record:{id,blockId,speakerId}} links a speech block to a person (also for an empty collection); other collections: appearances {id,entityId,sceneId,visualState}, beats, relationships, claims, assets, bindings, referenceOverrides',
  '{kind:"removeRecord",collection,id}; {kind:"renameEntity",entityId,name}; {kind:"setSpeechSpeaker",speechId,speakerId} (speechId is the relation id)',
  '{kind:"reorderScenes",sceneIds:[…]} / {kind:"reorderShots",shotIds:[…]} with the full intended order',
  '{kind:"updateDocument",changes:{title?,kind?,targetSeconds?,visualStyle?}}',
  '{kind:"setObjectArchived",target:{kind:"entity"|"scene"|"shot",id},archived}; {kind:"deleteObject"|"restoreObject",target}',
].map(line => `- ${line}`).join('\n')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A saved screenplay as an answer: identity, revision and health, not its whole text and parse. */
function documentSummary(document: unknown): Record<string, unknown> | undefined {
  if (!isRecord(document)) return undefined
  const parsed = isRecord(document.parsed) ? document.parsed : {}
  const diagnostics = Array.isArray(parsed.diagnostics) ? parsed.diagnostics : []
  return {
    documentId: document.documentId,
    title: document.title,
    kind: document.kind,
    revision: document.revision,
    versionId: document.versionId,
    updatedAt: document.updatedAt,
    filePath: `film/${String(document.filePath ?? '').replace(/^film\//u, '')}`,
    characters: typeof document.content === 'string' ? document.content.length : undefined,
    blocks: Array.isArray(parsed.blocks) ? parsed.blocks.length : undefined,
    semanticEditable: parsed.semanticEditable,
    ...(diagnostics.length > 0 ? { diagnostics: diagnostics.slice(0, 20), diagnosticCount: diagnostics.length } : {}),
  }
}

/** A write's answer; a dry run also shows the blocks it would change. */
export function mutationSummary(result: Record<string, unknown>, dryRun: boolean): Record<string, unknown> {
  const changedIds = Array.isArray(result.changedIds) ? result.changedIds.filter((id): id is string => typeof id === 'string') : undefined
  const summary: Record<string, unknown> = {
    changed: result.changed,
    ...(typeof result.operationId === 'string' ? { operationId: result.operationId } : {}),
    ...(changedIds !== undefined ? { changedIds } : {}),
    document: documentSummary(result.document),
  }
  if (dryRun) {
    summary.dryRun = true
    summary.note = 'Nothing was saved. Apply the same operations with the same expectedRevision and operationId.'
    const document = isRecord(result.document) ? result.document : {}
    const blocks = isRecord(document.parsed) && Array.isArray(document.parsed.blocks) ? document.parsed.blocks : []
    if (changedIds !== undefined && result.changed === true) {
      summary.preview = blocks
        .filter((block): block is Record<string, unknown> => isRecord(block) && changedIds.includes(String(block.id)))
        .slice(0, 40)
        .map(block => ({ id: block.id, kind: block.kind, markdown: typeof block.markdown === 'string' ? block.markdown.slice(0, 2000) : block.markdown }))
    }
  }
  return summary
}

/** The binding and asset records a bind or unbind touched, found in the saved screenplay. */
function touchedRecords(result: Record<string, unknown>): Record<string, unknown> {
  const document = isRecord(result.document) ? result.document : {}
  const metadata = isRecord(document.parsed) && isRecord(document.parsed.metadata) ? document.parsed.metadata : {}
  const changed = new Set(Array.isArray(result.changedIds) ? result.changedIds.map(String) : [])
  const bindings = (Array.isArray(metadata.bindings) ? metadata.bindings : []).filter((binding): binding is Record<string, unknown> => isRecord(binding) && changed.has(String(binding.id)))
  const assetIds = new Set(bindings.map(binding => String(binding.assetId)))
  const assets = (Array.isArray(metadata.assets) ? metadata.assets : []).filter((asset): asset is Record<string, unknown> => isRecord(asset) && assetIds.has(String(asset.id)))
  return { bindings, assets }
}

/**
 * Digests of workspace images by path, size and modification time, so a list
 * call hashes only the images that are new or changed since the last one.
 * A bind still checks the exact bytes it takes (expectedSha256).
 */
const workspaceDigests = new DigestCache()

/**
 * The workspace's own images outside film/ (media/ is where the media tools
 * save) that the film can take in, with their digests. A file that goes away
 * while it is hashed is left out.
 */
async function workspaceImages(film: FilmWorkspace): Promise<Array<Record<string, unknown>>> {
  const { files } = await listWorkspaceMedia(film.cwd)
  const images = files.filter(file => mediaKindFor(file.path) === 'image').slice(0, WORKSPACE_IMAGE_LIMIT)
  const listed = await Promise.all(images.map(async (image) => {
    const absolute = join(film.cwd, ...image.path.split('/'))
    const info = await lstat(absolute).catch(() => undefined)
    if (info?.isFile() !== true) return undefined
    const sha256 = await workspaceDigests.digest({ absolute, size: info.size, mtimeMs: info.mtimeMs }).catch(() => undefined)
    return sha256 === undefined ? undefined : { path: image.path, sizeBytes: info.size, modifiedAt: info.mtime.toISOString(), sha256 }
  }))
  return listed.filter((image): image is NonNullable<typeof image> => image !== undefined)
}

/**
 * Build the story tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function storyTools(services: FilmToolServices): ToolDefinition[] {
  const call = async (exec: ToolRunContext, build: (documents: string) => StudioCall): Promise<Record<string, unknown>> => {
    const film = await filmWorkspace(exec)
    return callStudio(services.studio, film.cwd, build(`/api/projects/${segment(film.projectId)}/story/documents`), exec.signal)
  }

  return [
    defineTool({
      name: 'story_query',
      description: 'Read the film\'s saved screenplays (the 剧本 tab). Without documentId it lists the documents. With documentId, kind chooses what to read: index '
        + '(the default: scenes, people/places/props and shots with their stable ids), content (the Markdown, or only the blocks of ids), entities, scenes, '
        + 'shots, bindings, or search (literal query text). Results name the revision and their actual coverage; a partial read is not a whole-script review. '
        + 'No open editor is needed.',
      parameters: {
        documentId,
        kind: { type: 'string', enum: ['index', 'content', 'entities', 'scenes', 'shots', 'bindings', 'search'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'Stable ids of the objects or text blocks to read.' },
        query: { type: 'string', description: 'Literal search text; not an instruction to execute.' },
        offset: { type: 'integer', description: 'Where a page starts (characters for full content, items otherwise).' },
        limit: { type: 'integer', description: 'Page size.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args.documentId === undefined || args.documentId === '') return plain(await call(exec, documents => ({ method: 'GET', path: documents })))
        const { documentId: id, ...query } = args
        return plain(await call(exec, documents => ({ method: 'POST', path: `${documents}/${segment(id)}/query`, body: plain({ ...query, kind: query.kind ?? 'index' }) })))
      },
    }),
    defineTool({
      name: 'story_asset_bindings',
      description: 'Reference images of screenplay cards. action "list": the film\'s image library (filePath relative to film/, sha256, the board nodes '
        + 'showing each) plus workspaceImages: the workspace\'s own images outside film/ (path relative to the workspace; media/ is where the media tools '
        + 'save). "references": what each recorded reference version of '
        + 'documentId resolves to — available, relocated, ambiguous, version-mismatch or missing are different outcomes; never treat a same-named file as '
        + 'the reference. "bind": bind one image version to a card: binding {target:{kind:"entity"|"shot",id}, scope:{kind:"document"}|{kind:"scene",'
        + 'sceneId}, purpose (e.g. appearance, identity, costume), primary (one main reference per card, scope and purpose), filePath and expectedSha256 '
        + 'exactly as list returned them, replaceBindingId?, operationId?}; a workspace image is first copied into the film (once). "unbind": remove '
        + 'bindingId only. '
        + 'Binding changes the screenplay only: it never moves or deletes a file, starts a generation or changes production inputs. Do not write assets or '
        + 'bindings records with story_apply_ops.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'references', 'bind', 'unbind'] },
        documentId: { ...documentId, description: 'For references, bind and unbind.' },
        expectedRevision: { ...expectedRevision, description: 'For bind and unbind.' },
        bindingId: { type: 'string', description: 'For unbind.' },
        binding: { type: 'object', additionalProperties: true, description: 'For bind (see the description).' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const film = await filmWorkspace(exec)
        const documents = `/api/projects/${segment(film.projectId)}/story/documents`
        const need = (value: string | undefined, name: string): string => {
          if (value === undefined || value === '') throw new FilmToolError('STORY_TOOL_INPUT', `${name} is required for ${args.action}.`)
          return value
        }
        switch (args.action) {
          case 'list': {
            const listed = await callStudio(services.studio, film.cwd, { method: 'GET', path: `/api/projects/${segment(film.projectId)}/story/assets` }, exec.signal)
            const library = Array.isArray(listed.assets) ? listed.assets as Array<Record<string, unknown>> : []
            return plain({
              assets: library.slice(0, LIBRARY_LIMIT).map(asset => ({ ...asset, canvasNodeIds: Array.isArray(asset.canvasNodeIds) ? asset.canvasNodeIds.slice(0, 10) : [] })),
              total: library.length,
              truncated: library.length > LIBRARY_LIMIT,
              workspaceImages: await workspaceImages(film),
            })
          }
          case 'references':
            return plain(await callStudio(services.studio, film.cwd, { method: 'GET', path: `${documents}/${segment(need(args.documentId, 'documentId'))}/references` }, exec.signal))
          case 'bind': {
            const id = need(args.documentId, 'documentId')
            const revision = need(args.expectedRevision, 'expectedRevision')
            if (args.binding === undefined) throw new FilmToolError('STORY_TOOL_INPUT', 'binding is required for bind.')
            const binding = { ...args.binding }
            // The library is the film's own files: a workspace image is brought in, as the editing desk's import does.
            // Only the bytes the agent chose are copied, so a mismatch is refused before anything lands in the film.
            const filePath = await filmPathFor(film, typeof binding.filePath === 'string' ? binding.filePath : '', {
              studio: services.studio,
              signal: exec.signal,
              failureCode: 'STORY_ASSET_IMPORT_FAILED',
              beforeImport: async (workspacePath) => {
                const expected = typeof binding.expectedSha256 === 'string' ? binding.expectedSha256.trim().toLowerCase() : ''
                if (!/^[0-9a-f]{64}$/u.test(expected)) throw new FilmToolError('STORY_TOOL_INPUT', 'binding.expectedSha256 must be the 64-hex sha256 list returned for the image.')
                const actual = await digestFile(join(film.cwd, ...workspacePath.split('/')))
                if (actual !== expected) throw new FilmToolError('STORY_ASSET_VERSION_MISMATCH', `${workspacePath} has changed since it was listed (sha256 ${actual}); list again and bind the version you mean.`)
              },
            })
            const result = await callStudio(services.studio, film.cwd, {
              method: 'POST', path: `${documents}/${segment(id)}/bindings`, body: { ...binding, filePath, expectedRevision: revision },
            }, exec.signal)
            return plain({ ...mutationSummary(result, false), ...touchedRecords(result) })
          }
          case 'unbind': {
            const id = need(args.documentId, 'documentId')
            const result = await callStudio(services.studio, film.cwd, {
              method: 'DELETE', path: `${documents}/${segment(id)}/bindings/${segment(need(args.bindingId, 'bindingId'))}`, body: { expectedRevision: need(args.expectedRevision, 'expectedRevision') },
            }, exec.signal)
            return plain({ ...mutationSummary(result, false), ...touchedRecords(result) })
          }
        }
      },
    }),
    defineTool({
      name: 'story_create',
      description: 'Create a short-film or episode screenplay in the film (a new document in the 剧本 tab). Incomplete prose, anonymous people and no dialogue are '
        + 'valid. Without content it starts from the native skeleton; plain Markdown content becomes its body. Does not generate media. Change an existing '
        + 'document with story_apply_ops instead.',
      parameters: {
        title: { type: 'string', required: true },
        kind: { type: 'string', enum: ['short', 'episode'], description: 'Defaults to short.' },
        content: { type: 'string', description: 'Optional Markdown to start from.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await call(exec, documents => ({ method: 'POST', path: documents, body: { title: args.title, kind: args.kind ?? 'short', ...(args.content !== undefined ? { content: args.content } : {}) } }))
        return plain(mutationSummary(result, false))
      },
    }),
    defineTool({
      name: 'story_apply_ops',
      description: 'Preview or atomically apply named screenplay operations, keeping Markdown, identities, relations and references in one saved version. Read the '
        + 'targets and revision first; prefer dryRun:true, then apply the same operations with the same expectedRevision and operationId. Operations use stable '
        + 'ids, never display numbers; give new objects fresh opaque ids and keep them on retries; keep dependent edits in one call. A conflict does not '
        + 'authorize a whole-document overwrite. changed:false is not a new edit. The film-screenwriting skill has tested batches for scenes, '
        + 'dialogue links and production fields. Shapes:\n' + OPERATION_SHAPES,
      parameters: {
        documentId: { ...documentId, required: true },
        expectedRevision: { ...expectedRevision, required: true },
        operations: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: 'The operations, at most 500.' },
        dryRun: { type: 'boolean' },
        operationId: { type: 'string', description: 'Names this change; reuse it after an ambiguous failure so a retry is answered instead of applied twice.' },
        label: { type: 'string', description: 'A name for the saved version.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const { documentId: id, ...body } = args
        const result = await call(exec, documents => ({ method: 'POST', path: `${documents}/${segment(id)}/operations`, body }))
        return plain(mutationSummary(result, args.dryRun === true))
      },
    }),
    defineTool({
      name: 'story_history',
      description: 'List a screenplay\'s saved versions, or read the Markdown of one versionId. This does not restore anything.',
      parameters: {
        documentId: { ...documentId, required: true },
        versionId: { type: 'string' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await call(exec, documents => ({
          method: 'GET',
          path: `${documents}/${segment(args.documentId)}/history${args.versionId !== undefined && args.versionId !== '' ? `/${segment(args.versionId)}` : ''}`,
        }))
        if (typeof result.content === 'string' && result.content.length > VERSION_CONTENT_LIMIT) {
          return plain({ ...result, content: result.content.slice(0, VERSION_CONTENT_LIMIT), contentTruncated: true, totalLength: result.content.length })
        }
        return plain(result)
      },
    }),
    defineTool({
      name: 'story_checkpoint',
      description: 'Name the current saved revision of a screenplay as a version. Requires the current revision; an unsaved draft is never recorded.',
      parameters: {
        documentId: { ...documentId, required: true },
        expectedRevision: { ...expectedRevision, required: true },
        label: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        return plain(await call(exec, documents => ({ method: 'POST', path: `${documents}/${segment(args.documentId)}/history`, body: { expectedRevision: args.expectedRevision, label: args.label } })))
      },
    }),
    defineTool({
      name: 'story_restore',
      description: 'Restore a whole saved version of a screenplay as a new current revision, with its relations and reference bindings. Requires the current '
        + 'revision. Different from reverting one operation; it never rolls back canvas media or the cut.',
      parameters: {
        documentId: { ...documentId, required: true },
        expectedRevision: { ...expectedRevision, required: true },
        versionId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await call(exec, documents => ({ method: 'POST', path: `${documents}/${segment(args.documentId)}/restore`, body: { expectedRevision: args.expectedRevision, versionId: args.versionId } }))
        return plain(mutationSummary(result, false))
      },
    }),
    defineTool({
      name: 'story_revert',
      description: 'Revert one recorded screenplay operation (its operationId), keeping every other change. If the same text has been edited since, the conflict '
        + 'is reported and the current prose kept; never substitute a whole-version restore after a refusal.',
      parameters: {
        documentId: { ...documentId, required: true },
        expectedRevision: { ...expectedRevision, required: true },
        operationId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await call(exec, documents => ({ method: 'POST', path: `${documents}/${segment(args.documentId)}/revert`, body: { expectedRevision: args.expectedRevision, operationId: args.operationId } }))
        return plain(mutationSummary(result, false))
      },
    }),
  ]
}
