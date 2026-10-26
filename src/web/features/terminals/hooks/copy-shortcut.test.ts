import { afterEach, describe, expect, it } from "vitest";
import { isCopyShortcut } from "./copy-shortcut.ts";

function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
}

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  });
}

describe("isCopyShortcut", () => {
  const originalPlatform = navigator.platform;
  afterEach(() => setPlatform(originalPlatform));

  it("matches Ctrl+C on Windows and Linux", () => {
    setPlatform("Win32");
    expect(isCopyShortcut(keyEvent({ key: "c", ctrlKey: true }))).toBe(true);
    setPlatform("Linux x86_64");
    expect(isCopyShortcut(keyEvent({ key: "c", ctrlKey: true }))).toBe(true);
  });

  it("does not match Cmd+C on Windows and Linux", () => {
    setPlatform("Win32");
    expect(isCopyShortcut(keyEvent({ key: "c", metaKey: true }))).toBe(false);
  });

  it("matches Cmd+C on macOS, not Ctrl+C", () => {
    setPlatform("MacIntel");
    expect(isCopyShortcut(keyEvent({ key: "c", metaKey: true }))).toBe(true);
    expect(isCopyShortcut(keyEvent({ key: "c", ctrlKey: true }))).toBe(false);
  });

  it("ignores Shift or Alt held with the copy shortcut", () => {
    setPlatform("Win32");
    expect(isCopyShortcut(keyEvent({ key: "c", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCopyShortcut(keyEvent({ key: "c", ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("ignores keys other than C", () => {
    setPlatform("Win32");
    expect(isCopyShortcut(keyEvent({ key: "v", ctrlKey: true }))).toBe(false);
  });
});
