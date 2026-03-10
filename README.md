# prompt-enhancer-mcp

An MCP server that transforms vague or short developer prompts into detailed, context-aware, actionable prompts using OpenAI — with optional Linear ticket context and real code pulled from your GitHub repo or local git.

## What it does

When you type a vague prompt like `"fix the login bug"`, this server rewrites it into a precise, structured, actionable prompt that includes:

- Exact file names, function names, and variables to look at
- Step-by-step instructions for the task
- Edge cases and testing approach
- Clear success criteria

It can also:
- Fetch a **Linear ticket** and use its description, comments, and labels as context
- Pull **real code snippets** from your GitHub repo (or local git) on the right branch
- Auto-detect your current branch and GitHub repo

---

## Tools

### `enhance` — Primary tool (use this for everything)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | no* | Short or vague user intent to enhance |
| `ticket_id` | string | no* | Linear ticket ID, e.g. `SCL-112` |
| `include_code_context` | boolean | no | If `true`, fetch relevant code from local repo or GitHub |
| `branch_name` | string | no | Explicit branch to read code from (overrides auto-detection) |
| `local_branch` | string | no | User's current git branch (pass output of `git rev-parse --abbrev-ref HEAD`) |
| `repo` | string | no | GitHub repo as `owner/repo` (parse from `git remote get-url origin`) |
| `preview` | boolean | no | If `true` (default), show result and ask for confirmation |

*At least one of `prompt` or `ticket_id` is required.

---

### `enhance_prompt` — Simple prompt-only tool

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The short or vague prompt to enhance |
| `preview` | boolean | no | If `true` (default), show result and ask for confirmation |

---

### `enhance_from_ticket` — Deprecated

Use `enhance` instead. This tool only supports ticket lookup with no code context.

---

## Installation

### Via Smithery

Find this server on [Smithery](https://smithery.ai) and install it in one click. Only `OPENAI_API_KEY` is required — `LINEAR_API_KEY` and `GITHUB_TOKEN` are optional.

### Via Claude Code (remote — Render)

```bash
claude mcp add prompt-enhancer --transport http https://your-render-app.onrender.com/mcp
```

### Via Claude Code (local)

```bash
git clone https://github.com/waleed-2002/prompt-enhancer-mcp.git
cd prompt-enhancer-mcp
npm install
cp .env.example .env   # fill in your keys
node index.js
```

Then in a separate terminal:

```bash
claude mcp add prompt-enhancer --transport http http://localhost:3000/mcp
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key — get one at [platform.openai.com](https://platform.openai.com) |

### Optional — Integrations

| Variable | Description |
|----------|-------------|
| `LINEAR_API_KEY` | Linear API key — enables ticket context. Get one at [linear.app/settings/api](https://linear.app/settings/api) |
| `GITHUB_TOKEN` | GitHub personal access token — enables code context from private repos |
| `GITHUB_REPO` | Override auto-detected repo, e.g. `owner/repo` |

### Optional — Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `ENHANCER_MODEL` | `gpt-4o-mini` | OpenAI model for prompt enhancement (e.g. `gpt-4o` for higher quality) |
| `EXTRACTOR_MODEL` | `gpt-4o-mini` | OpenAI model for file/keyword extraction |
| `MAX_TOKENS` | `1500` | Max tokens in the enhanced prompt output |
| `TEMPERATURE` | `0.3` | LLM temperature |
| `SEARCH_EXTENSIONS` | `ts,tsx,js,jsx,py,go,rs,java,rb,php,swift,kt` | File extensions to search locally |
| `EXCLUDE_DIRS` | `node_modules,.git,dist,build,.next,vendor` | Directories to skip when searching |
| `MAX_CODE_FILES` | `8` | Max code files to include in context |
| `SESSION_TTL` | `1800000` | Session lifetime in ms (default 30 min) |
| `PORT` | `3000` | HTTP server port |

---

## Usage Examples

### Enhance a simple prompt

```
enhance: "add dark mode"
```

### Enhance with a Linear ticket

```
enhance with ticket_id: "SCL-112"
```

### Enhance with ticket + code context

```
enhance with ticket_id "SCL-112", include_code_context true
```
Claude will auto-detect your branch and repo before calling the tool.

### Enhance with a custom prompt + ticket

```
enhance: "focus only on the mobile layout", ticket_id: "SCL-112"
```

---

## Deployment on Render

1. Push this repo to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Set **Build Command**: `npm install`
4. Set **Start Command**: `node index.js`
5. Add environment variables: `OPENAI_API_KEY`, `LINEAR_API_KEY`, `GITHUB_TOKEN`
6. Deploy — your MCP endpoint will be at `https://your-app.onrender.com/mcp`

Health check endpoint: `GET /health` → `200 OK`

---

## How code context works

When `include_code_context` is `true`:

1. LLM extracts likely file paths and keywords from the ticket/prompt
2. Files are fetched in priority order: **ticket branch → local branch → staging → main**
3. If fewer than 3 files found, falls back to **local grep** (if inside the target repo) then **GitHub code search**
4. Relevant lines are extracted using keyword matching (not always lines 1–60)

---

## Requirements

- Node.js 18+
- OpenAI API key

## License

MIT
