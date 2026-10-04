/**
 * `film_project`: the one film tool every conversation has. It tells the
 * agent whether its workspace is a film, starts one when the person wants a
 * film made there (the workbench also starts it when one of its tabs opens),
 * and renames the film or changes its frame; the rest of the film tools come
 * with the project.
 * @module dsh-film/agent/project-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FilmError } from '../errors.js'
import { ASPECT_RATIOS, PROJECT_FILE, createProject, parseNewProject, parseProjectChange, readProject, updateProject } from '../project.js'
import { jsonOutput, plain, workspaceFolder } from './context.js'
import type { FilmToolServices } from './context.js'
import { FilmToolError } from './studio-client.js'

/** The project's refusals as tool failures with their code. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof FilmError) throw new FilmToolError(error.code, error.message)
    throw error
  }
}

/**
 * Build the tool.
 * @param services - the film services.
 * @returns the tool definition.
 */
export function filmProjectTool(services: FilmToolServices): ToolDefinition {
  return defineTool({
    name: 'film_project',
    description: 'The film project of this conversation\'s workspace, worked on in the 影视 sidebar (剧本 screenplays, 分镜 storyboard, 剪辑 editing desk, '
      + '导演 director desk). action "status" reads it; "create" starts one, kept as files under film/, and the story_*, canvas_* and timeline_* tools come '
      + 'with it (the sidebar also creates it, named after the folder, when the person opens one of its tabs); create one only when the person wants a '
      + 'film, short or storyboard made here. "update" renames the film (title) or changes its frame (aspectRatio); the frame applies to new cuts, and an '
      + 'existing cut\'s frame is changed in the editing desk (timeline_edit project.set_ratio).',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'create', 'update'] },
      title: { type: 'string', description: 'For create (defaults to the folder name) and update.' },
      aspectRatio: { type: 'string', enum: ASPECT_RATIOS, description: 'For create (defaults to 16:9) and update.' },
    },
    output: jsonOutput,
    execute: (args, exec) => guarded(async () => {
      const cwd = workspaceFolder(exec)
      if (args.action === 'status') {
        const project = await readProject(cwd)
        // A conversation that started before the film existed takes its film tools on here (installing again changes nothing).
        if (project !== null) services.projectCreated(cwd)
        return plain(project === null ? { project: null, note: 'This workspace has no film project.' } : { project, file: PROJECT_FILE })
      }
      if (args.action === 'update') {
        const { project, changed } = await updateProject(cwd, parseProjectChange({ title: args.title, aspectRatio: args.aspectRatio }))
        if (changed) services.events.emit(cwd, { type: 'project-changed', projectId: project.id, project })
        services.projectCreated(cwd)
        return plain({
          project,
          changed,
          note: changed ? 'Saved; the 影视 sidebar shows it. A new frame applies to new cuts only.' : 'The film already has this title and frame.',
        })
      }
      const result = await createProject(cwd, parseNewProject({ title: args.title, aspectRatio: args.aspectRatio }, cwd))
      services.projectCreated(cwd)
      return plain({
        project: result.project,
        created: result.created,
        note: result.created
          ? 'Created. The film tools (story_*, canvas_*, timeline_*) are available from your next step, and the 影视 sidebar shows the film.'
          : 'This workspace already has this film project. The film tools are available from your next step.',
      })
    }),
  })
}
