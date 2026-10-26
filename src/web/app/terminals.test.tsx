import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createSampleSnapshot, InMemoryRoutesGateway } from "../features/routes/index.ts";
import { InMemoryTerminalsGateway, type TerminalEngine } from "../features/terminals/index.ts";
import { App } from "./app.tsx";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const FALCON = "/home/dev/code/acme-falcon";

/** Stands in for xterm.js, which needs a real browser: records what it is given. */
function fakeEngine() {
  const screens: {
    written: string[];
    type(text: string): void;
    disposed: boolean;
    focused: number;
    options: Record<string, unknown>;
    /** What xterm.js would do with a key: false means the page keeps it. */
    keyHandler: (event: KeyboardEvent) => boolean;
    /** Stands in for a live text selection; empty means none, like real xterm.js at rest. */
    selected: string;
  }[] = [];
  const engine: TerminalEngine = {
    createTerminal: () => {
      let onData: (text: string) => void = () => {};
      const options: Record<string, unknown> = {};
      const screen = {
        written: [] as string[],
        disposed: false,
        focused: 0,
        options,
        type: (text: string) => onData(text),
        keyHandler: (_event: KeyboardEvent) => true,
        selected: "",
      };
      screens.push(screen);
      const terminal = {
        options,
        buffer: { active: { viewportY: 0, baseY: 0 } },
        loadAddon: () => {},
        open: () => {},
        write: (text: string, done?: () => void) => {
          screen.written.push(text);
          done?.();
        },
        scrollToBottom: () => {},
        scrollToLine: () => {},
        focus: () => {
          screen.focused += 1;
        },
        hasSelection: () => screen.selected !== "",
        getSelection: () => screen.selected,
        attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
          screen.keyHandler = handler;
        },
        onScroll: () => ({ dispose: () => {} }),
        onData: (listener: (text: string) => void) => {
          onData = listener;
          return { dispose: () => {} };
        },
        dispose: () => {
          screen.disposed = true;
        },
      };
      return terminal as unknown as ReturnType<TerminalEngine["createTerminal"]>;
    },
    createFit: () => ({ fit: () => {} }) as unknown as ReturnType<TerminalEngine["createFit"]>,
  };
  return { engine, screens };
}

function setup() {
  const gateway = new InMemoryRoutesGateway(createSampleSnapshot(NOW), () => NOW);
  const terminals = new InMemoryTerminalsGateway(() => NOW);
  const { engine, screens } = fakeEngine();
  const user = userEvent.setup();
  const view = render(
    <App gateway={gateway} terminals={terminals} loadTerminalEngine={async () => engine} />,
  );
  return { gateway, terminals, screens, user, view };
}

async function routeRow(name: string): Promise<HTMLElement> {
  const list = await screen.findByRole("list", { name: "Routes" });
  const row = within(list)
    .getAllByRole("listitem")
    .find((item) => item.querySelector("a")?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** Makes the window wide enough for the right pane and the list inside it. */
function wideWindow() {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    ...original(query),
    matches: query === "(min-width: 1100px)",
  }));
}

const panel = () => screen.findByRole("region", { name: "Terminals" });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => vi.restoreAllMocks());

