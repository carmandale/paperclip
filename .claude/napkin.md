# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-03-27 | User | Interactive rebase editor opened during `git rebase --continue` | Always use `GIT_EDITOR=true git rebase --continue` — never let git open an editor |
| 2026-03-27 | User | Was operating on Dropbox copy of repo | Always work from `~/dev/paperclip`, never `~/Groove Jones Dropbox/.../paperclip` |

## User Preferences
- No interactive rebases, ever. `GIT_EDITOR=true` on any rebase continue.
- Don't overthink preservation — if nothing critical is running, just do the work.

## Patterns That Work
- `GIT_EDITOR=true git rebase --continue` to avoid editor prompts

## Patterns That Don't Work
- `git rebase --continue` without GIT_EDITOR=true — opens vim, user hates this

## Domain Notes
- `upstream` = paperclipai/paperclip (the original OSS repo)
- `origin` = carmandale/paperclip (our fork on GitHub)
- mini-ts = Mac mini deployment, updated via `scripts/mini_safe_sync.sh`
- Company definition (Carman Industries) lives in `~/dev/operator/company/`, not here
- Working directory must be `~/dev/paperclip`
