#!/usr/bin/env bash
# End-to-end smoke test in a throwaway $HOME. Never touches your real ~/.claude.
# Covers: the generated wrapper (3 argv shapes, explicit env, pin, map, unknown
# profile), the CLI, the shell-init function, and the bundled extension driven
# through a fake `vscode` module. Run after `npm run build`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/claudecode-switcher-e2e.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export HOME="$SCRATCH/home"; mkdir -p "$HOME/.claude/projects" "$HOME/bin" "$HOME/proj/sub" "$HOME/other"
unset CLAUDE_CONFIG_DIR CLAUDE_PROFILE || true
echo '{"hasCompletedOnboarding":true,"oauthAccount":{"accountUuid":"u-def","emailAddress":"me@example.com"}}' > "$HOME/.claude.json"
printf '#!/bin/sh\necho "FAKE_CLAUDE CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-<unset>} args=$*"\n' > "$HOME/bin/claude"; chmod +x "$HOME/bin/claude"
echo 'console.log("FAKE_CLI_JS CLAUDE_CONFIG_DIR=" + (process.env.CLAUDE_CONFIG_DIR||"<unset>"))' > "$HOME/bin/cli.js"
export PATH="$HOME/bin:$PATH"
CLI="$ROOT/packages/cli/dist/claudecode-switcher.cjs"
fail() { echo "FAIL: $*" >&2; exit 1; }
expect() { local got="$1" want="$2" what="$3"; [[ "$got" == *"$want"* ]] || fail "$what: expected '$want' in '$got'"; echo "ok   $what"; }

node "$CLI" add Work --mode own >/dev/null
node "$CLI" add Personal --mode shared >/dev/null
node "$CLI" use Personal "$HOME/proj" >/dev/null
node "$CLI" install-wrapper >/dev/null
W="$HOME/.claude-profiles/_bin/claudecode-switcher-wrapper.sh"

expect "$(cd "$HOME/proj/sub" && "$W" "$HOME/bin/claude" --x)" "Personal args=--x" "wrapper: binary argv, map → Personal"
expect "$(cd "$HOME/other" && "$W" "$HOME/bin/cli.js")" "CLAUDE_CONFIG_DIR=<unset>" "wrapper: .js argv, default → unset"
echo Work > "$HOME/other/.claude-profile"
expect "$(cd "$HOME/other" && "$W")" "Work args=" "wrapper: no argv, pin → Work"
expect "$(cd "$HOME/proj" && CLAUDE_CONFIG_DIR=/explicit "$W" "$HOME/bin/claude")" "CLAUDE_CONFIG_DIR=/explicit" "wrapper: explicit env respected"
expect "$(cd "$HOME/proj" && CLAUDE_PROFILE=Ghost "$W" "$HOME/bin/claude" 2>&1)" 'Unknown profile "Ghost"' "wrapper: unknown profile warns"
expect "$(cd "$HOME/proj" && CLAUDE_PROFILE=Ghost "$W" "$HOME/bin/claude" 2>/dev/null)" "CLAUDE_CONFIG_DIR=<unset>" "wrapper: unknown profile falls back to default"
expect "$(cd "$HOME/proj" && node "$CLI" which)" "via map" "cli: which explains source"
expect "$(cd "$HOME/proj" && node "$CLI" run Work -- --v)" "Work args=--v" "cli: run under explicit profile"
expect "$(node "$CLI" change-mode Personal own 2>&1 || true)" "IS the shared history" "cli: mode change refused"
rm "$HOME/.claude-profiles/Personal/skills"; mkdir "$HOME/.claude-profiles/Personal/skills"
expect "$(node "$CLI" verify 2>&1 || true)" "LINK_REPLACED" "cli: verify detects drift"
expect "$(node "$CLI" relink Personal)" "moved aside 1" "cli: relink moves stray aside"
[ -d "$HOME/.claude-profiles/Personal/"skills.moved-aside-* ] || fail "moved-aside dir missing"
expect "$(node "$CLI" doctor)" "OK — no errors" "cli: doctor clean"
# custom profiles root: the wrapper must hand the root it was generated for to the resolver
CR="$HOME/custom-root"; mkdir -p "$HOME/croot-proj"
CLAUDECODE_SWITCHER_ROOT="$CR" node "$CLI" add Alt --mode own >/dev/null
CLAUDECODE_SWITCHER_ROOT="$CR" node "$CLI" use Alt "$HOME/croot-proj" >/dev/null
CLAUDECODE_SWITCHER_ROOT="$CR" node "$CLI" install-wrapper >/dev/null
expect "$(cd "$HOME/croot-proj" && "$CR/_bin/claudecode-switcher-wrapper.sh" "$HOME/bin/claude")" "custom-root/Alt args=" "wrapper: custom profiles root reaches the resolver"
mkdir -p "$HOME/.claude-profiles/Personal/projects/-x/memory"; echo hi > "$HOME/.claude-profiles/Personal/projects/-x/memory/m.md"
expect "$(cat "$HOME/.claude/projects/-x/memory/m.md")" "hi" "shared: memory written via profile lands in ~/.claude"
eval "$(node "$CLI" shell-init)"
expect "$(cd "$HOME/proj" && claude --s)" "Personal args=--s" "shell-init: claude() routes per folder"
expect "$(cd "$HOME" && claude --t)" "CLAUDE_CONFIG_DIR=<unset>" "shell-init: default leaves env unset"
MOCK_OUT="$(node "$ROOT/scripts/mock-activate.cjs" "$ROOT/packages/vscode/dist/extension.js" "$SCRATCH")" || { echo "$MOCK_OUT"; echo "FAIL extension mock"; exit 1; }
expect "$MOCK_OUT" "mode without picker = shared" "extension: add account is shared, no mode picker"
expect "$MOCK_OUT" "menu marked current: Personal" "extension: menu marks current account"
expect "$MOCK_OUT" "extras: Add another account…,Open Login Terminal,More…" "extension: menu extras"
expect "$MOCK_OUT" "migrated: setting = ~/.claude-profiles/_bin/claudecode-switcher-wrapper.sh | legacy files gone = true | prev wrapper carried = /old/claude-wrapper.sh | old key cleared = undefined | setting carried = terminal | old setting cleared = undefined" "extension: pre-release ccprof install migrated (state + settings)"
expect "$MOCK_OUT" "after picking Default: routed to Personal = false" "extension: menu pick re-routes folder"
expect "$MOCK_OUT" "after picking Personal: routed to Personal = true" "extension: menu pick routes back"
expect "$MOCK_OUT" "after disable: wrapper setting = /old/claude-wrapper.sh" "extension: disable routing restores the wrapper that was there before"
PKG="$(node -e 'const p=require(process.argv[1]).contributes;console.log("palette hidden:",!p.commands&&!p.menus,"| storageMode setting:",Object.keys(p.configuration.properties).some(k=>k.endsWith("storageMode")))' "$ROOT/packages/vscode/package.json")"
expect "$PKG" "palette hidden: true | storageMode setting: false" "manifest: no palette entries, no storage mode setting"
echo "ALL OK"
