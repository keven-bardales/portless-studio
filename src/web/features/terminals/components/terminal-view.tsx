import { useEffect, useRef, useState } from "react";
import type { TerminalAppearance } from "../../../../core/config/studio-config.ts";
import { copyText } from "../../../shared/lib/clipboard.ts";
import { Icon } from "../../../shared/ui/icons/icon.tsx";
import { isCopyShortcut } from "../hooks/copy-shortcut.ts";
import { cssVar, terminalTheme } from "../hooks/terminal-theme.ts";
import type { TerminalEngine } from "../hooks/xterm-loader.ts";
import styles from "./terminal-view.module.css";

type TerminalViewProps = {
  /** Output written with bare `\n` (pipes mode) needs it turned into a new line. */
  convertEol: boolean;
  /**
   * Keep the view at the newest output. Scrolling up pauses it until the view is back at the
   * bottom; off, the view stays where it is.
   */
  autoScroll: boolean;
  /** Font, cursor, scrollback and colors; changes apply to the open terminal at once. */
  appearance: TerminalAppearance;
  /** Changes when the page theme changes, so the colors are read again. */
  themeKey: string;
  loadEngine: () => Promise<TerminalEngine>;
  /** Starts sending output to `write`; returns how to stop. */
  connect: (write: (text: string) => void) => () => void;
  onInput: (text: string) => void;
  /** Keys the page keeps: xterm.js leaves them alone so the panel can act on them. */
  reservedKey?: (event: KeyboardEvent) => boolean;
  /** Put the keyboard in the terminal as soon as it is ready, then call `onFocused`. */
  focusOnReady?: boolean;
  onFocused?: () => void;
};

type Screen = { apply(appearance: TerminalAppearance): void; jump(): void; focus(): void };

/**
 * One terminal drawn by xterm.js, loaded on first use. Mount it with a `key` per terminal so
 * switching tabs starts a fresh screen that replays the kept output. While the view is not at the
 * newest output, a Jump to latest button brings it back.
 */
export function TerminalView({
  convertEol,
  autoScroll,
  appearance,
  themeKey,
  loadEngine,
  connect,
  onInput,
  reservedKey,
  focusOnReady = false,
  onFocused,
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [behind, setBehind] = useState(false);
  const latest = useRef({ autoScroll, onInput, connect, appearance, reservedKey });
  latest.current = { autoScroll, onInput, connect, appearance, reservedKey };
  const screen = useRef<Screen | null>(null);
  /** The person scrolled up: auto-scroll waits until the view is at the bottom again. */
  const paused = useRef(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    loadEngine().then(
      (engine) => {
        const element = host.current;
        if (disposed || !element) return;
        const look = latest.current.appearance;
        const term = engine.createTerminal({
          convertEol,
          cursorBlink: look.cursorBlink,
          cursorStyle: look.cursorStyle,
          fontFamily: cssVar("--font-mono") || "monospace",
          fontSize: look.fontSize,
          lineHeight: look.lineHeight,
          scrollback: look.scrollback,
          theme: terminalTheme(look.theme),
        });
        const fit = engine.createFit();
        term.loadAddon(fit);
        term.open(element);
        const resize = () => {
          try {
            fit.fit();
          } catch {
            // A hidden panel has no size to fit.
          }
        };
        resize();
        const atBottom = () => {
          const buffer = term.buffer.active;
          return buffer.viewportY >= buffer.baseY;
        };
        const settle = () => {
          paused.current = !atBottom();
          setBehind(paused.current);
        };
        const scrolled = term.onScroll(settle);
        // Wheel and touch scrolling may land after xterm's own scroll event.
        const settleSoon = () => requestAnimationFrame(settle);
        element.addEventListener("wheel", settleSoon, { passive: true });
        element.addEventListener("touchend", settleSoon, { passive: true });
        const typed = term.onData((text) => latest.current.onInput(text));
        term.attachCustomKeyEventHandler((event) => {
          if (event.type === "keydown" && term.hasSelection() && isCopyShortcut(event)) {
            void copyText(term.getSelection());
            return false;
          }
          return !latest.current.reservedKey?.(event);
        });
        const stop = latest.current.connect((text) => {
          const follow = latest.current.autoScroll && !paused.current;
          const held = term.buffer.active.viewportY;
          term.write(text, () => {
            if (follow) term.scrollToBottom();
            else if (term.buffer.active.viewportY !== held) term.scrollToLine(held);
            settle();
          });
        });
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
        observer?.observe(element);
        screen.current = {
          apply: (next) => {
            term.options.fontSize = next.fontSize;
            term.options.lineHeight = next.lineHeight;
            term.options.cursorStyle = next.cursorStyle;
            term.options.cursorBlink = next.cursorBlink;
            term.options.scrollback = next.scrollback;
            term.options.theme = terminalTheme(next.theme);
            resize();
          },
          jump: () => {
            term.scrollToBottom();
            paused.current = false;
            setBehind(false);
          },
          focus: () => term.focus(),
        };
        setState("ready");
        cleanup = () => {
          observer?.disconnect();
          element.removeEventListener("wheel", settleSoon);
          element.removeEventListener("touchend", settleSoon);
          stop();
          scrolled.dispose();
          typed.dispose();
          term.dispose();
          screen.current = null;
        };
      },
      () => {
        if (!disposed) setState("failed");
      },
    );
    return () => {
      disposed = true;
      cleanup();
    };
  }, [convertEol, loadEngine]);

  const appearanceKey = JSON.stringify(appearance);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key says when the look or the page colors changed.
  useEffect(() => {
    screen.current?.apply(latest.current.appearance);
  }, [appearanceKey, themeKey]);

  useEffect(() => {
    if (!focusOnReady || state !== "ready") return;
    screen.current?.focus();
    onFocused?.();
  }, [focusOnReady, state, onFocused]);

  // Turning auto-scroll on shows the newest output right away.
  useEffect(() => {
    if (autoScroll) screen.current?.jump();
  }, [autoScroll]);

  return (
    <div className={styles.view} data-theme={appearance.theme}>
      {state === "loading" ? <p className={styles.message}>Loading the terminal…</p> : null}
      {state === "failed" ? (
        <p className={styles.message}>The terminal could not load. Reload the page to try again.</p>
      ) : null}
      <div
        ref={host}
        className={styles.screen}
        data-testid="terminal-screen"
        data-terminal-screen=""
      />
      {behind && state === "ready" ? (
        <button type="button" className={styles.jump} onClick={() => screen.current?.jump()}>
          <Icon name="arrowDown" size={12} />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