describe("terminal panel", () => {
  it("opens a shell in a row's folder from the row menu and shows its output", async () => {
    const { terminals, screens } = setup();
    fireEvent.contextMenu(await routeRow("storybook"), { clientX: 40, clientY: 60 });
    const menu = await screen.findByRole("menu", { name: /Actions for/ });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open terminal" }));

    const terminalsPanel = await panel();
    expect(terminals.created).toEqual([{ cwd: FALCON }]);
    expect(within(terminalsPanel).getByRole("tab", { name: "shell" })).toBeTruthy();
    await waitFor(() => expect(screens[0]?.written.join("")).toContain("$ "));
    act(() => terminals.write("t1", "hello\r\n"));
    expect(screens[0]?.written.join("")).toContain("hello");
  });

  it("opens the running terminal of a folder again instead of a new one", async () => {
    const { terminals, user } = setup();
    await terminals.create({ cwd: FALCON, command: "pnpm dev" });
    const row = await routeRow("storybook");
    await user.click(row);
    await user.keyboard("t");
    const terminalsPanel = await panel();
    expect(terminals.created).toHaveLength(1);
    expect(
      within(terminalsPanel).getByRole("tab", { name: "pnpm dev" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("sends what is typed to the command", async () => {
    const { terminals, screens } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "node repl.js" }));
    fireEvent.click(screen.getByRole("button", { name: /Show terminals/ }));
    await waitFor(() => expect(screens).toHaveLength(1));
    act(() => screens[0]?.type("1+1\r"));
    await waitFor(() => expect(terminals.inputs).toEqual([{ id: "t1", text: "1+1\r" }]));
  });

  it("stops and restarts the command and shows the exit code", async () => {
    const { terminals, user } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    expect(within(terminalsPanel).getByText("Running")).toBeTruthy();
    await user.click(within(terminalsPanel).getByRole("button", { name: "Stop" }));
    expect(await within(terminalsPanel).findByText("Exited with code 130")).toBeTruthy();
    await user.click(within(terminalsPanel).getByRole("button", { name: "Run again" }));
    expect(await within(terminalsPanel).findByText("Running")).toBeTruthy();
  });

  it("starts a command in a project folder from New terminal", async () => {
    const { terminals, user } = setup();
    await user.click(await screen.findByRole("button", { name: /Show terminals/ }));
    const form = await screen.findByRole("form", { name: "New terminal" });
    await user.selectOptions(within(form).getByLabelText("Project folder"), FALCON);
    await user.type(within(form).getByLabelText("Command"), "pnpm test");
    await user.click(within(form).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(terminals.created).toEqual([{ cwd: FALCON, command: "pnpm test" }]));
    expect(await within(await panel()).findByRole("tab", { name: "pnpm test" })).toBeTruthy();
  });

  it("groups tabs by project and closes them", async () => {
    const { terminals, user } = setup();
    await act(async () => {
      await terminals.create({ cwd: FALCON, command: "pnpm dev", project: "acme" });
      await terminals.create({ cwd: "/home/dev/code/shop", command: "pnpm dev", project: "shop" });
    });
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    expect(within(terminalsPanel).getByRole("group", { name: "acme" })).toBeTruthy();
    expect(within(terminalsPanel).getByRole("group", { name: "shop" })).toBeTruthy();
    await user.click(
      within(terminalsPanel).getAllByRole("button", { name: "Close pnpm dev" })[0] as HTMLElement,
    );
    await waitFor(() => expect(within(terminalsPanel).getAllByRole("tab")).toHaveLength(1));
  });

  it("remembers its dock and size", async () => {
    wideWindow();
    const { user, view } = setup();
    await user.click(await screen.findByRole("button", { name: /Show terminals/ }));
    // A wide window starts with the pane on the right of the list.
    expect((await panel()).getAttribute("data-dock")).toBe("right");
    await user.click(screen.getByRole("button", { name: "Terminal at the bottom" }));
    const handle = await screen.findByRole("separator", { name: "Resize the terminal panel" });
    handle.focus();
    await user.keyboard("{ArrowUp}");
    view.unmount();
    setup();
    const again = await panel();
    expect(again.getAttribute("data-dock")).toBe("bottom");
    expect(again.style.getPropertyValue("--panel-size")).toBe("344px");
  });
});

describe("new terminal picker", () => {
  it("opens a shell in any known project folder with Ctrl+`", async () => {
    const { terminals, user } = setup();
    await screen.findByRole("list", { name: "Routes" });
    await user.keyboard("{Control>}`{/Control}");
    const picker = await screen.findByRole("dialog", { name: "New terminal" });
    const falcon = within(picker).getByRole("option", { name: /acme-monorepo \/ falcon/ });
    expect(falcon.textContent).toContain("fix/dark-mode");
    expect(falcon.textContent).toContain("~/code/acme-falcon");
    await user.type(within(picker).getByRole("combobox"), "falcon");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(terminals.created).toEqual([{ cwd: FALCON }]));
    expect(screen.queryByRole("dialog", { name: "New terminal" })).toBeNull();
    expect(await within(await panel()).findByRole("tab", { name: "shell" })).toBeTruthy();
  });

  it("opens a shell in a folder typed by hand, and says when it is not a folder", async () => {
    const { terminals, user } = setup();
    terminals.folderExists = (path) => path !== "/nope";
    await screen.findByRole("list", { name: "Routes" });
    await user.keyboard("{Control>}`{/Control}");
    await user.click(await screen.findByRole("option", { name: /Other folder/ }));
    const dialog = await screen.findByRole("dialog", { name: "Open a shell in any folder" });
    const field = within(dialog).getByLabelText("Folder");
    await user.type(field, "/nope{Enter}");
    expect(await within(dialog).findByText("/nope is not a folder on this machine.")).toBeTruthy();
    await user.clear(field);
    await user.type(field, "~/scratch{Enter}");
    await waitFor(() => expect(terminals.picked).toEqual([{ cwd: "/nope" }, { cwd: "~/scratch" }]));
    expect(terminals.created).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(await panel()).findByRole("tab", { name: "shell" })).toBeTruthy();
  });

  it("opens from the panel's New terminal button and from the command menu", async () => {
    const { terminals, user } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    await user.click(within(await panel()).getByRole("button", { name: "New terminal" }));
    expect(await screen.findByRole("dialog", { name: "New terminal" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByRole("option", { name: /New terminal/ }));
    expect(await screen.findByRole("dialog", { name: "New terminal" })).toBeTruthy();
  });
});

describe("terminal names and groups", () => {
  it("renames a tab by double-clicking it, and the active one with F2", async () => {
    const { terminals, user } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    await user.dblClick(within(terminalsPanel).getByRole("tab", { name: "pnpm dev" }));
    const field = within(terminalsPanel).getByRole("textbox", { name: "Rename pnpm dev" });
    await user.clear(field);
    await user.type(field, "web server{Enter}");
    expect(await within(terminalsPanel).findByRole("tab", { name: "web server" })).toBeTruthy();

    within(terminalsPanel).getByRole("tab", { name: "web server" }).focus();
    await user.keyboard("{F2}");
    const again = within(terminalsPanel).getByRole("textbox", { name: "Rename web server" });
    await user.clear(again);
    await user.type(again, "api{Escape}");
    expect(within(terminalsPanel).getByRole("tab", { name: "web server" })).toBeTruthy();

    // Clicking away keeps what was typed.
    await user.click(within(terminalsPanel).getByRole("button", { name: "Rename" }));
    await user.type(
      within(terminalsPanel).getByRole("textbox", { name: "Rename web server" }),
      " 2",
    );
    await user.click(within(terminalsPanel).getByText("Running"));
    expect(await within(terminalsPanel).findByRole("tab", { name: "web server 2" })).toBeTruthy();
  });

  it("groups tabs by project and worktree, with the branch", async () => {
    const { terminals, user } = setup();
    await act(async () => {
      await terminals.create({ cwd: FALCON, command: "pnpm dev" });
      await terminals.create({ cwd: "/home/dev/code/acme", command: "pnpm test" });
      await terminals.create({ cwd: "/tmp/scratch" });
      terminals.update("t1", {
        project: "acme-monorepo",
        worktree: "falcon",
        branch: "fix/dark-mode",
      });
      terminals.update("t2", { project: "acme-monorepo", worktree: null, branch: "main" });
      terminals.update("t3", { project: null });
    });
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const groups = within(await panel()).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "acme-monorepo / falcon",
      "acme-monorepo",
      "scratch",
    ]);
    expect(groups[0]?.textContent).toContain("fix/dark-mode");
  });

  it("shows the URLs of the ports its processes opened", async () => {
    const { terminals, user } = setup();
    await act(async () => {
      await terminals.create({ cwd: FALCON });
      terminals.update("t1", {
        ports: [
          { port: 6006, route: "storybook", url: "http://storybook.localhost:1355" },
          { port: 4321, route: null, url: null },
        ],
      });
    });
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const ports = within(await panel()).getByLabelText("Ports it opened");
    const links = within(ports)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(links).toEqual([
      "http://storybook.localhost:1355",
      "http://localhost:6006",
      "http://localhost:4321",
    ]);
  });
});

