import { Option, Schema } from "effect";
import type { Json, JsonArray, JsonObject } from "effect/Schema";

import type { ValidationReason } from "./errors";

export const resourceIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const ResourceIdSchema = Schema.String.check(
  Schema.isPattern(resourceIdPattern)
);

export const ProtectionSchema = Schema.Literals(["delete", "retain"]);
export const ResourceStatusSchema = Schema.Literals([
  "pending",
  "ready",
  "deleting",
]);

export type Protection = typeof ProtectionSchema.Type;
export type ResourceStatus = typeof ResourceStatusSchema.Type;

export const ResourceDeclarationSchema = Schema.Struct({
  id: ResourceIdSchema,
  provider: ResourceIdSchema,
  inputs: Schema.Json,
  protection: ProtectionSchema,
});

export type ResourceDeclaration = typeof ResourceDeclarationSchema.Type;

export interface PersistedResource {
  readonly id: string;
  readonly provider: string;
  readonly protection: Protection;
  readonly status: ResourceStatus;
  readonly inputs: Json;
  readonly output: JsonObject | null;
  readonly dependencies: readonly string[];
}

const REF_KEY = "$ref";

const ReferenceSchema = Schema.Struct({
  $ref: ResourceIdSchema,
  output: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u))
  ),
});

const decodeReference = Schema.decodeUnknownOption(ReferenceSchema, {
  onExcessProperty: "error",
});

type Scan =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ValidationReason };

interface ScannedReference {
  readonly target: string;
  readonly key: string | undefined;
}

const isJsonArray = (value: Json): value is JsonArray => Array.isArray(value);

const isJsonObject = (value: Json): value is JsonObject =>
  !Array.isArray(value) && typeof value === "object" && value !== null;

const scanValue = (value: Json, references: ScannedReference[]): Scan => {
  if (isJsonArray(value)) {
    for (const item of value) {
      const scanned = scanValue(item, references);
      if (!scanned.ok) {
        return scanned;
      }
    }
    return { ok: true };
  }
  if (isJsonObject(value)) {
    if (Object.hasOwn(value, REF_KEY)) {
      const decoded = decodeReference(value);
      if (Option.isNone(decoded)) {
        return { ok: false, reason: "invalid-reference" };
      }
      references.push({
        target: decoded.value.$ref,
        key: decoded.value.output,
      });
      return { ok: true };
    }
    for (const key of Object.keys(value)) {
      if (key === "__proto__") {
        return { ok: false, reason: "invalid-inputs" };
      }
      const item = value[key];
      if (item === undefined) {
        return { ok: false, reason: "invalid-inputs" };
      }
      const scanned = scanValue(item, references);
      if (!scanned.ok) {
        return scanned;
      }
    }
    return { ok: true };
  }
  return { ok: true };
};

export interface ApplyPlan {
  readonly levels: readonly (readonly ResourceDeclaration[])[];
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
}

export type Planning =
  | {
      readonly ok: true;
      readonly plan: ApplyPlan;
    }
  | {
      readonly ok: false;
      readonly reason: ValidationReason;
      readonly id: string | undefined;
    };

const failed = (
  reason: ValidationReason,
  id: string | undefined
): Planning => ({ ok: false, reason, id });

type ExternalReferenceCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ValidationReason;
      readonly id: string;
    };

const checkExternalReference = (
  ref: ScannedReference,
  referrer: string,
  persisted: ReadonlyMap<string, PersistedResource>
): ExternalReferenceCheck => {
  const row = persisted.get(ref.target);
  if (row === undefined) {
    return { ok: false, reason: "missing-dependency", id: ref.target };
  }
  if (row.status === "deleting") {
    return { ok: false, reason: "deleting-resource", id: ref.target };
  }
  const { output, status } = row;
  if (status !== "ready" || output === null) {
    return { ok: false, reason: "unresolved-reference", id: ref.target };
  }
  if (ref.key !== undefined && !Object.hasOwn(output, ref.key)) {
    return { ok: false, reason: "invalid-reference", id: referrer };
  }
  return { ok: true };
};

const unique = (values: readonly string[]): readonly string[] => [
  ...new Set(values),
];

type ReferenceScan =
  | {
      readonly ok: true;
      dependencies: Map<string, readonly ScannedReference[]>;
    }
  | {
      readonly ok: false;
      readonly reason: ValidationReason;
      readonly id: string;
    };

const scanReferences = (
  declarations: readonly ResourceDeclaration[]
): ReferenceScan => {
  const dependencies = new Map<string, readonly ScannedReference[]>();
  for (const declaration of declarations) {
    const references: ScannedReference[] = [];
    const scanned = scanValue(declaration.inputs, references);
    if (!scanned.ok) {
      return { ok: false, reason: scanned.reason, id: declaration.id };
    }
    dependencies.set(declaration.id, references);
  }
  return { ok: true, dependencies };
};

