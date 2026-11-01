import { expect, test } from "bun:test";

import { ferronConfig } from "../index";

test("the generated static config binds only the reserved loopback port", () => {
  expect(ferronConfig("/srv/site", 52_041)).toBe(`* {
    listen_ip "127.0.0.1"
    default_http_port #null
    default_https_port #null
}

*:52041 {
    root "/srv/site"
    rewrite "^/([^?#]*/)*[^./?#]*(?:[?#].*)?$" "/" file=#false directory=#false last=#true
}
`);
});

test("a path that could escape the config or interpolate the environment fails closed", () => {
  for (const directory of [
    '/srv/a"b',
    String.raw`/srv/a\b`,
    "/srv/{env:HOME}",
    "/srv/a\nb",
    "/srv/a\rb",
  ]) {
    expect(() => ferronConfig(directory, 52_041)).toThrow(
      "A deployment path cannot contain quotes, backslashes, braces or newlines"
    );
  }
});
