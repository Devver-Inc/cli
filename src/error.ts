export function FormatError(input: unknown) {
  return `Unknown error : ${input}`;
}

export class DeployAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployAbortError";
  }
}
