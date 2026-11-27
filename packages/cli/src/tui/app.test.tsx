import { expect, test } from "bun:test";
import { join } from "node:path";

import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import { App } from "./app";

process.env.DEVVER_REDUCED_MOTION = "1";

test("all targets show a newer release after the TUI starts", async () => {
  for (const target of [
    { kind: "none" },
    { kind: "cloud", project: "demo" },
    {
      kind: "local",
      server: "demo",
      workspace: "site",
      loadDeployments: async () => [],
    },
  ] as const) {
    const setup = await testRender(
      <App
        onExit={() => undefined}
        target={target}
        version="1.2.0 (nightly)"
        checkUpdate={async () => ({
          version: "1.3.0-nightly.build.10.1",
          url: "https://example.test/release",
        })}
      />,
      { width: 100, height: 20 }
    );
    try {
      const frame = await setup.waitForFrame((value) =>
        value.includes("devver --update · v1.3.0-nightly.build.10.1 available")
      );
      expect(frame).toContain("v1.3.0-nightly.build.10.1 available");
      expect(frame).toContain("v1.2.0 (nightly)");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  }
});

test("shows honest deployment status and exits", async () => {
  let exits = 0;
  const setup = await testRender(
    <App
      onExit={() => {
        exits += 1;
      }}
      target={{ kind: "cloud", project: "demo" }}
      version="1.2.0"
    />,
    { width: 80, height: 20 }
  );
  try {
    const frame = await setup.waitForFrame((value) =>
      value.includes("Deployment browsing is not available yet")
    );
    expect(frame).toContain("No organization / demo");
    expect(frame).toContain("v1.2.0");
    expect(frame).not.toContain("storefront.devver.app");
    await act(async () => {
      setup.mockInput.pressKey("q");
      await Promise.resolve();
    });
    await setup.waitFor(() => exits === 1);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("organization switch failure never displays private errors", async () => {
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "cloud",
        currentOrganization: "org-1",
        onSwitchOrganization: async () => {
          throw new Error("private credential");
        },
        organizations: [
          { id: "org-1", name: "Acme" },
          { id: "org-2", name: "Other" },
        ],
      }}
    />,
    { width: 80, height: 20 }
  );
  try {
    await act(async () => {
      setup.mockInput.pressKey("g");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("Other"));
    await act(async () => {
      setup.mockInput.pressArrow("down");
      await Promise.resolve();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("Could not switch organization")
    );
    expect(frame).toContain("Acme / No project");
    expect(frame).not.toContain("private credential");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("an old project picker request cannot replace another organization's projects", async () => {
  let resolveOld:
    | ((projects: readonly { id: string; name: string }[]) => void)
    | undefined;
  let requests = 0;
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "cloud",
        currentOrganization: "org-1",
        organizations: [
          { id: "org-1", name: "Acme" },
          { id: "org-2", name: "Other" },
        ],
        loadProjects: async () => {
          requests += 1;
          if (requests === 2 || requests === 4) {
            return await new Promise<readonly { id: string; name: string }[]>(
              (resolve) => {
                resolveOld = resolve;
              }
            );
          }
          return [
            {
              id: requests === 1 ? "old" : "new",
              name: requests === 1 ? "Old" : "New",
            },
          ];
        },
        onSwitchOrganization: async () => undefined,
        onSwitchProject: async () => undefined,
      }}
    />,
    { width: 80, height: 20 }
  );
  try {
    await setup.waitForFrame((value) =>
      value.includes("Acme / Select project")
    );
    await act(async () => {
      setup.mockInput.pressKey("p");
      await Promise.resolve();
    });
    await setup.waitFor(() => requests === 2);
    await act(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(100);
    });
    await act(async () => {
      setup.mockInput.pressKey("g");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("Select organization"));
    await act(async () => {
      setup.mockInput.pressArrow("down");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("◆ Other"));
    await act(async () => {
      setup.mockInput.pressEnter();
      await Promise.resolve();
    });
    await setup.waitForFrame((value) =>
      value.includes("Other / Select project")
    );
    await setup.waitFor(() => requests === 3);
    await act(async () => {
      resolveOld?.([{ id: "stale", name: "Stale" }]);
      await Promise.resolve();
    });
    await act(async () => {
      setup.mockInput.pressKey("p");
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("Select project ·")
    );
    expect(frame).toContain("New");
    expect(frame).not.toContain("Stale");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("project picker persists selection only after success", async () => {
  const calls: string[] = [];
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "cloud",
        currentOrganization: "org-1",
        currentProjectId: "p1",
        organizations: [{ id: "org-1", name: "Acme" }],
        loadProjects: async () => [
          { id: "p1", name: "Storefront" },
          { id: "p2", name: "Dashboard" },
        ],
        onSwitchProject: async (id) => {
          calls.push(id);
        },
      }}
    />,
    { width: 80, height: 20 }
  );
  try {
    await setup.waitForFrame((value) => value.includes("Acme / Storefront"));
    await act(async () => {
      setup.mockInput.pressKey("p");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("Dashboard"));
    await act(async () => {
      setup.mockInput.pressArrow("down");
      await Promise.resolve();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("Acme / Dashboard")
    );
    expect(frame).toContain("Deployment browsing is not available yet");
    expect(calls).toEqual(["p2"]);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

for (const { target, label } of [
  {
    target: {
      kind: "local",
      server: "dev",
      workspace: "site",
      loadDeployments: async () => [],
    } as const,
    label: "dev / workspace: site",
  },
  { target: { kind: "none" } as const, label: "No target selected" },
]) {
  test(`${target.kind} target hides cloud selectors`, async () => {
    const setup = await testRender(
      <App target={target} onExit={() => undefined} />,
      { width: 80, height: 20 }
    );
    try {
      const frame = await setup.waitForFrame((value) => value.includes(label));
      expect(frame).toContain("q quit");
      expect(frame).not.toContain("organization");
      expect(frame).not.toContain("project ·");
      for (const key of ["g", "p"]) {
        await act(async () => {
          setup.mockInput.pressKey(key);
          await Promise.resolve();
        });
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain(label);
        expect(setup.captureCharFrame()).not.toContain("Select organization");
        expect(setup.captureCharFrame()).not.toContain("Select project");
      }
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
}

test("local deployments show only the opened checkout", async () => {
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "site",
        repositoryId: "a".repeat(64),
        loadDeployments: async () => [
          {
            deploymentId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "a".repeat(64),
            commit: "b".repeat(40),
            status: "ready",
            stage: null,
          },
          {
            deploymentId: "22222222-2222-4222-8222-222222222222",
            repositoryId: "c".repeat(64),
            commit: "d".repeat(40),
            status: "degraded",
            stage: "process",
          },
          {
            deploymentId: "33333333-3333-4333-8333-333333333333",
            status: "failed",
            stage: "git",
          },
        ],
      }}
    />,
    { width: 90, height: 20 }
  );
  try {
    const frame = await setup.waitForFrame((value) =>
      value.includes("bbbbbbbb")
    );
    expect(frame).toContain("bbbbbbbb");
    expect(frame).not.toContain("dddddddd");
    expect(frame).not.toContain("eeeeeeee");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("local deployments render as a tree with selection navigation", async () => {
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "site",
        loadDeployments: async () => [
          {
            deploymentId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "a".repeat(64),
            commit: "b".repeat(40),
            parentDeploymentId: null,
            status: "ready",
            stage: null,
          },
          {
            deploymentId: "22222222-2222-4222-8222-222222222222",
            repositoryId: "a".repeat(64),
            commit: "d".repeat(40),
            parentDeploymentId: "11111111-1111-4111-8111-111111111111",
            status: "ready",
            stage: null,
          },
          {
            deploymentId: "33333333-3333-4333-8333-333333333333",
            repositoryId: "a".repeat(64),
            commit: "e".repeat(40),
            parentDeploymentId: "22222222-2222-4222-8222-222222222222",
            status: "ready",
            stage: null,
          },
        ],
      }}
    />,
    { width: 90, height: 20 }
  );
  try {
    await setup.waitForFrame((value) => value.includes("bbbbbbbb"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("▸ ●  bbbbbbbb");
    expect(frame).toContain("╰ next dddddddd");
    expect(frame).toContain("dddddddd   ↓ child");
    await act(async () => {
      setup.mockInput.pressKey("j");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("▸ ●  └─ dddddddd"));
    await act(async () => {
      setup.mockInput.pressKey("l");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("▸ ●    └─ eeeeeeee"));
    await act(async () => {
      setup.mockInput.pressKey("h");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("▸ ●  └─ dddddddd"));
    await act(async () => {
      setup.mockInput.pressKey("k");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("▸ ●  bbbbbbbb"));
    await act(async () => {
      setup.mockInput.pressKey("h");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("▸ ●    └─ eeeeeeee"));
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("d opens deployment details and Esc closes them", async () => {
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "site",
        loadDeployments: async () => [
          {
            deploymentId: "11111111-1111-4111-8111-111111111111",
            repositoryId: "a".repeat(64),
            commit: "b".repeat(40),
            commitSubject: "Add the landing page",
            createdAt: "2026-10-30T18:21:00.000Z",
            parentDeploymentId: null,
            status: "ready",
            stage: null,
            url: "http://a.localhost:1/",
            publicUrl:
              "https://d3e8aa51d75b34c7e9fca1190e573fefb.shvdmprfczuh.tunnels.devver.app/",
          },
        ],
      }}
    />,
    { width: 90, height: 24 }
  );
  try {
    await setup.waitForFrame((value) => value.includes("Add the landing page"));
    await act(async () => {
      setup.mockInput.pressKey("d");
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("11111111-1111-4111-8111-111111111111")
    );
    expect(frame).toContain("b".repeat(40));
    expect(frame).toContain("deployed as a root");
    expect(frame).toContain("local url");
    expect(frame).toContain("public url");
    expect(frame).toContain("http://a.localhost:1/");
    expect(frame.replaceAll(/[\s│]/gu, "")).toContain(
      "https://d3e8aa51d75b34c7e9fca1190e573fefb.shvdmprfczuh.tunnels.devver.app/"
    );
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(setup.captureCharFrame()).toContain("d details");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("o opens a ready deployment URL and reports one without a URL", async () => {
  const opened: string[] = [];
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "site",
        openInBrowser: async (url) => {
          opened.push(url);
          return true;
        },
        loadDeployments: async () => [
          {
            deploymentId: "11111111-1111-4111-8111-111111111111",
            status: "ready",
            stage: null,
            url: "http://a.localhost:1/",
          },
          {
            deploymentId: "22222222-2222-4222-8222-222222222222",
            status: "failed",
            stage: "git",
            url: null,
          },
        ],
      }}
    />,
    { width: 90, height: 14 }
  );
  try {
    await setup.waitForFrame((value) => value.includes("11111111"));
    await act(async () => {
      setup.mockInput.pressKey("o");
      await Promise.resolve();
    });
    await setup.waitForFrame((value) =>
      value.includes("Opened http://a.localhost:1/")
    );
    expect(opened).toEqual(["http://a.localhost:1/"]);
    await act(async () => {
      setup.mockInput.pressKey("j");
      await Promise.resolve();
    });
    await act(async () => {
      setup.mockInput.pressKey("o");
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((value) =>
      value.includes("This deployment is not ready, so it has no URL to open.")
    );
    expect(opened).toEqual(["http://a.localhost:1/"]);
    expect(frame).toContain("22222222  failed (git)");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("c copies only a selected ready URL and reports clipboard failure", async () => {
  const copied: string[] = [];
  let outcome: "success" | "failed" | "throws" = "success";
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "site",
        copyUrl: async (url) => {
          copied.push(url);
          if (outcome === "throws") {
            throw new Error("private clipboard failure");
          }
          return outcome === "success";
        },
        loadDeployments: async () => [
          {
            deploymentId: "11111111-1111-4111-8111-111111111111",
            status: "ready",
            stage: null,
            url: "http://a.localhost:1/",
          },
          {
            deploymentId: "22222222-2222-4222-8222-222222222222",
            status: "ready",
            stage: null,
            url: "",
          },
          {
            deploymentId: "33333333-3333-4333-8333-333333333333",
            status: "ready",
            stage: null,
            url: null,
          },
          {
            deploymentId: "44444444-4444-4444-8444-444444444444",
            status: "ready",
            stage: null,
          },
          {
            deploymentId: "55555555-5555-4555-8555-555555555555",
            status: "failed",
            stage: "git",
            url: "http://failed.localhost:1/",
          },
        ],
      }}
    />,
    { width: 90, height: 14 }
  );
  try {
    const initial = await setup.waitForFrame((value) =>
      value.includes("11111111")
    );
    expect(initial).toContain("├ url  http://a.localhost:1/");
    expect(initial).not.toContain("open with o");
    expect(initial).not.toContain("copy with c");
    expect(initial).toContain("o open · c copy");
    await act(async () => {
      setup.mockInput.pressKey("c");
      await Promise.resolve();
    });
    expect(
      await setup.waitForFrame((value) =>
        value.includes("Sent deployment URL to clipboard.")
      )
    ).not.toContain("Sent deployment URL to clipboard. http");
    expect(copied).toEqual(["http://a.localhost:1/"]);
    outcome = "failed";
    await act(async () => {
      setup.mockInput.pressKey("c");
      await Promise.resolve();
    });
    const failed = await setup.waitForFrame((value) =>
      value.includes("Could not copy the deployment URL.")
    );
    expect(failed).not.toContain("Sent deployment URL to clipboard.");
    outcome = "throws";
    await act(async () => {
      setup.mockInput.pressKey("c");
      await Promise.resolve();
    });
    const rejected = await setup.waitForFrame((value) =>
      value.includes("Could not copy the deployment URL.")
    );
    expect(rejected).not.toContain("private clipboard failure");
    expect(copied).toEqual([
      "http://a.localhost:1/",
      "http://a.localhost:1/",
      "http://a.localhost:1/",
    ]);
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        setup.mockInput.pressKey("j");
        await Promise.resolve();
      });
      await act(async () => {
        setup.mockInput.pressKey("c");
        await Promise.resolve();
      });
      expect(
        await setup.waitForFrame((value) =>
          value.includes("This deployment has no ready URL to copy.")
        )
      ).not.toContain("http://failed.localhost:1/");
    }
    expect(copied).toEqual([
      "http://a.localhost:1/",
      "http://a.localhost:1/",
      "http://a.localhost:1/",
    ]);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("s confirms publication, keeps both URLs, and never repeats or leaks failures", async () => {
  const published: string[] = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const publication = Promise.withResolvers<{ url: string }>();
  let rejectNext = false;
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "site",
        publishDeployment: async (id) => {
          published.push(id);
          if (rejectNext) {
            throw new Error("private relay credential");
          }
          return await publication.promise;
        },
        openInBrowser: async (url) => {
          opened.push(url);
          return true;
        },
        copyUrl: async (url) => {
          copied.push(url);
          return true;
        },
        loadDeployments: async () => [
          {
            deploymentId: "11111111-1111-4111-8111-111111111111",
            status: "ready",
            stage: null,
            url: "http://a.localhost:1/",
          },
          {
            deploymentId: "22222222-2222-4222-8222-222222222222",
            status: "failed",
            stage: "readiness",
            url: null,
          },
        ],
      }}
    />,
    { width: 80, height: 24 }
  );
  const press = async (...keys: string[]) => {
    await act(async () => {
      for (const key of keys) {
        if (key === "return") {
          setup.mockInput.pressEnter();
        } else if (key === "escape") {
          setup.mockInput.pressEscape();
        } else {
          setup.mockInput.pressKey(key);
        }
      }
      if (keys.includes("escape")) {
        await new Promise((resolve) => {
          setTimeout(resolve, 80);
        });
      }
      await Promise.resolve();
    });
  };
  try {
    await setup.waitForFrame((value) => value.includes("s publish"));
    await press("s");
    const warning = await setup.waitForFrame((value) =>
      value.includes("Anyone with the URL can access this deployment.")
    );
    expect(warning).toContain("Enter publish · Esc cancel");
    expect(published).toEqual([]);
    await press("escape");
    await press("s");
    expect(published).toEqual([]);
    await press("return", "return");
    expect(published).toEqual(["11111111-1111-4111-8111-111111111111"]);
    await setup.waitForFrame((value) =>
      value.includes("Publishing deployment")
    );
    await act(async () => {
      publication.resolve({ url: "https://preview.example.com/" });
      await Promise.resolve();
    });
    await setup.waitForFrame((value) => value.includes("Published. o opens"));
    await press("d");
    const details = await setup.waitForFrame((value) =>
      value.includes("public url")
    );
    expect(details).toContain("http://a.localhost:1/");
    expect(details).toContain("https://preview.example.com/");
    await press("escape");
    await press("o", "c");
    expect(opened).toEqual(["https://preview.example.com/"]);
    expect(copied).toEqual(["https://preview.example.com/"]);

    await press("j");
    await press("s");
    await setup.waitForFrame((value) =>
      value.includes("Only ready deployments")
    );
    expect(published).toHaveLength(1);

    rejectNext = true;
    await press("k");
    await press("s");
    await press("return");
    const failed = await setup.waitForFrame((value) =>
      value.includes("Could not publish")
    );
    expect(failed).not.toContain("private relay credential");
    expect(published).toHaveLength(2);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("without a Git checkout the TUI does not claim server deployments match", async () => {
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "scratch",
        loadDeployments: async () => [
          {
            deploymentId: "44444444-4444-4444-8444-444444444444",
            status: "ready",
            stage: null,
          },
        ],
      }}
    />,
    { width: 80, height: 12 }
  );
  try {
    const frame = await setup.waitForFrame((value) =>
      value.includes("44444444")
    );
    expect(frame).toContain("44444444");
    expect(frame).not.toContain("This checkout");
    expect(frame).not.toContain("Other server deployments");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("local listing distinguishes unavailable, empty, and failed responses", async () => {
  for (const [response, message] of [
    [null, "Deployment listing is unavailable on this server. Use a server"],
    [
      [],
      "No deployments on this server. Run devver deploy from a Git checkout.",
    ],
  ] as const) {
    const setup = await testRender(
      <App
        onExit={() => undefined}
        target={{
          kind: "local",
          server: "dev",
          workspace: "site",
          loadDeployments: async () => response,
        }}
      />,
      { width: 80, height: 12 }
    );
    try {
      expect(
        await setup.waitForFrame((value) => value.includes(message))
      ).toContain(message);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  }
  const setup = await testRender(
    <App
      onExit={() => undefined}
      target={{
        kind: "local",
        server: "dev",
        workspace: "site",
        loadDeployments: async () => {
          throw new Error("secret details");
        },
      }}
    />,
    { width: 80, height: 12 }
  );
  try {
    const frame = await setup.waitForFrame((value) =>
      value.includes("Could not load deployments from this server.")
    );
    expect(frame).toContain("devver server status");
    expect(frame).not.toContain("secret details");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("the TUI releases the renderer and never blocks process exit", () => {
  const probe = Bun.spawnSync(
    [
      "bun",
      "run",
      join(import.meta.dir, "../../tests/fixtures", "tui-probe.ts"),
    ],
    {
      cwd: join(import.meta.dir, "../../../../"),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = probe.stderr.toString();
  expect(probe.exitCode, output).toBe(0);
  expect(output).toContain('PROBE {"outcome":"timeout"}');
});
