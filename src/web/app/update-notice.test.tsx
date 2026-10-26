import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UpdateStatus } from "../../core/api/contract.ts";
import type { RoutesGateway } from "../features/routes/data/routes-gateway.ts";
import { createSampleSnapshot, InMemoryRoutesGateway } from "../features/routes/index.ts";
import { App } from "./app.tsx";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

function status(latest: string, available = true): UpdateStatus {
  return { current: "0.1.0", latest, available, command: "npm i -g portless-studio" };
}

function setup(update: UpdateStatus, overrides: Partial<RoutesGateway> = {}) {
  const gateway = Object.assign(new InMemoryRoutesGateway(createSampleSnapshot(NOW), () => NOW), {
    getUpdateStatus: async () => ({ ok: true as const, value: update }),
    ...overrides,
  });
  const user = userEvent.setup();
  const view = render(<App gateway={gateway} />);
  return { user, view };
}

beforeEach(() => localStorage.clear());

describe("update notice", () => {
  it("names the new version and the command to install it", async () => {
    setup(status("0.2.0"));
    expect(await screen.findByText("portless-studio 0.2.0 is available")).toBeTruthy();
    expect(screen.getByText("npm i -g portless-studio")).toBeTruthy();
  });

  it("stays hidden once dismissed, until a newer version comes out", async () => {
    const first = setup(status("0.2.0"));
    await first.user.click(
      await screen.findByRole("button", { name: "Dismiss the update notice" }),
    );
    expect(screen.queryByText("portless-studio 0.2.0 is available")).toBeNull();
    first.view.unmount();

    const again = setup(status("0.2.0"));
    await screen.findByRole("list", { name: "Routes" });
    expect(screen.queryByText("portless-studio 0.2.0 is available")).toBeNull();
    again.view.unmount();

    setup(status("0.3.0"));
    expect(await screen.findByText("portless-studio 0.3.0 is available")).toBeTruthy();
  });

  it("shows nothing when Studio runs the latest version", async () => {
    setup(status("0.1.0", false));
    await screen.findByRole("list", { name: "Routes" });
    await waitFor(() => expect(screen.queryByText(/is available/)).toBeNull());
  });
});

describe("update notice: Update now", () => {
  it("disables Update now and shows progress while it installs", async () => {
    let finish!: () => void;
    const { user } = setup(status("0.2.0"), {
      installUpdate: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, value: { version: "0.2.0", output: "" } });
        }),
    });
    await user.click(await screen.findByRole("button", { name: "Update now" }));
    expect(await screen.findByRole("button", { name: "Installing…" })).toHaveProperty(
      "disabled",
      true,
    );
    await screen.findByText("Running npm i -g portless-studio. This can take a minute.");
    finish();
    expect(await screen.findByText("Updated to 0.2.0. Restart Studio to use it.")).toBeTruthy();
  });

  it("offers a restart once the update finishes", async () => {
    const { user } = setup(status("0.2.0"), {
      installUpdate: async () => ({
        ok: true as const,
        value: { version: "0.2.0", output: "added 1 package" },
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Update now" }));
    expect(await screen.findByText("Updated to 0.2.0. Restart Studio to use it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I'll restart later" })).toBeTruthy();
  });

  it("restarts Studio when Restart now is clicked", async () => {
    const { user } = setup(status("0.2.0"), {
      installUpdate: async () => ({ ok: true as const, value: { version: "0.2.0", output: "" } }),
    });
    await user.click(await screen.findByRole("button", { name: "Update now" }));
    await user.click(await screen.findByRole("button", { name: "Restart now" }));
    expect(await screen.findByText(/Studio is restarting\./)).toBeTruthy();
  });

  it("shows the npm output and keeps the command to copy when the install fails", async () => {
    const { user } = setup(status("0.2.0"), {
      installUpdate: async () => ({
        ok: false as const,
        error: { error: "install_failed" as const, message: "npm exited with code 243." },
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Update now" }));
    expect(await screen.findByText("The update failed.")).toBeTruthy();
    expect(screen.getByText("npm exited with code 243.")).toBeTruthy();
    expect(screen.getByText("npm i -g portless-studio")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
  });

  it("shows only the command to copy when the server cannot install updates", async () => {
    setup(status("0.2.0"));
    await screen.findByText("portless-studio 0.2.0 is available");
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    expect(screen.getByText("npm i -g portless-studio")).toBeTruthy();
  });
});
