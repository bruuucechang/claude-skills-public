# claude-skills-public

[繁體中文](README.zh-TW.md)

A set of [Claude Code](https://claude.com/claude-code) skills for shipping work carefully: checking repo state before you touch it, handing off between sessions, debugging from a failing command, and verifying UI by actually rendering it.

The skills are written in Traditional Chinese. Claude can follow them whatever language you work in, so you don't need to read Chinese to use them. A few (`ship`, `codex-drive`, `app-design`) ask for Traditional Chinese in commit messages, reports, or UI text. Tell Claude if you want something else.

## Install

macOS and Linux. You need `git`.

```bash
git clone https://github.com/bruuucechang/claude-skills-public.git ~/claude-skills
bash ~/claude-skills/install.sh
```

Start a new Claude Code session afterwards. By default this only links the skills into `~/.claude/skills`. It does not touch your `CLAUDE.md`, `settings.json`, or git config. Re-running is safe.

To uninstall, run `bash ~/claude-skills/install.sh --uninstall`. It removes the links and hooks. Any files it backed up stay as `*.bak-*` for you to restore.

### Optional extras

These are the author's personal setup. Skip them unless you want to adopt it.

| Flag | Adds | Needs |
|---|---|---|
| `--with-hooks` | Guard hooks merged into `~/.claude/settings.json` (backed up first), for example blocking commits with the wrong author. Asks for your GitHub account and email. | `node` 20+, `jq`; `git` 2.55+ for the push guard |
| `--with-rules` | Links the author's global `AGENTS.md`, `CLAUDE.md`, `rules`, and `commands` into `~/.claude`. Yours are backed up as `*.bak-<time>`. These rules are opinionated and written in Chinese. They tell Claude to reply in Traditional Chinese, among other things. | |
| `--full` | Both of the above. | |

To install hooks without prompts, combine `--with-hooks` or `--full` with `--owner <github-account> --email <email> --lang none --yes`.

## Skills

| Skill | What it does | Also needs |
|---|---|---|
| `recon` | Checks the current state of a repo before you change it | |
| `ship` | Runs tests, checks the commit author, adds only your files, then commits, pushes, and verifies | `gh`, `jq`; a `code-review` skill is optional |
| `debug` | Debugging that starts from a command that fails, not from a theory | |
| `handoff` | Writes a handoff note so a new session can continue without re-asking | |
| `blocks` | Splits remaining work into pieces that each fit in one session | |
| `grilling`, `grill-me` | Interviews you one question at a time until a plan is solid | |
| `sync-docs` | Checks that `CLAUDE.md` and the README still match the code | |
| `newproj` | Sets up a new project with a three-layer skeleton and guards | |
| `env-doctor` | Diagnoses common macOS and Windows environment failures | |
| `app-design` | Design direction for tool screens: dashboards, lists, forms | |
| `inspect-ui` | Renders a page and scans it for overlap, broken states, and console errors | `dev-browser` |
| `dataviz`, `tufte-viz` | Charts and diagrams | |
| `codex-drive` | Drives the Codex CLI in a background tmux session | `codex`, `tmux` |

The installer tells you which of these tools are missing. A missing tool only affects the skill that needs it.

## License

[MIT](LICENSE). Some skills are adapted from other projects under their own licenses. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
