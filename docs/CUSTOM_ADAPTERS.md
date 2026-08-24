# Custom model adapters

Custom adapters let contributors use any non-interactive coding CLI that accepts a prompt as an argument.

Configure:

- **Command:** executable name or absolute path.
- **Version arguments:** arguments used by the connection check.
- **Read-only arguments:** arguments for assessment and review turns.
- **Write arguments:** arguments for implementation turns.
- `{prompt}`: placeholder replaced with Relay's complete prompt.

Example for an imaginary CLI:

```json
{
  "command": "my-agent",
  "versionArgs": ["--version"],
  "readArgs": ["run", "--read-only", "--prompt", "{prompt}"],
  "writeArgs": ["run", "--write", "--prompt", "{prompt}"]
}
```

Relay never invokes adapters through a shell. Arguments are passed directly to the executable. The adapter is responsible for authentication, non-interactive behavior, and returning its final response on standard output.
