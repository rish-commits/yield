# Yield

**Feed your agent, sharpen its output**

You tell it the stack, the conventions, the folder to leave alone, and next
session it needs telling again. Meanwhile every tool in this space is busy
making the wait feel shorter. Yield does the opposite and makes the wait useful:
you are already watching the agent work, which is the best moment you will get
to tell it something it should know. A panel sits quietly in your editor, you
type a line, and it goes into a file that is fed back on every later run. Over a
few days the agent stops needing to be told.

- A panel that opens while the agent works and never blocks you
- Notes go back to Claude Code automatically on every later run
- Plain markdown you can read, edit or delete at any time
- Hooks install themselves, per project, merged into what you already have
- Local by default: `.yield/` is gitignored unless you decide otherwise

## Before it works

**Claude Code, installed and signed in.** That is the only requirement.

Everything else is automatic. There is no config file to write, no setup step,
and no API key to obtain. Yield installs its own Claude Code hooks the first
time it runs in a project.

If Claude Code was already running when you installed, the panel shows one line
asking you to restart it, because hooks are read once when a session starts.
That line disappears the moment it works and does not come back.

Open a folder before you start. Yield keeps your notes beside the project, so
with no folder open there is nowhere to put them: the panel says so and saving
is refused rather than silently dropped. Everywhere else, notes save whatever
else has gone wrong.

Works in VS Code 1.85 or later, and in forks such as Cursor.

## Install

Open the Extensions view (`Ctrl+Shift+X`, or `Cmd+Shift+X` on macOS), search
for **Yield**, and click **Install**. Reload the window, then `Ctrl+Shift+P`
(`Cmd+Shift+P` on macOS) and pick **Yield: Open**.

<details>
<summary>Building from source instead</summary>

Only if you are working on Yield itself. Build the `.vsix` (see
[Development](#development)), then in the Extensions view use the **...** menu
and pick **Install from VSIX...**. Install through the UI rather than the
command line; some VS Code forks leave a half-registered extension behind when
installed via CLI.

</details>

## What it writes to your project

Two files, both in your project, both yours:

- **`.yield/yield-context.md`** holds your notes, written as a standalone
  project brief.
- **`.claude/settings.json`** is where the hooks go, one set per project. Yield
  merges into whatever is already in that file, never overwrites it, and writes
  a backup (`settings.json.yield-backup`) before making any change. If the file
  cannot be parsed, Yield refuses to write and tells you where it is, rather
  than repairing it for you.

`.yield/` is added to your `.gitignore` on first run, so your notes stay on your
machine and never turn up in a code review. **Removing that line is how you
share context with your team.** If you delete it, Yield will not add it back.
That is a deliberate decision on your part and it is treated as one. If the
project is not a git repository, nothing is written.

**Yield never touches your `CLAUDE.md`.**

## The file

`.yield/yield-context.md` is plain markdown, and it is the point of the whole
thing. It is written to read as a **standalone project brief**, useful to you, a
new teammate, or any AI, whether or not Yield is installed:

```markdown
# Project context

Standing instructions for anyone working on this project, human or AI.
Read this before making changes, and follow it unless the user says otherwise.

Where two entries conflict, the later one wins.

## Commands

- pnpm install, pnpm dev, pnpm test

## Avoid

- never edit anything under generated/
```

Notes are grouped under a fixed set of headings: Project, Architecture,
Commands, Conventions, Design, Avoid, Workflow, Gotchas, Notes. A heading only
appears once something is filed under it, so the file stays as short as what you
have actually told it.

Your words go in as you typed them. Nothing is summarised or rewritten, and
anything you write in the file by hand is preserved exactly, including your own
headings and prose.

## Suggestions, and what reaches Anthropic

While the agent works, Yield can suggest something worth writing down, based on
your task and what is already in your context file.

It does this through **the Claude Code already installed on your machine**. There
is no API key to obtain, no separate account, and no third-party service
involved.

Being precise, because it matters: **Claude Code is local, the model is not.**
When a suggestion is generated, your current prompt and the contents of
`.yield/yield-context.md` are sent to Anthropic's API by Claude Code, exactly as
they would be in any normal Claude Code turn. Nothing goes anywhere else, and
Yield never sees or stores a credential. If your context file holds something
you would not send to a model, that applies here too.

These calls **draw on your existing Claude usage**, roughly a cent's worth per
suggestion at current small-model prices.

**To turn it off:** Settings, search "Yield", uncheck **Smart suggestions**.
Yield then uses a built-in set of suggestions instead, with no model calls at
all. Everything else works exactly the same, and the change takes effect
immediately with no reload.

## Using it

`Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) and pick **Yield: Open**. The panel
opens as an ordinary editor tab, so you can drag it wherever you like.

- The dot goes green while your agent is working
- Type anything and press Enter to save it
- Click the note count to open `.yield/yield-context.md`

Where two entries in the file conflict, the later one wins.

## Troubleshooting

**The dot never turns green.** The panel says **"Not hearing the agent"** when
it cannot hear the hooks. Each project claims its own local port, so several
windows can run side by side without colliding; if the port it wanted is busy,
Yield claims the next free one and rewrites its hooks to match, which needs one
Claude Code restart. If it cannot claim a port at all, it says so and stops
asking. Notes still save either way, and reloading the window tries again.

**The agent ignores your notes.** Restart Claude Code. A session that started
before the hooks existed is not sending them.

**Something went wrong during setup.** The panel says what, in one line, and the
Output channel ("Yield") carries the path to the settings file. To retry, run
`Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) and pick **Yield: Install hooks**.

## Development

```bash
npm install
npm run compile
npx @vscode/vsce package
```

`CLAUDE.md` carries the architecture, the decisions behind it, and the things
not to relearn.
