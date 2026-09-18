export class ClaudeCodeSwitcherError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClaudeCodeSwitcherError';
    this.code = code;
  }
}

export class UnknownProfileError extends ClaudeCodeSwitcherError {
  readonly profile: string;
  readonly source: string;
  constructor(profile: string, source: string) {
    super('UNKNOWN_PROFILE', `Unknown profile "${profile}" (from ${source}).`);
    this.name = 'UnknownProfileError';
    this.profile = profile;
    this.source = source;
  }
}

export class ModeChangeRefusedError extends ClaudeCodeSwitcherError {
  constructor(profile: string, from: string, to: string) {
    super(
      'MODE_CHANGE_REFUSED',
      from === 'shared'
        ? `Cannot change "${profile}" from shared to own: its history IS the shared history, and there is no principled way to decide which sessions were "its". ` +
          `Escape hatch: delete "${profile}" (login snapshot is taken first) and re-create it as own.`
        : `Cannot change "${profile}" from own to shared: merging two projects/ trees risks session-ID collisions and produces a history that never happened. ` +
          `Escape hatch: delete "${profile}" (login snapshot is taken first) and re-create it as shared.`,
    );
    this.name = 'ModeChangeRefusedError';
  }
}
