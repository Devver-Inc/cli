export interface LaunchRule {
  readonly script: RegExp;
  readonly hostFlag: "--host" | "--hostname";
  readonly extraArgs: readonly string[];
}
