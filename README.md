# Access permission levels

A DSH bundle that **adds** two access levels to the deployment's permission
picker and gates every file effect on the level, asking the user to authorize
each operation family separately.

## The levels

The deployment's original presets are kept as they were; two rows are added in
front of them, and one existing seat in the composer carries all five. Each row
grants strictly more than the row above it, so the picker reads as one ladder:

| Picker row | Preset | Reading files | Modifying files |
|---|---|---|---|
| 无权限 (added) | `no-access` | Denied everywhere, including inside the workspace | Denied everywhere |
| 工作区内查看 (added) | `workspace-access` | Inside the workspace allowed; outside asks the user | Denied everywhere |
| 只读 (original) | `read-only` | Allowed anywhere | Denied everywhere |
| 工作区可写 (original) | `workspace-write` | Allowed anywhere | Inside the workspace allowed; outside asks the user |
| 完全访问 (original) | `danger-full-access` | Allowed | Allowed |

A level's *name* states exactly what it grants: `workspace-access` is a view,
never a write, and it is enforced twice over — the plugin refuses every
modification before the tool runs, and the preset's `read-only` sandbox refuses
them again if the plugin is ever unloaded.

The original three presets keep their original sandbox and approval values,
including the environment-driven approval policy on `danger-full-access`.

## The control

The browser half takes over the **existing** `conversation.input.permission`
seat, so the composer still shows exactly one permission control. Compared with
the shipped control it adds:

- one symbol per mode, drawn as inline SVG in the host's icon language
  (read-only, workspace-write, full access, plus a crossed circle for no access
  and a house for workspace-only);
- a per-mode accent colour — green for no access, the theme's brand ink for
  view-inside-workspace (near-white on the dark theme), the fluorescent yellow for
  read-only, the paler yellow for workspace-write, and red for full access — with the geometry and type kept
  identical across modes (the shipped control's own 13px/28px metrics) so
  switching levels never reflows the composer row. The theme ships no yellow
  alias, so the two yellows are the plugin's own tokens, published for both
  palettes through one body-scoped style element;
- the same list order, the same catalog source (`permissionPresets/catalog`),
  the same current-value source (`permissions` projection), and the same
  write path (the `/permission` command), so both surfaces stay one control;
- the shipped full-access risk confirmation, restyled (non-importable primitive
  markup is reproduced, not imported);
- an **extra readable and writable files** control to the right of the seat: one
  box per family, a count that follows answered dialogs, and per-row revocation.
  Its `选择目录…` buttons try the system folder dialog first and fall back to the
  plugin's own folder browser when the machine has no dialog backend (the browse
  capability still lists directories, so the browser reads them level by level).
  The browser opens with quick places — the home directory, the WSL root and one
  chip per Windows drive mounted under `/mnt` — so a folder on another drive is
  one click away instead of a walk up the breadcrumbs through `/` and `/mnt`.

## The authorization dialog

When the level is `workspace` and a call reaches outside the workspace, the tool
call pauses and the question panel opens with three choices:

- **不允许** — refuse this call; the model receives the refusal reason.
- **仅一次** — allow this call only; the next outside call asks again.
- **该对话中总是允许** — grant this operation family for the rest of the
  conversation, recorded as the **directory** the call works on: the answer
  covers that directory and every file and subdirectory below it, so the next
  call on a sibling file inside it needs no new question.

Reading and modifying are granted separately: consenting to reading never
consents to writing, and the dialog for writing says so. The implication runs
one way only — granting a modification also grants the read it needs, because
nothing is modified unread: writable rows appear in the read box too, the read
box's ✕ takes the whole row (a write is revoked with its read), and the write
box's ✕ takes only the write half. A grant is keyed by the
directory (a path the analyzer knows is a directory keeps itself, any other path
records the directory holding it), never by the file: the point of the answer is
that the user allowed the tree, not one lucky filename. The dialog's answer is
recorded in the session log through the question tool's own tool call and
result, so a resumed session still knows which directories were granted, and the
extra-path control can revoke each family without touching the other.

A session with no human answerer — a subagent, or a deployment without the
question UI — fails closed: the operation is denied with an explanatory reason
instead of waiting.

## What is audited

Every file effect the model can reach is classified into the paths it really
touches, and each family is judged against its own scope:

- `read`, `read_image`, `glob`, `grep`, `lsp`, and `terminal_read` are reads.
- `write`, `edit`, `str_replace_editor`, `apply_patch`, `move`, and `delete`
  are modifications.
