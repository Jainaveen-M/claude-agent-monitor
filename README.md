# Claude agent monitor

A local dashboard for every Claude Code session running on this machine. It shows each session's status, current task, live log, and CPU and memory use. It has no dependencies; Node 18 or later is enough.

```sh
npm start            # or: node server.js
open http://localhost:4317
```

## What it shows

- **Live flow.** A diagram of you, your agents and the tools they use, with every transcript event drawn as a particle:
  - coral particles carry work going out: your prompts and tool calls
  - blue particles carry data coming back: tool results and Claude's replies
  - a failed tool call sends a red particle and the tool flashes ✕
  - a working agent has a rotating coral border, and a link to a tool that is still running shows moving dashes
  - each agent shows its current tool, events per minute, CPU and memory; click one to inspect it
- **Inspector.** For the selected agent:
  - session metadata: model, context size, client, start time
  - current activity, including the full command for Bash calls
  - last prompt
  - CPU and memory charts for the last 3 minutes, also viewable as a table
  - the process tree, including the tools and MCP servers it spawned
  - its subagents
- **Log.** Prompts, replies, tool calls and tool results stream in as they happen. You can filter by kind, follow the newest entry, and switch to a subagent's transcript.
- **Totals.** Running agents, combined CPU and memory, and output tokens.

## Where the data comes from

Everything is read-only and local:

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | Which sessions are live, their busy/idle status, cwd and name |
| `~/.claude/projects/<slug>/<sessionId>.jsonl` | Title, last prompt, current tool, model, tokens, log |
| `~/.claude/projects/<slug>/<sessionId>/subagents/*.jsonl` | Subagent transcripts |
| `ps`, plus `lsof` on macOS or `/proc` on Linux | CPU and memory for each agent's whole process tree |

The server samples every 2 seconds and pushes snapshots to the page over Server-Sent Events. Transcripts are read incrementally, so it only parses bytes appended since the last tick.

The CPU figure counts 100% as one full core. It is measured from the change in CPU time between samples, so it reflects the last 2 seconds rather than a long-run average.

A `claude` process with no session file still appears, marked **Running**. This covers older versions and some headless runs. Only its process stats are available.

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | `4317` | |
| `HOST` | `127.0.0.1` | Interface to bind to |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Same variable Claude Code uses |

## Security

Transcripts contain everything you and Claude have typed, including file contents and command output. So the server:

- binds to localhost only
- rejects requests whose `Host` header isn't `localhost` or `127.0.0.1`, which blocks DNS-rebinding attacks from web pages

Setting `HOST=0.0.0.0` will **not** expose it on your network, because the Host check still applies. That is deliberate. To view the dashboard from another device, use an SSH tunnel.
