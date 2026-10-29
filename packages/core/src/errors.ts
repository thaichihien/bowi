/**
 * Errors that map to CLI exit codes (CLI-11).
 *
 * Every error carries a message for the user and, where possible, a next step (CLI-12).
 */

export class BowiError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, exitCode: number, hint?: string) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/** Exit code 1: bad flags or arguments. */
export class UsageError extends BowiError {
  constructor(message: string, hint?: string) {
    super(message, 1, hint);
  }
}

/** Exit code 2: the source could not be read (auth, not found, network, not a repository). */
export class SourceError extends BowiError {
  constructor(message: string, hint?: string) {
    super(message, 2, hint);
  }
}

/** Exit code 3: the engine failed or an invariant was violated. */
export class AnalysisError extends BowiError {
  constructor(message: string, hint?: string) {
    super(message, 3, hint);
  }
}
