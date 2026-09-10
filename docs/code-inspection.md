# Parser-safe code inspection

PowerShell, a transport, a remote shell and an interpreter may all parse the
same command. Complex inline regular expressions therefore become fragile,
especially when they contain `|`, quotes, braces, dollar signs or backslashes.

Reliable SSH MCP includes a local inspection CLI that reads source files
directly with Node.js. It never launches a shell or passes a regular expression
through PowerShell.

## Numbered lines

```powershell
npm run inspect -- lines --file src/connection-pool.js --start 279 --end 340
```

## Complex search

Put the request in an ignored file such as `staging/connection-query.json`:

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

Then run a command containing only simple path arguments:

```powershell
npm run inspect -- search --query staging/connection-query.json
```

Use `"mode": "literal"` when regular-expression behavior is unnecessary.
Zero matches are reported explicitly and are not treated as a process failure.
Absolute paths and paths outside the current project are rejected.

## Release verification

```powershell
npm run verify
```

The fixed pipeline checks unstaged and staged whitespace, JavaScript syntax,
the complete test suite, and the npm package file list. Each subprocess is
launched with an argument array and `shell: false`.
