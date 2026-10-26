# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.2.0 (2026-10-26)

- The update notice can now update Studio itself: Update now runs `npm i -g portless-studio` on
  the server and offers a restart once it finishes, instead of only showing the command to run by
  hand. The command stays as a fallback when the server cannot install updates, when the install
  fails, or for anyone who would rather run it themselves.

- Selecting text in a terminal and pressing `Ctrl+C` (`Cmd+C` on macOS) now copies it, instead of
  sending the interrupt signal to the shell. With no selection, `Ctrl+C` still sends the signal as
  before.

## 0.1.5 (2026-10-25)

- Simultaneous terminal restarts share one replacement. Stop, Close and Studio shutdown cancel
  pending restarts, including commands still starting. Stop all recognizes the installed npm
  and npx entry points on Linux, macOS and Windows.

- Stop checks that the server's TCP ports closed and refreshes health immediately. If a process
  is already listening again, the error identifies its PID instead of reporting success.
  Stop all in the confirmation stops the enclosing development command and its children,
  including package scripts on Windows. Ownership checks protect other users' processes,
  interactive shells, agents and Studio itself.

- The terminal panel always shows its terminals as a list of cards, even with one or two; the
  header tabs, which scrolled sideways once there were several, are gone. Each card shows the
  status in words (`running`, `exited 1`, `stopped by restart`), the title, the command, the
  project, worktree and branch, the ports it opened as chips that open them, and its uptime.
  Hover or focus shows Restart, Stop, Open in the default editor, Copy URL, Rename and Close, and
  one more line with the folder, start time, PID and exit code. Arrow keys move between cards and
  `Enter` goes into the terminal.

- `Ctrl+B` (`Cmd+B` on macOS) hides or shows the terminal list while the panel or the terminal
  screen has focus; xterm.js no longer receives that key there. A dropdown at the top picks the
  terminal while the list is hidden.

- Terminals can go full screen: the Full screen button in the terminal header, `Ctrl+Shift+F` in
  the panel or the command menu. Full screen covers the dashboard with the list on the left and
  the terminal on the right, adds a line with the folder, start time, PID and who started it, and
  survives a reload of the tab. `Esc` from the list or header leaves it. Up to 640 px wide,
  terminals always show full screen with the list as a dropdown.

- The terminal header shows the title, status, command, folder and branch, and each port with
  Open and Copy, plus Rename, Stop, Restart, Open in editor, Copy output, Auto-scroll, Full screen
  and Close. In a narrow panel the actions show only icons.

- Resizing has limits taken from the window: the right pane goes from 360 px to the window minus
  720 px, so the routes list keeps its columns; the bottom panel from 160 px to the window height
  minus 160 px; the list from 200 px to 420 px, leaving the terminal 260 px. `Home` and `End` on a
  focused edge jump to the limits and a double-click resets the size.

- The page header and the route rows size themselves by the room they have instead of the window
  width. Next to the terminal pane, the header shows icons instead of the Health and Name a port
  labels, which fixes "Live" and "Health" overlapping in a 1280 px window with the pane open.

- `?` and the command menu list the terminal keys under Terminal, including "Toggle terminal
  list" and "Full screen terminal".

## 0.1.4 (2026-10-25)

