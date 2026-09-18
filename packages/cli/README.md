# claudecode-switcher (CLI)

Terminal front end over the same core as the **ClaudeCode Switcher** VS Code
extension. Same `~/.claude-profiles`, same resolver. **Not published to npm**;
it exists for `scripts/e2e.sh` and for development. Build from source:

```
npm install && npm run build
node packages/cli/dist/claudecode-switcher.cjs help
```

Resolution order: `CLAUDE_CONFIG_DIR` (explicit, respected) > `CLAUDE_PROFILE` >
`.claude-profile` file > `map.conf` longest prefix > `default` (`~/.claude`,
variable left unset).
