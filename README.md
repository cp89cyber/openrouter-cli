# openrouter-cli

Simple Node.js CLI for sending prompts to models through [OpenRouter](https://openrouter.ai).

## Quick start

```bash
npm install
OPENROUTER_API_KEY=sk-... npx openrouter chat "Say hello"
```

Or install globally:

```bash
npm install -g .
openrouter chat "Write a haiku about rust"
```

## Commands

### `openrouter chat`
Send a message to a model.

Examples:
- Basic: `openrouter chat "Explain zero-knowledge proofs in two sentences."`
- Streaming: `openrouter chat "Give me 3 startup ideas" --stream`
- With system prompt and file input: `openrouter chat --system "You are concise." --file prompt.txt`
- Force JSON output from the model: `openrouter chat "Return a JSON object with a random joke." --json-mode`
- Use built-in web search: `openrouter chat "What happened in AI yesterday?" --web`
- Raw API JSON: `openrouter chat "Explain transformers" --json`

Useful flags:
- `-m, --model <id>` (default `x-ai/grok-4.1-fast:free` or `OPENROUTER_MODEL`)
- `--system <text>` add a system prompt
- `-f, --file <path>` read prompt from a file
- `--stdin` read prompt from STDIN (also auto-detected when piped)
- `--stream` stream tokens as they arrive
- `--json` print the full API response JSON
- `--json-mode` ask the model for structured JSON (`response_format: json_object`)
- `--web` enable OpenRouter's built-in web search plugin (or `--online` to append `:online` to the model id)
- `--web-engine <auto|native|exa>`, `--web-max-results <n>`, `--web-search-prompt <text>` tune web search behaviour
- When web search is used, sources are printed after the answer (even in `--stream` mode) so you can see proof of the fetched pages
- `--temperature <n>`, `--top-p <n>`, `--max-tokens <n>` sampling controls

### `openrouter yolo`
Run in fully autonomous "YOLO" mode where the model can issue shell commands to reach a goal. **This is unsafe by design**: commands are executed immediately with no confirmation, so use a disposable environment.

```
===============================================================================
===  H U G E   S C A R Y   H O R R I F Y I N G   W A R N I N G  ===============
===  YOLO MODE IS A DANGEROUS BETA THAT WILL RUN ARBITRARY SHELL COMMANDS!   ===
===  IT CAN DELETE FILES, EXFILTRATE SECRETS, OR CORRUPT YOUR SYSTEM.         ===
===  USE ONLY IN THROWAWAY/SANDBOXED ENVIRONMENTS.                            ===
===  IF YOU ARE NOT ABSOLUTELY SURE, ABORT NOW WITH CTRL+C.                   ===
===============================================================================
```

Examples:
- `openrouter yolo "clone the repo and list test files"`
- `openrouter yolo --max-steps 5 "find all TODOs in src"`
- `openrouter yolo --system "Be extremely cautious" "summarize the git status"`

Useful flags:
- `-m, --model <id>` (default `x-ai/grok-4.1-fast:free`)
- `--system <text>` override the autonomy system prompt
- `-f, --file <path>` or `--stdin` to feed the goal
- `--max-steps <n>` cap how many commands are executed (default 8)
- `--web` / `--online` turn on built-in web search for fresher context; `--web-*` flags mirror the chat command
- `--shell <path>` choose which shell to run (defaults to `$SHELL` or `/bin/bash`)
- `--temperature <n>`, `--top-p <n>`, `--max-tokens <n>` model controls

### `openrouter models`
List available models (requires the same auth headers).

Examples:
- `openrouter models` (all models)
- `openrouter models --search llama --limit 5`
- `openrouter models --json` (raw API JSON)

## Configuration

Set your API key (required):
- `OPENROUTER_API_KEY` env var, or `--api-key <key>` flag.
  - Flags are global, so you can place them before the subcommand if you prefer (e.g., `openrouter --api-key sk-... chat "Hello"`).

Optional headers recommended by OpenRouter:
- `OPENROUTER_REFERER` (or `--referer <url>`) – your site/app URL.
- `OPENROUTER_TITLE` (or `--title <text>`) – app name shown in OpenRouter.

Other knobs:
- `OPENROUTER_BASE_URL` to point at a different gateway (default `https://openrouter.ai/api/v1`).
- `OPENROUTER_MODEL` to change the default model used by `chat`.

## Requirements
- Node.js 18+ (uses the built-in `fetch`).

## Notes
- Errors from the API are surfaced with status codes for easier debugging.
- Usage token counts print to stderr unless `--json` or `--quiet` is used.
