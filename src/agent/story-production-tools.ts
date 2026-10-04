/**
 * The screenplay-to-production tools (Studio's `story_source`,
 * `story_handoff`, `story_adopt`, `story_impact` and `story_director_links`
 * MCP tools, apps/daemon/src/screenwriter/mcp-tools.ts), each a call to the
 * production routes the canvas page uses. They work on the saved screenplay
 * and the saved board, so the 分镜 tab may be closed. The film is the
 * conversation's workspace, so the Studio tools' `project` argument is gone
 * and `boardId` defaults to the film's one board. Answers are summaries:
 * node identities and the fields that matter, never whole boards or bytes.
 * @module dsh-film/agent/story-production-tools
 */

import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FilmToolError, callStudio } from './studio-client.js'
import type { StudioCall } from './studio-client.js'
import { filmWorkspace, jsonOutput, plain, segment } from './context.js'
import type { FilmToolServices, FilmWorkspace } from './context.js'

const documentId = { type: 'string', description: 'Stable screenplay document id from story_query.' } as const
const expectedRevision = { type: 'string', description: 'The saved revision last read. A different current revision is answered with a conflict and nothing is overwritten.' } as const
const objectId = { type: 'string', description: 'Stable id of a saved entity (person, place, prop), scene or shot — not a text block.' } as const
const scope = {
  type: 'object',
  additionalProperties: false,
  description: '{kind:"document"} (the default) or {kind:"scene",sceneId}; a scene selects that scene\'s reference overrides and visual state.',
  properties: { kind: { type: 'string', required: true, enum: ['document', 'scene'] }, sceneId: { type: 'string' } },
} as const
const boardId = { type: 'string', description: 'The film\'s board; it is the only one and the default. Another id is refused.' } as const

