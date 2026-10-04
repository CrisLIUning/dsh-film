/**
 * Failures the routes answer with: a code the browser half routes on and a
 * message for people.
 * @module dsh-film/errors
 */

/** Codes the browser half knows, with the HTTP status each one answers with. */
export const FILM_ERROR_STATUS = {
  BAD_REQUEST: 400,
  NOT_MEDIA: 415,
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_REFUSED: 403,
  FILE_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  PROJECT_INVALID: 422,
  PROJECT_UNSUPPORTED: 422,
} as const

export type FilmErrorCode = keyof typeof FILM_ERROR_STATUS

export class FilmError extends Error {
  override name = 'FilmError'

  constructor(readonly code: FilmErrorCode, message: string) {
    super(message)
  }

  get status(): number {
    return FILM_ERROR_STATUS[this.code]
  }
}
