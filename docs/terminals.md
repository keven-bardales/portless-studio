# Terminals

Studio can run commands for you, one terminal per command, each in a project folder. Their
output shows live in a panel at the bottom or side of the dashboard, or full screen, and you, the CLI and your
AI agents all see and drive the same terminals. The usual case: an agent starts your dev server
with `portless-studio run -- pnpm dev` instead of in its own hidden shell, so you can watch its
logs in Studio, and the port it opens gets a name right away.

## Starting a terminal

From the page:

- Right-click a row (or press `.`) and pick **Open terminal**, or select a row and press `t`.
  Studio shows the running terminal of that project folder, or opens a shell there.
- **New terminal** in the panel picks a project folder and a command. An empty command opens your
  shell.

From a shell, as a drop-in for the command you would run yourself:

```bash
portless-studio run -- pnpm dev
portless-studio run --name pr-87.web.myapp -- pnpm dev --port 3000
portless-studio run --cwd ~/code/myapp/apps/web -- "pnpm dev && pnpm test"
```

`run` asks the running Studio to start the command in the current folder (or `--cwd`), prints its
output in your terminal as it comes, and exits with the command's exit code. Ctrl+C stops the
command; a second Ctrl+C leaves at once. The first new port the command opens in that folder gets
a name: `--name`, or the name Studio suggests from the branch and the project (docs/naming.md).
When Studio is not running, `run` says so and exits with code 1.

Words after `--` are quoted for the shell where needed, so `run -- node "my app.js"` passes
`my app.js` as one argument. A single word is used as written, which keeps `&&` and pipes working.

From an agent, through the MCP tools `run_in_terminal`, `list_terminals`, `read_terminal`,
`send_to_terminal`, `stop_terminal` and `restart_terminal` (docs/mcp.md).

## The panel

In a window 1100 px or wider the terminals open in a pane on the right of the routes list, which
makes room for it: select a row and its terminal shows there, the way an editor shows the file
you pick. Narrower windows dock the panel at the bottom. The layout button in the panel header,
or "Terminal at the bottom" and "Terminal on the right" in the command menu (`Ctrl+K`), move it.
The layout, the size at the bottom and on the right, and whether it is open are remembered in
this browser.

Drag the pane's inner edge (or the bottom panel's top edge) to resize it, or focus the edge and
use the arrow keys; `Home` and `End` jump to the smallest and largest size, and a double-click
goes back to the default. The size stays between limits taken from the window, so the page next
to the panel never breaks:

| Edge | Smallest | Largest |
| --- | --- | --- |
| Right pane | 360 px | the window minus 720 px, so the routes list keeps its kind, port and uptime columns |
| Bottom panel | 160 px | the window height minus 160 px |
| Terminal list | 200 px | 420 px, leaving the terminal at least 260 px |

The routes list and the page header size themselves by the room they have, not by the window:
next to a wide pane, the header shows icons instead of the Health and Name a port labels, and
the rows use their narrower layout only when the columns would not fit.

### The terminal list

The terminals show as a list of cards on the left of the panel, grouped by project and worktree,
even when there is only one. Each card shows:

- a status dot and the status in words: `running`, `exited 1` or `stopped by restart`;
- its title, the command in small mono type, and the project, worktree and branch;
- the ports it opened as chips (the route name, else `:3000`) that open the page;
- how long it has run.

Hovering or focusing a card shows its actions (Restart or Run again, Stop, Open in the default
editor, Copy the URL of its first port, Rename, Close) and one more line with its folder (`~`
for your home folder), when it started, its PID and its exit code. The selected card is
highlighted with an accent bar. Arrow keys move between cards and show each one; `Enter` puts
the keyboard in its terminal. Past eight terminals the list has a filter box.

The list button in the panel header, or `Ctrl+B` (`Cmd+B` on macOS) while the panel or the
terminal screen has focus, hides the list; a dropdown at the top then picks the terminal. Hidden
or shown is remembered. When the panel is too narrow for the list and a terminal side by side
(a right pane under 460 px), the dropdown takes its place on its own.

### Full screen

The Full screen button in the terminal header, `Ctrl+Shift+F` while the panel has focus, or "Full
screen terminal" in the command menu turn the panel into a workspace over the whole window: the
list on the left, the terminal on the right, with a line of details under the header (folder,
start time, PID and who started it: a person on the page, or the CLI or an agent through `run`
or MCP). Exit full screen, `Ctrl+Shift+F` again or `Esc` leave it. `Esc` inside the terminal
screen goes to the program running there, so press it from the list or the header. Full screen
works from the right pane and from the bottom panel, and a reload of the tab keeps it.

Up to 640 px wide (phones), terminals always show full screen, with the list as a dropdown at
the top, so the panel fits a 360 px screen.

