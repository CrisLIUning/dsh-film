import type { StoryDiagnostic } from './types.js';

export class StoryOperationError extends Error {
  constructor(readonly code: string, message: string, readonly diagnostics: StoryDiagnostic[] = []) { super(message); }
}
