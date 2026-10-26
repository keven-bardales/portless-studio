import { isApplePlatform } from "../../../shared/lib/keyboard.ts";

/**
 * Ctrl+C (Cmd+C on macOS) with no selection: xterm.js sends it to the shell as the interrupt
 * byte, matching every native terminal. With a selection, people expect the browser-wide copy
 * shortcut instead, so the caller intercepts it before xterm turns it into input.
 */
export function isCopyShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "c" || event.altKey || event.shiftKey) return false;
  return isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
