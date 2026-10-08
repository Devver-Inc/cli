export class DeployAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployAbortError";
  }
}