/** The longest stretch of a preview's text returned in one answer. */
const TEXT_LIMIT = 24_000
/** How many impact items one answer lists. */
const IMPACT_LIMIT = 300

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const capped = (value: unknown, limit: number): unknown => typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}…` : value

/** A source preview's identity, revision and reference versions, without its text. */
function previewSummary(preview: unknown): Record<string, unknown> | undefined {
  if (!isRecord(preview)) return undefined
  return {
    documentId: preview.documentId, objectId: preview.objectId, objectKind: preview.objectKind,
    ...(preview.entityKind !== undefined ? { entityKind: preview.entityKind } : {}),
    title: preview.title, revision: preview.revision,
    references: (Array.isArray(preview.references) ? preview.references : []).filter(isRecord).map(reference => ({
      assetId: reference.assetId, assetVersionId: reference.assetVersionId, status: reference.status, primary: reference.primary,
      ...(reference.title !== undefined ? { title: reference.title } : {}), ...(reference.sha256 !== undefined ? { sha256: reference.sha256 } : {}),
    })),
  }
}

/** A board node's identity and place. */
function nodeSummary(node: unknown): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined
  return { id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height }
}

/** Which revision each adopted field came from. */
function adoptionSummary(adoption: unknown): Record<string, unknown> | undefined {
  if (!isRecord(adoption)) return undefined
  const byField = isRecord(adoption.fieldAdoptions) ? adoption.fieldAdoptions : {}
  const field = (value: unknown): Record<string, unknown> | undefined => isRecord(value)
    ? { documentId: value.documentId, objectId: value.objectId, objectKind: value.objectKind, revision: value.revision, scope: value.scope, adoptedAt: value.adoptedAt }
    : undefined
  return { fields: adoption.fields, ...(byField.prompt !== undefined ? { prompt: field(byField.prompt) } : {}), ...(byField.references !== undefined ? { references: field(byField.references) } : {}) }
}

/** A director node's links, per shot, as source identities rather than whole previews. */
function linksSummary(links: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(isRecord(links) ? links : {}).map(([shotId, values]) => [shotId, (Array.isArray(values) ? values : []).filter(isRecord).map((link) => {
    const preview = isRecord(link.preview) ? link.preview : {}
    return { documentId: preview.documentId, objectId: preview.objectId, objectKind: preview.objectKind, title: preview.title, revision: preview.revision, scope: link.scope, linkedAt: link.linkedAt }
  })]))
}

/**
 * Build the screenplay-to-production tools.
 * @param services - the film services.
 * @returns the tool definitions.
 */
export function storyProductionTools(services: FilmToolServices): ToolDefinition[] {
  const call = async (exec: ToolRunContext, build: (film: FilmWorkspace, documents: string) => StudioCall): Promise<Record<string, unknown>> => {
    const film = await filmWorkspace(exec)
    return callStudio(services.studio, film.cwd, build(film, `/api/projects/${segment(film.projectId)}/story/documents`), exec.signal)
  }
  const need = (value: string | undefined, name: string, action: string): string => {
    if (value === undefined || value === '') throw new FilmToolError('STORY_TOOL_INPUT', `${name} is required for ${action}.`)
    return value
  }

  return [
    defineTool({
      name: 'story_source',
      description: 'Read one saved entity, scene or shot as a canvas source preview: its text (markdown), the production brief compiled from it with the film\'s '
        + 'visual style, visual identities and scene state (productionText), the actual screenplay revision and the resolved reference image versions. It '
        + 'creates no node and changes no production condition.',
      parameters: {
        documentId: { ...documentId, required: true },
        objectId: { ...objectId, required: true },
        scope,
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args.scope?.kind === 'scene' && (typeof args.scope.sceneId !== 'string' || args.scope.sceneId.trim() === '')) throw new FilmToolError('STORY_TOOL_INPUT', 'scene scope requires sceneId.')
        const preview = await call(exec, (_film, documents) => ({
          method: 'GET',
          path: `${documents}/${segment(args.documentId)}/source/${segment(args.objectId)}${args.scope?.kind === 'scene' ? `?sceneId=${segment(args.scope.sceneId!)}` : ''}`,
        }))
        const dependencies = Array.isArray(preview.dependencies) ? preview.dependencies.filter(isRecord) : []
        return plain({
          ...preview,
          markdown: capped(preview.markdown, TEXT_LIMIT),
          productionText: capped(preview.productionText, TEXT_LIMIT),
          // The evidence blocks, for comparisons; read them whole with story_query.
          dependencies: dependencies.map(item => ({ blockId: item.blockId, markdown: capped(item.markdown, 300) })),
        })
      },
    }),
    defineTool({
      name: 'story_handoff',
      description: 'Send a saved screenplay object to an independent source card on the film\'s board, even when the 分镜 tab is closed. Optional production '
        + '{purpose: image | character-sheet (people) | scene-sheet (places) | prop-sheet (props) | shot, requestId} also creates a wired, editable image node '
        + 'with a production prompt — nothing is generated or billed. A card of the same document, object and scope is reused unless duplicate:true. Use a '
        + 'fresh requestId per request and keep it on retries (a replay answers the same node). The card\'s reference display follows later screenplay '
        + 'revisions; production prompts and generated media are kept. Only on the person\'s request.',
      parameters: {
        documentId: { ...documentId, required: true },
        expectedRevision: { ...expectedRevision, required: true },
        objectId: { ...objectId, required: true },
        scope,
        boardId,
        duplicate: { type: 'boolean', description: 'Another card even when one exists (not with production).' },
        production: {
          type: 'object',
          additionalProperties: false,
          properties: {
            purpose: { type: 'string', required: true, enum: ['image', 'character-sheet', 'scene-sheet', 'prop-sheet', 'shot'] },
            requestId: { type: 'string', required: true, description: 'Letters, digits, . _ -; up to 128 characters.' },
          },
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await call(exec, (film, documents) => ({
          method: 'POST',
          path: `${documents}/${segment(args.documentId)}/handoff`,
          body: plain({ expectedRevision: args.expectedRevision, objectId: args.objectId, boardId: args.boardId ?? film.boardId, scope: args.scope, duplicate: args.duplicate, production: args.production }),
        }))
        const production = isRecord(result.productionNode) ? result.productionNode : undefined
        const metadata = isRecord(production?.metadata) ? production.metadata : {}
        return plain({
          created: result.created,
          boardId: result.boardId,
          node: nodeSummary(result.node),
          ...(production !== undefined
            ? { productionNode: { ...nodeSummary(production), metadata: { prompt: metadata.prompt, promptPurpose: metadata.promptPurpose, status: metadata.status, count: metadata.count, storyProduction: metadata.storyProduction } } }
            : {}),
          ...(result.connection !== undefined ? { connection: result.connection } : {}),
          preview: previewSummary(result.preview),
          ...(production !== undefined
            ? { note: 'Nothing was generated. productionNode is the node to generate into once the person asks: canvas_run_generation with the 分镜 tab open, or the media tools and canvas_attach_media.' }
            : {}),
        })
      },
    }),
    defineTool({
      name: 'story_adopt',
      description: 'Explicitly adopt selected screenplay source fields into one saved production node (text, config, image, video or audio). First read the '
        + 'source (story_source) and the target with canvas_get_document nodeId — its adoptionTarget holds the exact saved values — and pass those values '
        + 'as expectedTarget for the selected fields (omit a key the node does not have). "prompt" replaces both prompt and composerContent with the '
        + 'production brief; "references" snapshots the selected image bytes into the film and replaces the node\'s references. A changed target is a '
        + 'conflict and nothing is written; unselected fields and generated media stay as they are. Never call it merely because the screenplay '
        + 'changed.',
      parameters: {
        documentId: { ...documentId, required: true },
        expectedRevision: { ...expectedRevision, required: true },
        objectId: { ...objectId, required: true },
        scope,
        boardId,
        targetNodeId: { type: 'string', required: true },
        fields: { type: 'array', required: true, items: { type: 'string', enum: ['prompt', 'references'] }, description: 'prompt and/or references.' },
        expectedTarget: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: { prompt: { type: 'string' }, composerContent: { type: 'string' }, references: { type: 'array', items: { type: 'string' } } },
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        if (args.fields.length === 0) throw new FilmToolError('STORY_TOOL_INPUT', 'Choose fields and supply saved expectedTarget before adopting.')
        const result = await call(exec, (film, documents) => ({
          method: 'POST',
          path: `${documents}/${segment(args.documentId)}/adopt`,
          body: plain({
            expectedRevision: args.expectedRevision, objectId: args.objectId, boardId: args.boardId ?? film.boardId, targetNodeId: args.targetNodeId,
            fields: args.fields, expectedTarget: args.expectedTarget, scope: args.scope,
          }),
        }))
        const node = isRecord(result.node) ? result.node : {}
        const metadata = isRecord(node.metadata) ? node.metadata : {}
        return plain({
          node: {
            ...nodeSummary(node),
            metadata: {
              ...(typeof metadata.prompt === 'string' ? { prompt: capped(metadata.prompt, 2000), promptCharacters: metadata.prompt.length } : {}),
              ...(metadata.references !== undefined ? { references: metadata.references } : {}),
            },
          },
          adoption: adoptionSummary(result.adoption),
          preview: previewSummary(result.preview),
        })
      },
    }),
    defineTool({
      name: 'story_impact',
      description: 'Read how the current saved screenplay differs from what production took from it: source cards and explicitly adopted fields on the '
        + 'board, outputs generated from sources and director-shot links — one item per use and field, with status '
        + 'unchanged, changed, source-missing or unavailable, whether the field was edited by hand since, and whether the actual generation inputs '
        + 'differed. A change notice does not authorize changing production inputs, or regenerating media.',
      parameters: {
        documentId: { ...documentId, required: true },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await call(exec, (_film, documents) => ({ method: 'GET', path: `${documents}/${segment(args.documentId)}/impact` }))
        const items = Array.isArray(result.items) ? result.items : []
        const counts: Record<string, number> = {}
        for (const item of items) if (isRecord(item)) counts[String(item.status)] = (counts[String(item.status)] ?? 0) + 1
        return plain({ ...result, items: items.slice(0, IMPACT_LIMIT), total: items.length, truncated: items.length > IMPACT_LIMIT, counts })
      },
    }),
    defineTool({
      name: 'story_director_links',
      description: 'action "list": the board\'s real director nodes with their saved cameras as shots, their current links and the two fingerprints. '
        + '"link" / "unlink": record (or remove) that one saved screenplay object is the source of one director shot — link {objectId, directorNodeId, '
        + 'directorShotId, expectedDirectorFingerprint, expectedLinksFingerprint, scope?} with the fingerprints from list, plus documentId and '
        + 'expectedRevision. This is provenance only: it never creates or rearranges a 3D scene. A director desk open with unsaved changes must be saved '
        + 'first.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'link', 'unlink'] },
        documentId: { ...documentId, description: 'For link and unlink.' },
        expectedRevision: { ...expectedRevision, description: 'For link and unlink.' },
        boardId,
        link: {
          type: 'object',
          additionalProperties: false,
          description: 'For link and unlink.',
          properties: {
            objectId: { type: 'string', required: true },
            directorNodeId: { type: 'string', required: true },
            directorShotId: { type: 'string', required: true },
            expectedDirectorFingerprint: { type: 'string', required: true },
            expectedLinksFingerprint: { type: 'string', required: true },
            scope,
            boardId,
          },
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        if (args.action === 'list') {
          const result = await call(exec, film => ({ method: 'GET', path: `/api/projects/${segment(film.projectId)}/story/directors?boardId=${segment(args.boardId ?? film.boardId)}` }))
          return plain({
            boardId: result.boardId,
            directors: (Array.isArray(result.directors) ? result.directors : []).filter(isRecord).map(director => ({
              nodeId: director.nodeId, title: director.title, directorFingerprint: director.directorFingerprint, linksFingerprint: director.linksFingerprint, savedScene: director.savedScene,
              shots: Array.isArray(director.shots) ? director.shots.slice(0, 100) : [], links: linksSummary(director.links),
            })),
          })
        }
        if (args.link === undefined) throw new FilmToolError('STORY_TOOL_INPUT', 'Choose action link/unlink and supply an inspected director link object.')
        const id = need(args.documentId, 'documentId', args.action)
        const revision = need(args.expectedRevision, 'expectedRevision', args.action)
        const result = await call(exec, (film, documents) => ({
          method: 'POST',
          path: `${documents}/${segment(id)}/director-links`,
          body: plain({ ...args.link, boardId: args.link!.boardId ?? args.boardId ?? film.boardId, expectedRevision: revision, action: args.action }),
        }))
        const node = isRecord(result.node) ? result.node : {}
        const metadata = isRecord(node.metadata) ? node.metadata : {}
        return plain({
          changed: result.changed,
          revision: result.revision,
          directorNodeId: node.id,
          // What the next link or unlink quotes, so it needs no second list.
          linksFingerprint: createHash('sha256').update(JSON.stringify(metadata.storyDirectorLinks ?? {})).digest('hex'),
          links: linksSummary(metadata.storyDirectorLinks),
          preview: previewSummary(result.preview),
        })
      },
    }),
  ]
}
