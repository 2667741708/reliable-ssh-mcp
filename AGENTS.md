# Reliable SSH MCP code-inspection workflow

## Parser-safe inspection

- Use `npm run inspect -- lines --file <relative-path> --start <line> --end <line>` for numbered source excerpts.
- Do not place complex regular expressions, alternation, nested quotes, or shell metacharacters directly in a PowerShell command.
- For complex searches, write a JSON request under the ignored `staging/` directory and run `npm run inspect -- search --query staging/<name>.json`.
- Query paths must be project-relative. The inspector rejects absolute paths and `..` escapes.
- Simple `rg -n <literal> <path>` searches remain acceptable when the pattern has no shell metacharacters.

Example query:

```json
{
  "mode": "regex",
  "patterns": ["transportError\\(", "identityCacheValid"],
  "paths": ["src", "test"],
  "extensions": ["js"],
  "case_sensitive": true,
  "max_results": 200
}
```

## Required verification order

1. Read `git status --short --branch` and inspect only the relevant diff.
2. Use the parser-safe inspector for targeted line evidence.
3. Run focused tests while developing.
4. Before committing or publishing, run `npm run verify`.
5. Review the package dry-run file list and staged diff for host-specific paths, addresses, credentials, backups, and artifacts.
6. Stop on the first failed stage. Identify the parser or tool that rejected it and change the command shape instead of repeating it.