const findCycle = (
  nodes: ReadonlySet<string>,
  edges: ReadonlyMap<string, readonly string[]>,
  roots: readonly string[]
): string | undefined => {
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): string | undefined => {
    const state = color.get(id) ?? 0;
    if (state === 1) {
      return id;
    }
    if (state === 2) {
      return undefined;
    }
    color.set(id, 1);
    for (const target of edges.get(id) ?? []) {
      const found = visit(target);
      if (found !== undefined) {
        return found;
      }
    }
    color.set(id, 2);
    return undefined;
  };
  for (const root of roots) {
    const found = visit(root);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

interface LeveledPlan {
  readonly levels: ApplyPlan["levels"];
  readonly stalled: readonly ResourceDeclaration[];
}

const levelPlan = (
  declarations: readonly ResourceDeclaration[],
  dependencies: ReadonlyMap<string, readonly string[]>
): LeveledPlan => {
  const levels: (readonly ResourceDeclaration[])[] = [];
  const satisfied = new Set<string>();
  let pending = [...declarations];
  while (pending.length > 0) {
    const level = pending.filter((declaration) =>
      (dependencies.get(declaration.id) ?? []).every(
        (target) => !dependencies.has(target) || satisfied.has(target)
      )
    );
    if (level.length === 0) {
      return { levels, stalled: pending };
    }
    for (const declaration of level) {
      satisfied.add(declaration.id);
    }
    levels.push(level);
    pending = pending.filter((declaration) => !satisfied.has(declaration.id));
  }
  return { levels, stalled: [] };
};

export const planApply = (
  declarations: readonly ResourceDeclaration[],
  providers: ReadonlySet<string>,
  persisted: ReadonlyMap<string, PersistedResource>
): Planning => {
  const byId = new Map<string, ResourceDeclaration>();
  for (const declaration of declarations) {
    if (byId.has(declaration.id)) {
      return failed("duplicate-id", declaration.id);
    }
    byId.set(declaration.id, declaration);
    if (!providers.has(declaration.provider)) {
      return failed("unknown-provider", declaration.id);
    }
    const row = persisted.get(declaration.id);
    if (row !== undefined) {
      if (row.provider !== declaration.provider) {
        return failed("type-change", declaration.id);
      }
      if (row.status === "deleting") {
        return failed("deleting-resource", declaration.id);
      }
    }
  }

  const scanned = scanReferences(declarations);
  if (!scanned.ok) {
    return failed(scanned.reason, scanned.id);
  }
  const references = scanned.dependencies;
  const dependencies = new Map<string, readonly string[]>();
  for (const [id, refs] of references) {
    dependencies.set(id, unique(refs.map((ref) => ref.target)));
    for (const ref of refs) {
      if (byId.has(ref.target)) {
        continue;
      }
      const checked = checkExternalReference(ref, id, persisted);
      if (!checked.ok) {
        return failed(checked.reason, checked.id);
      }
    }
  }

  const nodes = new Set<string>([...byId.keys(), ...persisted.keys()]);
  const edges = new Map<string, readonly string[]>();
  const nodeDeps = (id: string): readonly string[] =>
    byId.has(id)
      ? (dependencies.get(id) ?? [])
      : (persisted.get(id)?.dependencies ?? []);
  for (const node of nodes) {
    edges.set(
      node,
      nodeDeps(node).filter((target) => nodes.has(target))
    );
  }
  const cycle = findCycle(
    nodes,
    edges,
    declarations.map((declaration) => declaration.id)
  );
  if (cycle !== undefined) {
    return failed("cycle", cycle);
  }

  const leveled = levelPlan(declarations, dependencies);
  if (leveled.stalled.length > 0) {
    return failed("cycle", leveled.stalled[0]?.id);
  }
  return {
    ok: true,
    plan: { levels: leveled.levels, dependencies },
  };
};

export type Resolution =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false };

export const resolveInputs = (
  inputs: Json,
  outputs: ReadonlyMap<string, JsonObject>,
  externalOutputs: ReadonlyMap<string, JsonObject>
): Resolution => {
  if (isJsonArray(inputs)) {
    const values: Json[] = [];
    for (const item of inputs) {
      const resolved = resolveInputs(item, outputs, externalOutputs);
      if (!resolved.ok) {
        return resolved;
      }
      values.push(resolved.value);
    }
    return { ok: true, value: values };
  }
  if (isJsonObject(inputs)) {
    if (Object.hasOwn(inputs, REF_KEY)) {
      const decoded = decodeReference(inputs);
      if (Option.isNone(decoded)) {
        return { ok: false };
      }
      const { $ref: target, output: selectedKey } = decoded.value;
      const output = outputs.get(target) ?? externalOutputs.get(target);
      if (output === undefined) {
        return { ok: false };
      }
      if (selectedKey === undefined) {
        return { ok: true, value: output };
      }
      if (!Object.hasOwn(output, selectedKey)) {
        return { ok: false };
      }
      const selected = output[selectedKey];
      return selected === undefined
        ? { ok: false }
        : { ok: true, value: selected };
    }
    const values: Record<string, Json> = {};
    for (const key of Object.keys(inputs)) {
      const item = inputs[key];
      if (item === undefined) {
        return { ok: false };
      }
      const resolved = resolveInputs(item, outputs, externalOutputs);
      if (!resolved.ok) {
        return resolved;
      }
      values[key] = resolved.value;
    }
    return { ok: true, value: values };
  }
  return { ok: true, value: inputs };
};

export type DeletionOrderPlan =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false };

export const deletionOrder = (
  members: readonly string[],
  rows: ReadonlyMap<string, PersistedResource>
): DeletionOrderPlan => {
  const memberSet = new Set(members);
  const edges = new Map<string, readonly string[]>();
  for (const id of memberSet) {
    edges.set(
      id,
      (rows.get(id)?.dependencies ?? []).filter((dep) => memberSet.has(dep))
    );
  }
  if (findCycle(memberSet, edges, members) !== undefined) {
    return { ok: false };
  }
  const height = new Map<string, number>();
  const heightOf = (id: string): number => {
    const known = height.get(id);
    if (known !== undefined) {
      return known;
    }
    const deps = edges.get(id) ?? [];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(heightOf));
    height.set(id, value);
    return value;
  };
  return {
    ok: true,
    order: members
      .map((id) => ({ id, height: heightOf(id) }))
      .toSorted((a, b) => b.height - a.height || (a.id < b.id ? -1 : 1))
      .map((entry) => entry.id),
  };
};