### The terminal header

Above the screen, the active terminal shows its title (double-click or `F2` to rename), its
status, its command, its folder and branch, and the ports it opened, each with links to its route
and its direct URL and a copy button. Its actions are Rename, Stop, Restart (Run again once it
ended), Open in editor, Copy output (the kept output as plain text), Auto-scroll, Full screen and
Close the terminal. In a narrow panel the actions show only their icons.

While the panel has focus, `Ctrl+PageDown` and `Ctrl+PageUp` switch terminals and `Ctrl+Shift+W`
closes the active one (browsers may keep these keys for their own tabs; see
docs/keyboard-shortcuts.md).

Auto-scroll (on by default) keeps the view at the newest output. Scrolling up pauses it, so you
can read back through a busy log, and scrolling back to the bottom resumes it. While the view is
not at the newest output, a Jump to latest button shows at the bottom right of the screen. With
Auto-scroll off, the view stays where it is while output arrives.

## Terminals on rows

A route or detected port whose server runs in a Studio terminal shows the terminal's status next
to its name (`running`, `exited 1`, `stopped`); click it to see the output. Its row actions are
Logs (show the terminal), Stop while it runs and Run again once it ended. Rows with no terminal
keep the button that opens a shell in their folder. Studio links a port to a terminal through the
processes the terminal started (Linux and macOS), so on Windows rows show no terminal status.

## How the terminal looks

`terminal` in the config sets the font size, line height, cursor, scrollback and colors; Settings
has the same fields under Terminal, with a preview. Saving applies them to open terminals at once.
The `studio` colors follow the page's light or dark mode; `dark` and `light` stay fixed. Each has
the 16 ANSI colors, so programs that print in color look right on both. The fields and their
limits are in docs/configuration.md.

xterm.js draws the terminal. It loads the first time a terminal opens, in its own file, so the
dashboard itself stays small.

## How commands run

| System | How | What it means |
| --- | --- | --- |
| Linux | `script -q -f -e -c "<command>" /dev/null` (util-linux) | A real pseudo-terminal: colors, prompts, progress bars and Ctrl+C work as in your own terminal. |
| macOS | `script -q /dev/null /bin/sh -c "<command>"` (BSD `script`, which takes its arguments in a different order) | The same, best effort; not yet run on a real Mac. |
| Windows | `cmd.exe /d /s /c "<command>"` with plain pipes and `FORCE_COLOR=1` | Most tools still print colors. Programs that need a real console (full-screen UIs, some prompts) behave as when piped. |
| Linux without util-linux `script` (BusyBox, minimal containers) | `/bin/sh -c "<command>"` with pipes and `FORCE_COLOR=1` | As on Windows. |

No native module is involved, so Studio keeps zero runtime dependencies. Each command gets
`TERM=xterm-256color`, `COLUMNS` and `LINES` for the size of the panel that opened it (120 by 30
from the CLI and agents), and `PORTLESS_STUDIO_TERMINAL` with the terminal id. With a
pseudo-terminal, `stty` inside it sets that size first.

The size is set once, when the command starts. Resizing the panel later reflows what xterm.js
shows but does not tell the command: nothing outside a pseudo-terminal made by `script` can change
its size. A full-screen program keeps drawing for the size it started with; restart it to pick up
the new one.

Stop sends Ctrl+C (through the pseudo-terminal, or SIGINT to the command's process group with
pipes), then SIGTERM after 3 seconds and SIGKILL after 3 more while it keeps running. On Windows
every step stops the whole process tree with `taskkill /T /F`.

Each terminal keeps its last 2 MB of output in memory. Every character has a fixed number, so a
page or an agent can ask for only what came after the last part it read (`?from=<n>`), and learns
when older output was dropped. Studio keeps at most 32 terminals. Starting one past that closes the
terminals whose command already ended, the one that ended longest ago first, so a list full of
finished commands never stops you from running a new one. When all 32 are still running, Studio
refuses the new command and asks you to stop one.

Terminals belong to the Studio that runs them. When Studio stops, every command still running is
sent SIGTERM and SIGKILL. If Studio crashes instead of stopping, commands started in their own
process group may keep running.

## Restart and cancellation

Restart waits for the current command to exit before starting its replacement. Simultaneous
requests share one restart, so repeated clicks cannot start extra copies of the command.
Stop, Close, or Studio shutdown cancels a pending restart. If Close arrives while a replacement
is starting, Studio kills that replacement instead of leaving an untracked process running.
This behavior applies to both pseudo-terminal and pipe terminals.

## After a Studio restart