- Kind, port and uptime now line up in the same columns on every route row. Before, rows with
  more action buttons (a terminal's Logs and Stop, alias rename and remove) pushed those columns
  to the left. The actions area has a fixed width and wider action sets show over the columns
  while hovered; on phones the actions get their own line. Detected rows keep the port in a fixed
  column too.

- The uptime column counts from when the server's process started, not from when its name was
  given: `up 2h 13m`. Before, an alias showed how long ago it was named, so a server restarted a
  minute ago could read `3d`. A route whose port does not answer says `down`; the tooltip says
  "Running since" with the local time and, for aliases, when the name was given. When the start
  time cannot be read the column falls back to the name time, labelled `named`. Detected rows show
  their uptime under the port. The snapshot, `list --json` and the MCP tools carry `startedAt`
  (epoch milliseconds), read from `/proc` on Linux, `ps` on macOS and `Win32_Process` on Windows.

- Every route and detected row with a known folder has an editor button that opens it in the
  default editor, with its name in the tooltip ("Open in VS Code"). The new `defaultEditor` config
  field (Settings, Open with, Default editor) picks any editor found or a custom app; `null`, the
  default, uses the first editor found. The button is hidden when no editor is found.

- The terminal look is configurable: `terminal` in the config (Settings, Terminal) sets the font
  size (10 to 24, default 12), line height (1 to 2, default 1.2), cursor (`block`, `bar` or
  `underline`, blinking or not), scrollback (1000 to 100000 lines, default 10000) and colors:
  `studio` follows the page's light or dark mode with a full 16-color palette, `dark` and `light`
  stay fixed. Settings shows a live preview, and saving changes open terminals at once.

- Terminals come back after a Studio restart. Studio keeps `terminals.json` next to the config
  with the terminals that were running (command, folder, title, start time, and whether `run` or
  an agent started it or a person did) and the last 20 commands per folder. On start they are
  listed as "Stopped by a Studio restart" with Run again on each and Run all again;
  `restoreTerminals: "always"` runs their commands again on start (never plain shells) and
  `"never"` forgets them. New terminal offers the recent commands of each folder. MCP:
  `list_terminals` lists the stopped ones with `stopped_by_restart` and `started_by`, and the new
  `restart_terminal` tool runs a terminal again. `GET /api/terminals/recent-commands` returns the
  recent commands.

- Follow is now Auto-scroll: it keeps the view at the newest output, scrolling up pauses it, and
  scrolling back to the bottom resumes it. While the view is not at the newest output, a Jump to
  latest button brings it back. Before, Follow pulled the view down on every line, so scrolling
  back through a busy log was not possible.

- With three or more terminals the panel shows a list instead of cramped tabs: grouped by project
  and worktree with the branch, each with its status, title, command, open ports and a close
  button on hover. The list resizes and collapses (both remembered), has a filter past eight
  terminals, and becomes a dropdown on narrow screens. While the panel has focus, Ctrl+PageUp and
  Ctrl+PageDown switch terminals and Ctrl+Shift+W closes the active one.

- In a window 1100 px or wider the terminals open in a resizable pane on the right of the list,
  and the selected row's terminal shows there. The panel header and Ctrl+K ("Terminal at the
  bottom", "Terminal on the right") move it; the choice and both sizes are remembered.

- Rows whose port a Studio terminal serves show its status (`running`, `exited 1`) and Logs, Stop
  and Run again; other rows keep the open-a-shell button.

## 0.1.3 (2026-10-25)

- Helper ports stay out of the way. A named server's other ports (opened by the same process), Node, V8 and Chrome debuggers (found by their `/json/version` answer, and
  9229 or 9222 when that is unclear) and ports in the system's ephemeral range no longer show as
  separate Detected rows suggesting the same name. They are listed under a closed "Other ports
  (N)" at the bottom of Detected, each with its process, direct URL and reason, in the snapshot as
  `otherPorts`; auto mode never names them. `showEphemeralPorts` (Settings, "Show temporary
  ports") lists ephemeral ports with the others again. One process on several ports is one row,
  with the extra ports listed as "Also answers on". The Detected section folds down to its title,
  and the page remembers that and whether Other ports is open.

- `.env` lines from route names: `portless-studio env [--prefix P] [--strip S] [--direct] [--json]
  [name...]` prints `API_ACME_URL=http://api.acme.localhost:1355` for each route, so an app can
  call another by a URL that survives port changes. A name also picks its `*.name` routes,
  `--strip acme` turns `api.acme` into `API_URL`, `--prefix VITE_` adds a prefix and `--direct`
  uses `http://localhost:<port>`. In the page, the row menu has Copy as .env line and the command
  menu has Copy routes as .env and Choose routes for .env…, a dialog with route checkboxes, prefix,
  suffix and a live preview. The MCP tool `env_lines` returns the same lines and writes no file.

## 0.1.2 (2026-10-25)

- Docker containers show under Detected: Studio reads `docker ps` once per scan (2-second limit,
  silently skipped when Docker is missing, stopped or refuses the user) and lists each published
  port that answers HTTP, with a Docker badge, the image and a suggested name from the compose
  service and project (`api.acme`) or the container name. Stop runs `docker stop` after a
  confirmation, only for containers `docker ps` listed. The doctor says whether it reads containers.
- Short URLs: with `shortUrls: true` (Settings, "Short URLs (port 80)"), names open as
  `http://name.localhost`. Studio listens on port 80 itself and forwards every connection to the
  proxy, which stays on `proxyPort` (1355), so nothing asks for sudo. It works only where this
  user may listen on port 80 without sudo; otherwise Studio logs why, names keep `:1355` and the
  doctor says so. URLs in the page, `list`, MCP and notifications drop the port only while Studio
  listens. The doctor's "Shorter URLs" check tests port 80 without sudo, offers Use short URLs,
  and on Linux shows the one-time `sysctl` command and how to keep it. The default stays off.
- Doctor fixes that change the proxy port (Use HTTP on port 1355, Use short URLs) check the result
  and go back to the previous settings when it fails, starting the proxy again on its old port.
  The doctor no longer offers to start the proxy below port 1024 on Linux or macOS, where portless
  always asks for sudo.
- Studio's own `studio` route no longer shows in the routes list, its counts, filters or
  notifications. `showStudioRoute: true` (Settings, "Show Studio in the routes") brings it back,
  and MCP `list_routes` takes `include_studio`.

## 0.1.1 (2026-10-25)

- The proxy start is confirmed: Studio checks the port is free before starting it and that it
  answers afterwards, and says which process holds the port when it cannot start.
- Studio keeps the last good list when it reads portless's routes file while portless is writing
  it, instead of showing an empty list.
- Auto mode waits until a port has been unnamed for two scans in a row, so it no longer races
  `portless <name> <command>`, and checks the routes again right before naming.
- The doctor warns when portless's routes file has entries Studio cannot read.
- Releases publish to npm through Trusted Publishing and create a GitHub release.
- Studio runs on Node 22 or later (it needed 24 before). CI tests Node 22 and 24 on Linux, macOS
  and Windows.
- Update notice: once a day Studio asks the npm registry for the latest version and, when a newer
  one exists, prints one line on start and shows a dismissible banner in the page. Turn it off
  with `checkForUpdates: false`, the Settings switch or `PORTLESS_STUDIO_NO_UPDATE_CHECK=1`; it
  never runs in CI.
- The README has an Install section: try it with `npx`, install globally for everyday use and
  start at login, and how to update and uninstall. `service install` run from the npx cache now
  prints the exact commands to move to a global install.

## 0.1.0 (2026-10-25)

The first release.

- Live list of portless routes with name, URL, port, kind, uptime, tunnels and health.
- Detected ports: listening ports that answer HTTP and have no name yet, with the process, project
  folder, git branch and a suggested name; name, name all or ignore them.
- Auto mode that names every new dev server and removes those names after their port closes.
- Suggested names from the ticket key or branch, the package and the repository, with a
  configurable `nameTemplate`.
- Name, rename and remove aliases; stop a dev server from its row.
- Views with grouping, sorting, filters, custom groups, favorites and a default view.
- Terminals per project inside Studio, and `portless-studio run` to start one from a shell.
- MCP server (`portless-studio mcp`) for AI agents, `--json` output for `list`, `doctor` and
  `config`, and `portless-studio open` to bring Studio to the front.
- Open with menu for editors, the file manager and custom apps.
- Project icons from the running server, the project folder or Settings.
- Health panel and `portless-studio doctor` with fixes; start, stop and restart the proxy and
  Studio from the page.
- `portless-studio init`, `uninstall` and `service install` for Linux, macOS and Windows.
- In-page and system notifications.
- Install portless from the page when it is missing.
- Keyboard shortcuts for every action and a command menu.