- `bash`, `pwsh`, and `terminal_open` are analyzed as shell text. The line is
  tokenized (quotes, escapes, `|`, `&&`, `;`, `&`, `(`, `)`, newlines, and
  redirects including the `2>` form), variables the analysis can know are
  resolved (`FOO=1`, `for f in a b`, an earlier `cd` in the same line), and every
  simple command contributes its real paths: the operand of `rm`, the archive of
  `tar`, the target of `sed -i`, a redirect's target, the roots of `find` (where
  `-delete` turns them into writes), the repo of `git` or the prefix of `npm`,
  and the script file of an interpreter. A heredoc body is analyzed when it
  feeds a shell or an interpreter and is data otherwise; `$(…)` and backticks
  are analyzed in place.
- `/dev/null`, `/dev/std*`, `/dev/tty`, `/dev/fd/*` and friends are never
  fenced. Reading another `/dev/*` node is not a question about the workspace;
  writing one still is.
- A command whose own paths cannot be recovered (an arbitrary script, an unknown
  executable) is *opaque*: it may touch anything in either family. It is judged
  by the directory it runs in — the analyzer tracks `cd` and the process working
  directory, so an opaque script inside the workspace passes and one launched
  from an outside directory asks about that directory. `opaquePolicy: deny` keeps
  the older rule and refuses opaque commands wherever reads are confined to the
  workspace.
- A modification whose targets stayed unreadable (`rm -rf $TARGET`) is still a
  modification, and a level that grants no writing refuses it.
- Any other tool whose arguments carry a path is treated as a modification,
  because a call that names a file cannot be proven read-only.

The two halves of one command are judged separately: the same line can read
inside, write outside, and be asked about exactly the outside half. What stays
inside the workspace never opens a dialog, and nothing about the *shape* of a
command — a pipe, a redirect, a loop, a variable prefix, an in-place flag, or a
heredoc — decides a verdict on its own.

Two consequences follow from judging directories rather than command shapes.
Allowing one directory allows the files and subdirectories inside it, because a
grant covers its subtree and no answer has to be repeated per file. And a level
that writes the workspace writes it silently: `rm -rf sub`, `mkdir -p a/b/c`, or
a script started in the workspace need no question while they stay inside.

A level is only ever granted by explicit configuration: a preset named by the
level table or by `presetLevels`, else the read-only fallback when
`treatReadOnlyAsNoAccess` is on, else `defaultLevel`. The sandbox mode is never
read as a source of permission, so an unmapped preset narrows access instead of
widening it.

Containment is lexical: `..` is folded and a target must resolve under the
session workspace root. A symlink that leaves the tree is not detected, and the
filesystem backend holds no read fence of its own.

## Delegated sessions

A subagent runs in its own session and has no permission preset of its own: the
host's subagent seam forwards only `auto` and `danger-full-access` to a child, so
every other parent preset would land on `defaultLevel`. This plugin therefore
resolves a delegated session through its nearest ancestor:

- **Level inheritance** — `resolveLevel` walks `header.parentSession` up (via the
  `agents` registry first, then the `sessions` store, at most 16 hops) and applies
  the ancestor's own resolved level. Without it every dispatched task would run at
  `no-access` while its parent ran at `workspace-write`.
- **Grant inheritance** — the standing grants of that ancestor conversation are
  folded in before the child's own answers, because a dispatch is part of the same
  run and the user already authorized that directory for it.
- **Per-task write slice** — a dispatcher may narrow just the write half with an
  HTML comment on the first line of the task's **user message**:

  ```
  <!-- dsh-access-scope: {"write":["src/","test/",".harness/runs/<run_id>/<task>/"]} -->
  ```

  Paths are workspace-relative and a trailing `/` declares a directory. A write
  outside the slice is refused with `[access: 越界写入]` — no dialog, because the
  slice was already agreed when the task was split. Reads keep the inherited level.
  Only `user/message` events are considered: a marker an assistant message or a
  tool result quotes is not a declaration, so the constrained side cannot widen
  its own slice. A delegated session without the marker keeps the inherited level.

Two refinements keep the slice usable without loosening it:

- **Opaque commands are judged by the directory their own `cd` reaches.** A shell
  line whose targets cannot be read off its text (`node script.mjs`,
  `python -c …`) may write anywhere, so it is bounded by the directory it runs in.
  `cd src && node build.mjs` is judged in `src`; the same line without the `cd` is
  judged in the conversation's root, which is usually outside the slice. Dispatch
  prompts should therefore either declare the project directory or run commands
  from inside a declared directory.
