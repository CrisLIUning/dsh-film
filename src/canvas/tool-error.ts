/**
 * A refusal of a storyboard tool's call, with the stable code that leads what
 * the model reads (the agent's `guarded` turns it into a film tool error).
 * @module dsh-film/canvas/tool-error
 */

export class CanvasToolError extends Error {
  override name = 'CanvasToolError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}