describe("terminal button on rows", () => {
  it("shows the terminal whose processes serve the row, else opens a shell in its folder", async () => {
    const { terminals, user } = setup();
    await act(async () => {
      await terminals.create({ cwd: "/home/dev/elsewhere", command: "pnpm storybook" });
      terminals.update("t1", { ports: [{ port: 6006, route: "storybook", url: null }] });
    });
    const row = await routeRow("storybook");
    expect(
      within(row).getByRole("button", { name: /Terminal of storybook: running/ }),
    ).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "Logs of storybook" }));
    expect(
      within(await panel())
        .getByRole("tab", { name: "pnpm storybook" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(terminals.created).toHaveLength(1);

    const detected = (await screen.findByRole("list", { name: "Detected ports" })).querySelector(
      '[data-port="4209"]',
    ) as HTMLElement;
    await user.click(
      within(detected).getByRole("button", { name: "Open a terminal for port 4209" }),
    );
    await waitFor(() =>
      expect(terminals.created.at(-1)).toEqual({ cwd: "/home/dev/code/shop-admin/otter" }),
    );
    expect(
      within(await routeRow("db")).queryByRole("button", { name: /Open a terminal/ }),
    ).toBeNull();
  });
});

describe("focus requests", () => {
  it("shows the terminal a request names and tells Studio whether the window came forward", async () => {
    const { gateway, terminals } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await screen.findByRole("list", { name: "Routes" });
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => gateway.focus({ id: "f1", target: { terminal: "t1" } }));
    const terminalsPanel = await panel();
    expect(within(terminalsPanel).getByRole("tab", { name: "pnpm dev" })).toBeTruthy();
    expect(focus).toHaveBeenCalled();
    await waitFor(() => expect(gateway.focusAcks).toEqual([{ id: "f1", focused: true }]));
  });

  it("selects the route a request names", async () => {
    const { gateway } = setup();
    await screen.findByRole("list", { name: "Routes" });
    vi.spyOn(window, "focus").mockImplementation(() => {});
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => gateway.focus({ id: "f2", target: { route: "storybook" } }));
    await waitFor(async () =>
      expect((await routeRow("storybook")).getAttribute("aria-current")).toBe("true"),
    );
    await waitFor(() => expect(gateway.focusAcks).toEqual([{ id: "f2", focused: false }]));
  });

  it("opens the terminal named in the link Studio opened", async () => {
    window.history.replaceState(null, "", "/?terminal=t1");
    const gateway = new InMemoryRoutesGateway(createSampleSnapshot(NOW), () => NOW);
    const terminals = new InMemoryTerminalsGateway(() => NOW);
    await terminals.create({ cwd: FALCON, command: "pnpm dev" });
    render(
      <App
        gateway={gateway}
        terminals={terminals}
        loadTerminalEngine={async () => fakeEngine().engine}
      />,
    );
    const terminalsPanel = await panel();
    expect(within(terminalsPanel).getByRole("tab", { name: "pnpm dev" })).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("waits for a terminal the list does not show yet instead of switching away", async () => {
    window.history.replaceState(null, "", "/?terminal=t2");
    const gateway = new InMemoryRoutesGateway(createSampleSnapshot(NOW), () => NOW);
    const terminals = new InMemoryTerminalsGateway(() => NOW);
    await terminals.create({ cwd: FALCON, command: "pnpm dev" });
    render(
      <App
        gateway={gateway}
        terminals={terminals}
        loadTerminalEngine={async () => fakeEngine().engine}
      />,
    );
    const terminalsPanel = await panel();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm test" }));
    await waitFor(() =>
      expect(
        within(terminalsPanel)
          .getByRole("tab", { name: "pnpm test" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });
});

describe("terminal list", () => {
  async function threeTerminals(terminals: InMemoryTerminalsGateway) {
    await act(async () => {
      await terminals.create({ cwd: FALCON, command: "pnpm dev", title: "web" });
      await terminals.create({ cwd: FALCON, command: "pnpm test" });
      await terminals.create({ cwd: "/home/dev/code/acme", command: "pnpm api" });
      terminals.update("t1", {
        project: "acme-monorepo",
        worktree: "falcon",
        branch: "fix/dark-mode",
        ports: [{ port: 6006, route: "storybook", url: null }],
      });
      terminals.update("t2", { project: "acme-monorepo", worktree: "falcon" });
    });
  }

  it("lists several terminals by worktree with their command and ports, and switches", async () => {
    const { terminals, user } = setup();
    await threeTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    const list = within(terminalsPanel).getByRole("tablist", { name: "Open terminals" });
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    const falcon = within(list).getByRole("group", { name: "acme-monorepo / falcon" });
    expect(falcon.textContent).toContain("fix/dark-mode");
    expect(falcon.textContent).toContain("pnpm dev");
    expect(within(falcon).getByRole("link", { name: "storybook" }).getAttribute("href")).toBe(
      "http://localhost:6006",
    );
    await user.click(within(list).getByRole("tab", { name: "web" }));
    expect(within(list).getByRole("tab", { name: "web" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(within(terminalsPanel).queryByLabelText("Filter terminals")).toBeNull();
  });

  it("switches with Ctrl+PageDown and Ctrl+PageUp and closes with Ctrl+Shift+W", async () => {
    const { terminals, user } = setup();
    await threeTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const list = within(await panel()).getByRole("tablist", { name: "Open terminals" });
    const selected = () =>
      within(list)
        .getAllByRole("tab")
        .find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.getAttribute("aria-label");
    within(list).getByRole("tab", { name: "web" }).focus();
    await user.click(within(list).getByRole("tab", { name: "web" }));
    await user.keyboard("{Control>}{PageDown}{/Control}");
    expect(selected()).toBe("pnpm test");
    await user.keyboard("{Control>}{PageUp}{PageUp}{/Control}");
    expect(selected()).toBe("pnpm api");
    await user.keyboard("{Control>}{Shift>}W{/Shift}{/Control}");
    await waitFor(async () =>
      expect(within(await panel()).queryByRole("tab", { name: "pnpm api" })).toBeNull(),
    );
    expect(within(await panel()).getAllByRole("tab")).toHaveLength(2);
  });

  it("filters the list once there are more than eight terminals", async () => {
    const { terminals, user } = setup();
    await act(async () => {
      for (let index = 1; index <= 9; index += 1) {
        await terminals.create({ cwd: FALCON, command: `job ${index}` });
      }
    });
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    await user.type(within(terminalsPanel).getByLabelText("Filter terminals"), "job 7");
    expect(
      within(terminalsPanel)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label")),
    ).toEqual(["job 7"]);
  });

  it("collapses the list into a dropdown, and remembers it", async () => {
    const { terminals, user, view } = setup();
    await threeTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    await user.click(within(await panel()).getByRole("button", { name: "Hide the terminal list" }));
    const dropdown = within(await panel()).getByRole("combobox", { name: "Terminal" });
    await user.selectOptions(dropdown, "t1");
    expect((dropdown as HTMLSelectElement).value).toBe("t1");
    view.unmount();
    const again = setup();
    await threeTerminals(again.terminals);
    expect(within(await panel()).getByRole("combobox", { name: "Terminal" })).toBeTruthy();
  });

  it("shows a dropdown instead of the list on a narrow screen", async () => {
    const original = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      ...original(query),
      matches: query === "(max-width: 640px)",
    }));
    const { terminals, user } = setup();
    await threeTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    expect(within(terminalsPanel).queryByRole("tablist")).toBeNull();
    expect(within(terminalsPanel).getByRole("combobox", { name: "Terminal" })).toBeTruthy();
  });
});

describe("terminals stopped by a Studio restart", () => {
  it("says so and runs them all again", async () => {
    const { terminals, user } = setup();
    act(() => {
      terminals.addStopped({ cwd: FALCON, command: "pnpm dev" });
      terminals.addStopped({ cwd: FALCON, command: "pnpm worker" });
    });
    await user.click(screen.getByRole("button", { name: /stopped by a Studio restart/ }));
    const terminalsPanel = await panel();
    expect(within(terminalsPanel).getByText("Stopped by a Studio restart")).toBeTruthy();
    expect(
      within(terminalsPanel).getByText("2 terminals were stopped by a Studio restart."),
    ).toBeTruthy();
    await user.click(within(terminalsPanel).getByRole("button", { name: "Run all again" }));
    await waitFor(() =>
      expect(within(terminalsPanel).queryByText(/stopped by a Studio restart/)).toBeNull(),
    );
    expect(within(terminalsPanel).getByText("Running")).toBeTruthy();
  });
});

describe("auto-scroll", () => {
  it("says what it does and turns on and off", async () => {
    const { terminals, user } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const toggle = within(await panel()).getByRole("button", { name: "Auto-scroll" });
    expect(toggle.getAttribute("title")).toBe(
      "Keep the view at the newest output; scrolling up pauses it",
    );
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("recent commands", () => {
  it("offers the last commands of each folder in New terminal", async () => {
    const { terminals, user } = setup();
    terminals.recent = { [FALCON]: ["pnpm storybook"] };
    await screen.findByRole("list", { name: "Routes" });
    await user.keyboard("{Control>}`{/Control}");
    const picker = await screen.findByRole("dialog", { name: "New terminal" });
    await user.click(within(picker).getByRole("option", { name: /pnpm storybook/ }));
    await waitFor(() =>
      expect(terminals.created).toEqual([{ cwd: FALCON, command: "pnpm storybook" }]),
    );
  });

  it("suggests them for the chosen folder in the panel's form", async () => {
    const { terminals, user } = setup();
    terminals.recent = { [FALCON]: ["pnpm test"] };
    await user.click(await screen.findByRole("button", { name: /Show terminals/ }));
    const form = await screen.findByRole("form", { name: "New terminal" });
    await user.selectOptions(within(form).getByLabelText("Project folder"), FALCON);
    const recent = await within(form).findByRole("group", { name: "Recent commands" });
    await user.click(within(recent).getByRole("button", { name: "pnpm test" }));
    await waitFor(() => expect(terminals.created).toEqual([{ cwd: FALCON, command: "pnpm test" }]));
  });
});

describe("terminals on rows", () => {
  it("shows the status of a row's terminal and stops it or runs it again from the row", async () => {
    const { terminals, user } = setup();
    await act(async () => {
      await terminals.create({ cwd: FALCON, command: "pnpm storybook" });
      terminals.update("t1", { ports: [{ port: 6006, route: "storybook", url: null }] });
    });
    const row = await routeRow("storybook");
    await user.click(within(row).getByRole("button", { name: "Stop the terminal of storybook" }));
    expect(
      await within(await routeRow("storybook")).findByRole("button", {
        name: /Terminal of storybook: exited 130/,
      }),
    ).toBeTruthy();
    await user.click(
      within(await routeRow("storybook")).getByRole("button", {
        name: "Run the terminal of storybook again",
      }),
    );
    expect(
      await within(await routeRow("storybook")).findByRole("button", {
        name: /Terminal of storybook: running/,
      }),
    ).toBeTruthy();
  });
});

describe("right pane", () => {
  it("shows the terminal of the selected row and moves to the bottom from the command menu", async () => {
    wideWindow();
    const { terminals, user } = setup();
    await act(async () => {
      await terminals.create({ cwd: FALCON, command: "pnpm storybook" });
      await terminals.create({ cwd: FALCON, command: "pnpm web" });
      terminals.update("t1", { ports: [{ port: 6006, route: "storybook", url: null }] });
      terminals.update("t2", { ports: [{ port: 3000, route: "web.acme", url: null }] });
    });
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    expect(terminalsPanel.getAttribute("data-dock")).toBe("right");
    await user.click(await routeRow("storybook"));
    await waitFor(() =>
      expect(
        within(terminalsPanel)
          .getByRole("tab", { name: "pnpm storybook" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByRole("option", { name: /Terminal at the bottom/ }));
    await waitFor(async () => expect((await panel()).getAttribute("data-dock")).toBe("bottom"));
  });
});

describe("terminal look", () => {
  it("applies the font size saved in Settings to the open terminal at once", async () => {
    const { terminals, screens, user } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    await waitFor(() => expect(screens).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const size = await within(dialog).findByLabelText("Font size");
    await user.clear(size);
    await user.type(size, "16");
    expect(within(dialog).getByTestId("terminal-preview").style.fontSize).toBe("16px");
    await user.selectOptions(within(dialog).getByLabelText("Colors"), "dark");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screens[0]?.options.fontSize).toBe(16));
    expect(screens[0]?.disposed).toBe(false);
  });
});

describe("terminal workspace", () => {
  const MINUTE = 60_000;

  async function twoTerminals(terminals: InMemoryTerminalsGateway) {
    await act(async () => {
      await terminals.create({ cwd: FALCON, command: "pnpm dev", title: "web" });
      await terminals.create({ cwd: "/home/dev/code/acme", command: "pnpm api" });
      terminals.update("t1", {
        project: "acme-monorepo",
        worktree: "falcon",
        branch: "fix/dark-mode",
        startedAt: Date.now() - 5.5 * MINUTE,
        pid: 4321,
        ports: [{ port: 6006, route: "storybook", url: "http://storybook.localhost:1355" }],
      });
    });
  }

  it("lists even a single terminal, with no header tabs", async () => {
    const { terminals, user } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const list = within(await panel()).getByRole("tablist", { name: "Open terminals" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label")),
    ).toEqual(["pnpm dev"]);
  });

  it("shows status, command, folder, branch, ports and uptime on each card", async () => {
    const { terminals, user } = setup();
    await twoTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const list = within(await panel()).getByRole("tablist", { name: "Open terminals" });
    const card = list.querySelector('[data-terminal="t1"]') as HTMLElement;
    expect(card.textContent).toContain("running");
    expect(card.textContent).toContain("pnpm dev");
    expect(card.textContent).toContain("acme-monorepo / falcon");
    expect(card.textContent).toContain("fix/dark-mode");
    expect(card.textContent).toContain("5m");
    expect(within(card).getByRole("link", { name: "storybook" }).getAttribute("href")).toBe(
      "http://storybook.localhost:1355",
    );
    // The details shown on hover: the folder with ~, the PID.
    const details = within(card).getByTestId("terminal-details");
    expect(details.textContent).toContain("/home/dev/code/acme-falcon".replace("/home/dev", "~"));
    expect(details.textContent).toContain("4321");
  });

  it("stops, runs again and closes a terminal from its card", async () => {
    const { terminals, user } = setup();
    await twoTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    await user.click(within(terminalsPanel).getByRole("button", { name: "Stop web" }));
    await waitFor(() =>
      expect(terminalsPanel.querySelector('[data-terminal="t1"]')?.textContent).toContain(
        "exited 130",
      ),
    );
    await user.click(within(terminalsPanel).getByRole("button", { name: "Run web again" }));
    await waitFor(() =>
      expect(terminalsPanel.querySelector('[data-terminal="t1"]')?.textContent).toContain(
        "running",
      ),
    );
    await user.click(within(terminalsPanel).getByRole("button", { name: "Close web" }));
    await waitFor(() => expect(within(terminalsPanel).getAllByRole("tab")).toHaveLength(1));
  });

  it("opens a terminal's folder in the default editor from its card", async () => {
    const gateway = new InMemoryRoutesGateway(createSampleSnapshot(NOW), () => NOW);
    const terminals = new InMemoryTerminalsGateway(() => NOW);
    const { engine } = fakeEngine();
    const user = userEvent.setup();
    render(<App gateway={gateway} terminals={terminals} loadTerminalEngine={async () => engine} />);
    await twoTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    await user.click(
      await within(await panel()).findByRole("button", { name: "Open web in VS Code" }),
    );
    await waitFor(() => expect(gateway.openedWith).toEqual([{ appId: "vscode", path: FALCON }]));
  });

  it("moves between cards with the arrow keys and focuses the terminal with Enter", async () => {
    const { terminals, screens, user } = setup();
    await twoTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const list = within(await panel()).getByRole("tablist", { name: "Open terminals" });
    within(list).getByRole("tab", { name: "web" }).focus();
    await user.keyboard("{ArrowDown}");
    const api = within(list).getByRole("tab", { name: "pnpm api" });
    expect(api.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(api);
    await user.keyboard("{ArrowUp}");
    expect(within(list).getByRole("tab", { name: "web" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await waitFor(() => expect(screens.at(-1)?.written.length).toBeGreaterThan(0));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screens.at(-1)?.focused).toBe(1));
  });

  it("hides and shows the list with Ctrl+B from inside the terminal area only", async () => {
    const { terminals, screens, user } = setup();
    await twoTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const terminalsPanel = await panel();
    const xterm = await within(terminalsPanel).findByTestId("terminal-screen");
    // xterm.js leaves the key to the page.
    await waitFor(() => expect(screens).toHaveLength(1));
    const ctrlB = new KeyboardEvent("keydown", { key: "b", ctrlKey: true });
    expect(screens[0]?.keyHandler(ctrlB)).toBe(false);
    expect(screens[0]?.keyHandler(new KeyboardEvent("keydown", { key: "b" }))).toBe(true);

    fireEvent.keyDown(xterm, { key: "b", ctrlKey: true });
    expect(within(terminalsPanel).queryByRole("tablist")).toBeNull();
    expect(within(terminalsPanel).getByRole("combobox", { name: "Terminal" })).toBeTruthy();
    fireEvent.keyDown(xterm, { key: "b", ctrlKey: true });
    expect(within(terminalsPanel).getByRole("tablist", { name: "Open terminals" })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    expect(within(terminalsPanel).getByRole("tablist", { name: "Open terminals" })).toBeTruthy();
  });

  it("copies a selection on Ctrl+C instead of sending it to the shell", async () => {
    const { terminals, screens, user } = setup();
    await twoTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    await panel();
    await waitFor(() => expect(screens).toHaveLength(1));

    const ctrlC = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    expect(screens[0]?.keyHandler(ctrlC)).toBe(true);

    // biome-ignore lint/style/noNonNullAssertion: asserted present by the toHaveLength(1) check above.
    screens[0]!.selected = "selected output";
    expect(screens[0]?.keyHandler(ctrlC)).toBe(false);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("selected output"));
  });

  it("goes full screen with its button or Ctrl+Shift+F, keeps it on reload and leaves with Esc", async () => {
    const { terminals, user, view } = setup();
    await twoTerminals(terminals);
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    let terminalsPanel = await panel();
    await user.click(within(terminalsPanel).getByRole("tab", { name: "web" }));
    await user.click(within(terminalsPanel).getByRole("button", { name: "Full screen" }));
    expect(terminalsPanel.hasAttribute("data-full-screen")).toBe(true);
    const details = within(terminalsPanel).getByRole("list", { name: "Terminal details" });
    expect(details.textContent).toContain("4321");
    expect(details.textContent).toContain("a person on the page");
    expect(details.textContent).toContain("~/code/acme-falcon");

    view.unmount();
    const again = setup();
    await twoTerminals(again.terminals);
    terminalsPanel = await panel();
    expect(terminalsPanel.hasAttribute("data-full-screen")).toBe(true);
    within(terminalsPanel).getAllByRole("tab")[0]?.focus();
    await again.user.keyboard("{Escape}");
    expect(terminalsPanel.hasAttribute("data-full-screen")).toBe(false);
    fireEvent.keyDown(within(terminalsPanel).getByTestId("terminal-screen"), {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(terminalsPanel.hasAttribute("data-full-screen")).toBe(true);
  });

  it("keeps the right pane between its limits and resets it with a double-click", async () => {
    wideWindow();
    const { terminals, user } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await user.click(screen.getByRole("button", { name: /Show terminals/ }));
    const handle = await screen.findByRole("separator", { name: "Resize the terminal panel" });
    expect(handle.getAttribute("aria-valuemin")).toBe("360");
    expect(handle.getAttribute("aria-valuemax")).toBe("720");
    handle.focus();
    await user.keyboard("{End}");
    expect(handle.getAttribute("aria-valuenow")).toBe("720");
    await user.keyboard("{ArrowLeft}");
    expect(handle.getAttribute("aria-valuenow")).toBe("720");
    await user.keyboard("{Home}");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    await user.dblClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("560");
  });

  it("lists the terminal keys in the shortcuts sheet and the command menu", async () => {
    const { terminals, user } = setup();
    await act(() => terminals.create({ cwd: FALCON, command: "pnpm dev" }));
    await screen.findByRole("list", { name: "Routes" });
    await user.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(sheet.textContent).toContain("Toggle terminal list");
    expect(sheet.textContent).toContain("Full screen terminal");
    await user.keyboard("{Escape}");
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByRole("option", { name: /Toggle terminal list/ }));
    const list = within(await panel());
    expect(list.queryByRole("tablist")).toBeNull();
  });
});