Studio writes `terminals.json` next to the config file with the terminals that run (command,
folder, title, when it started, and whether the CLI's `run` or an agent started it or a person on
the page did) and the last 20 commands run in each folder. It writes it a moment after each
change and once more when Studio stops, before it stops the commands. A command that ended up to
2 seconds before Studio stopped, without anyone asking it to stop, counts as running: a service
manager such as systemd stops Studio's commands together with Studio, and their ends can arrive
first.

On the next start, `restoreTerminals` decides what happens to them:

| Value | What Studio does |
| --- | --- |
| `"ask"` (default) | Lists them as "Stopped by a Studio restart", with their last title. The panel says how many there are, with Run all again, and each has Run again. |
| `"always"` | Runs their commands again right away, in their folders. Plain shells are listed as with `"ask"` and never start on their own. |
| `"never"` | Forgets them. |

Their old output is not kept. A folder that no longer exists is skipped. The New terminal picker
lists the recent commands of each folder, and the form the empty panel shows offers those of the
chosen folder; one click runs one. Agents see the stopped terminals in `list_terminals`
(`stopped_by_restart: true`) and run them again with `restart_terminal`.

Anyone who can write files in Studio's config folder can put commands in `terminals.json`, the
same as in a shell's startup file; with `"always"` Studio runs them as you on its next start.

## Security

A terminal runs any command as you, so every terminal endpoint needs Studio's per-run token,
reads included, because output and commands can hold secrets. Browsers only let Studio's own page
read the token (docs/architecture.md, Security), so another website open in the same browser can
neither start a command nor read output. Event streams carry the token in the query
(`?token=`), because the browser's EventSource cannot send headers.

Studio limits where commands run:

- **From the page**, only in a project folder of a route or detected port Studio shows or showed,
  or in a folder a local program already used.
- **From a local program** (the CLI, the MCP server), in any existing folder. Studio tells them
  apart by the headers browsers always send (`Origin` on every write, `Sec-Fetch-Site` on every
  request), which `node:http` does not send. A program on your machine that can read Studio's
  token can already run commands as you, so this adds no new power.

The risk to keep in mind: anyone who can run programs as you, or anything you let drive Studio
(such as an AI agent with the MCP server), can run commands through it. Studio listens on
`127.0.0.1` only.

## Bring Studio to the front

`portless-studio open [target]` and the MCP tool `focus_studio` show a route, a project (its first
route, else its first detected port), a terminal id or `port:<number>` in Studio and bring the
page to the front:

1. Studio sends a `focus` event to every open Studio page. The page shows the target (selects the
   row or shows the terminal) and calls `window.focus()`.
2. After 300 ms each page says whether it has the focus.
3. When no page is open, or none came forward within 1.5 seconds, Studio opens the page link
   (`/?focus=<route>`, `/?focus=port:<n>` or `/?terminal=<id>`) with the system browser opener
   (`xdg-open`, `open`, `start`). That brings the browser to the front on Linux, macOS and
   Windows, in a new tab.

Browsers decide whether a page may raise its own window: Chrome, Firefox and Safari usually
ignore `window.focus()` from a background tab, so the link in a new tab is the common outcome.
On Linux, some window managers show a "ready" notice instead of raising the browser.

## Opening terminals

- **New terminal** (`Ctrl+\``, the panel's button, or the command menu) lists every project and
  worktree folder Studio knows, with its branch and path, and you can search it. Pick one to open
  your login shell there, or pick **Other folder…** and type any existing folder (`~` is your home
  folder). While a terminal has focus, xterm may keep `Ctrl+\`` for itself; use the panel button.
- The terminal button on a row shows the terminal whose processes serve that row, else a terminal
  in its folder, else opens a shell there.
- A terminal with no command starts your login shell (`$SHELL -l`). On Windows it starts `pwsh` or
  Windows PowerShell, which shows no prompt over pipes, else `cmd.exe`.

## Names and groups

- List cards are grouped by project and worktree (`acme-monorepo / falcon`), and each card shows
  its branch. A folder Studio does not know is grouped under its own name.
- Double-click a card or the header title, press `F2`, or use Rename to name it. An empty name
  brings back the command or the shell's name.
- Cards and the header list the URLs of ports opened by processes started in that terminal. This
  works on Linux and macOS through parent processes; on Windows nothing is listed.

## Direct URLs

Every route and detected port shows its direct URL (`http://localhost:<port>`); click it to copy.
The row menu has Open direct URL and Copy direct URL, and the command menu has Copy direct URL of
the selected route.

## Folders the page can use

The page's **New terminal** picker can start a terminal in any existing folder you type
(`POST /api/terminals/in-folder`, which needs the token and refuses anything that is not a
folder). Every other page request runs only in folders Studio shows. The CLI and MCP can use any
existing folder, as before.
