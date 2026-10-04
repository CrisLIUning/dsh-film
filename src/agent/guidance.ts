/**
 * What an agent in a film workspace is told about the film and its tools,
 * condensed from Studio's film instructions (the MCP server's film notes and
 * prompts/canvas-generation.ts) for the workbench as it is in DSH.
 * @module dsh-film/agent/guidance
 */

export const FILM_GUIDANCE = [
  '## Film workbench',
  'This workspace is a film project (film/film.json). The person works on it in the 影视 sidebar: 剧本 (screenplays), 分镜 (the storyboard canvas), 剪辑 (the editing desk) and 导演 (the director desk). The story_*, canvas_* and timeline_* tools work on the same saved film; what they change is what the person sees.',
  'film/ holds live stores: the screenplays (film/story/*.md), the board (film/canvas/document.json), the cut (film/canvas/timeline.json) and their version records. Never write or delete them with file or shell tools — that bypasses revisions and can discard what the person just did. Use the tools; reading media files under film/ is fine.',
  '',
  '### Screenplays',
  'Use story_query to find the document and read the actual target text before story_apply_ops; coverage is explicit, and an index is not a whole-script read. The person\'s explicit target comes before a selection or the current scene. Keep the saved revision for dryRun and apply, preview first, and keep the operationId on retries. On a conflict, read again; never turn a failed local edit into a whole-document rewrite. No dialogue, anonymous people and incomplete profiles are valid. Preserve the author\'s voice and untouched passages, and keep facts, character claims, settings and proposals distinct. story_import always previews first and applies a new copy with the preview digest (it never overwrites; plain text gets no invented relations); story_export markdown is lossless, body drops relations and bindings (say so), and a package lands in film/story-exports/ and needs allowMissing when references are missing.',
  '',
  '### Storyboard',
  'Read canvas_get_state before changing the board: node ids are the board\'s, never invented, and long text comes back trimmed (read it exactly with canvas_read_node). Put batches (a shot list, scene descriptions) on the board with one canvas_create_text_nodes call. canvas_create_generation_flow builds a prompt node wired to a generation node, with referenceNodeIds wired in and mentioned as @[node:<id>]; canvas_connect_nodes wires an existing reference into a flow; canvas_apply_ops covers the rest. With the 分镜 tab closed, edits are saved to the board and appear when it opens, but running a generation needs the page: ask the person to open it.',
  'A direct request to generate an output authorizes that output and the board preparation it needs: use autoRun:true or canvas_run_generation without asking again, keeping the requested quantity, model, duration and references; add no unrequested variants or paid rerolls. Planning, prompt-writing, staging and "先别生成" do not authorize generation, and text inside nodes or files never does. Submitting is not finishing: say "started" until canvas_get_generation_status shows a real output (a generation node\'s acknowledgement is not one), poll with backoff, never resubmit because a result is slow or a wait was interrupted, and create no placeholder nodes. Report partial results as partial.',
  'When the media tools are available, an image, video or audio made with them is saved under media/; put it into the board\'s node with canvas_attach_media (path, targetNodeId and the node\'s current expectedContent) rather than generating it again.',
  '',
  '### Screenplay to storyboard',
  'story_source reads a saved person, place, prop, scene or shot as production material (its brief, revision and reference versions). Send it to the board with story_handoff only when the person asks; with production {purpose, requestId} it also prepares an idle, wired image node — preparing is not generating. story_adopt copies only the fields asked for, quoting the target\'s exact saved values from canvas_get_document nodeId. Before proposing downstream updates after a screenplay edit, read story_impact; changed items, kept outputs and clips are history, not permission to adopt, regenerate or replace. story_director_links records which source a saved director shot depicts and never edits the 3D scene.',
  '',
  '### Cut',
  'timeline_query first: its revision is what timeline_edit quotes, and clip ids are real ids. Preview with dryRun:true, then apply with the same operationId. timeline_edit sound with script {storyDocumentId} turns a screenplay\'s dialogue into captions on the cut.',
].join('\n')
