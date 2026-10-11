#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";

import { Schema } from "effect";

const decodeVersion = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.String })
);
const cli = decodeVersion(
  JSON.parse(readFileSync("packages/cli/package.json", "utf-8"))
);
const document = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown)
)(JSON.parse(readFileSync("package.json", "utf-8")));
writeFileSync(
  "package.json",
  `${JSON.stringify({ ...document, version: cli.version }, null, 2)}\n`
);