- **A URL is an address, not a path.** `file:///…`, `https://…` and similar
  arguments are ignored by the command analyzer: they neither ask for a dialog nor
  become write targets. An arrow function (`() => 1`) is likewise not a shell
  redirect.
- **A file-descriptor duplication is not a redirect.** `cmd 2>&1`, `cmd >&2`,
  `cmd 2>&-` consume their descriptor operand and record no path; without this,
  `>&` left a stray `1` that the analyzer read as a new command, which made a
  read-only verification line look like an opaque write in the workspace root.

This is the contract `dsh-subagent-kerze` writes into each dispatch prompt (its
R-8.8). Editing this plugin's source does not hot-reload: `plugin_manager`
disable/enable re-runs `apply()` on the already-imported module, so restart the
harness to load code changes.

## Configuration

`cordis.patch.yml` shows the whole surface. The host row accepts:

| Field | Default | Meaning |
|---|---|---|
| `levels` | `{}` | Level table: each entry needs `level` (`full`/`workspace`/`none`), optionally `preset`, `label`, `description`, `readScope`, `writeScope` |
| `presetLevels` | `{}` | Preset-name to level-name map, for presets the level table does not name |
| `defaultLevel` | `none` | Level used when the current preset matches nothing |
| `treatReadOnlyAsNoAccess` | `true` | Treat the read-only sandbox mode as the no-access level |
| `opaquePolicy` | `directory` | `directory` judges an unreadable command by the directory it runs in; `deny` refuses it wherever reads are confined to the workspace |

`readScope`/`writeScope` accept `workspace` (default) or `anywhere`, so a
deployment can allow reading anywhere while still gating modification.

## Command

`/access-permission` reports the current level, the preset it came from, and
the standing grants. `/access-permission <full|workspace|none>` switches level
by writing the configured preset through the permission-presets service; a level
named by a level entry uses that entry's preset.

`/access-allow` manages the extra paths: `list`, `add <path>`, `add-write
<path>`, `remove <path>`, `remove-read <path>`, `remove-write <path>`, `clear`.
A row ending in `/` is a directory and covers everything below it; the dialog
records that form, and a hand-typed path keeps its trailing separator when it
names a directory; `remove-read` on a writable row removes the row, because the
write carries the read.

Every path argument — `add`, `add-write` and the three `remove` forms alike —
is recognized rather than taken literally: surrounding quotes
(`"` `'` `` ` `` `「」` `『』`), backslash-escaped spaces, `~`/`$HOME`/`${HOME}`,
`file://` URLs (percent-decoded, including the Windows `file:///C:/…` form),
relative paths (resolved against the workspace root, `..` included), redundant
`.`, `..` and empty segments, and Windows drive/UNC spellings are all folded to
one absolute path. A Windows drive spelling (`C:\Users\me`) is rewritten to
where that drive is mounted (`/mnt/c/Users/me` under WSL, read from
`/proc/mounts`), because the tools open the mount point; a drive the host does
not know keeps its typed form. A path that does not exist yet is still accepted
— writing a file that will be created needs it — and the answer says so instead
of failing.
A path that cannot be identified (`~other-user/…`, an empty string) is refused
with the reason; the `remove` forms fall back to the literal text instead, so an
old row can always still be dropped.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: enforcement, level resolution, dialog, command, prompt statement |
| `functions.js` | Pure classification and containment rules, unit-tested on their own |
| `client.js` | Browser half: the permission control in the composer tool row |
| `cordis.patch.yml` | Preset table (originals plus two additions) and the plugin row |

## Packaging note (keep the link intact)

The profile installs this bundle as `link:/home/kerze/dsh-access-permission-plugin`.
Never run `npm pack` (or any npm/pnpm install) **inside this directory**: npm
rewrites the profile dependency to `file:…tgz` and DSH then drops the bundle from
`dsh.profile.bundles`, so the plugin silently stops loading entirely. Pack from a
copy instead:

```sh
DIST=/home/kerze/dsh-access-permission-dist
rm -rf "$DIST"; mkdir -p "$DIST/pkg/locale"
cp README.md package.json index.js functions.js client.js cordis.patch.yml icon.svg "$DIST/pkg/"
cp locale/*.json "$DIST/pkg/locale/"
(cd "$DIST/pkg" && npm pack --ignore-scripts --pack-destination "$DIST")
rm -rf "$DIST/pkg"
```

If it happens anyway, reinstall the bundle directory through the plugin manager
(`install_bundle /home/kerze/dsh-access-permission-plugin`).

