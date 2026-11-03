export interface StackRule {
  readonly category: "meta" | "backend" | "vite";
  readonly name: string;
  readonly deps: readonly string[];
}
