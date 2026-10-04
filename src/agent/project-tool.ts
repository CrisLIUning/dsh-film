/**
 * `film_project`: the one film tool every conversation has. It tells the
 * agent whether its workspace is a film and starts one when the person wants
 * a film made there; the rest of the film tools come with the project.
 * @module dsh-film/agent/project-tool
 */

import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ASPECT_RATIOS, PROJECT_FILE, createProject, parseNewProject, readProject } from '../project.js'
import { jsonOutput, plain, workspaceFolder } from './context.js'
import type { FilmToolServices } from './context.js'

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
      + 'with it. Create one only when the person wants a film, short or storyboard made here.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'create'] },
      title: { type: 'string', description: 'For create; defaults to the folder name.' },
      aspectRatio: { type: 'string', enum: ASPECT_RATIOS, description: 'For create; defaults to 16:9.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const cwd = workspaceFolder(exec)
      if (args.action === 'status') {
        const project = await readProject(cwd)
        // A conversation that started before the film existed takes its film tools on here (installing again changes nothing).
        if (project !== null) services.projectCreated(cwd)
        return plain(project === null ? { project: null, note: 'This workspace has no film project.' } : { project, file: PROJECT_FILE })
      }
      const title = args.title !== undefined && args.title.trim() !== '' ? args.title : basename(cwd)
      const result = await createProject(cwd, parseNewProject({ title, ...(args.aspectRatio !== undefined ? { aspectRatio: args.aspectRatio } : {}) }))
      services.projectCreated(cwd)
      return plain({
        project: result.project,
        created: result.created,
        note: result.created
          ? 'Created. The film tools (story_*, canvas_*, timeline_*) are available from your next step, and the 影视 sidebar shows the film.'
          : 'This workspace already has this film project. The film tools are available from your next step.',
      })
    },
  })
}
