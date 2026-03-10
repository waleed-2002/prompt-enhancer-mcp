import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, normalize, relative } from "path";
import http from "http";
import { z } from "zod";

// ─── Configuration (env-driven, easy to override) ────────────────────────────
const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  enhancerModel: process.env.ENHANCER_MODEL || "gpt-4o-mini",
  extractorModel: process.env.EXTRACTOR_MODEL || "gpt-4o-mini",
  maxTokens: Number(process.env.MAX_TOKENS) || 1500,
  temperature: Number(process.env.TEMPERATURE) || 0.3,
  cmdTimeout: Number(process.env.CMD_TIMEOUT) || 8000,
  sessionTtl: Number(process.env.SESSION_TTL) || 30 * 60 * 1000,
  searchExtensions: (process.env.SEARCH_EXTENSIONS || "ts,tsx,js,jsx,py,go,rs,java,rb,php,swift,kt").split(",").map(e => e.trim()),
  excludeDirs: (process.env.EXCLUDE_DIRS || "node_modules,.git,dist,build,.next,vendor,__pycache__,.venv").split(",").map(d => d.trim()),
  maxCodeFiles: Number(process.env.MAX_CODE_FILES) || 8,
  maxKeywords: Number(process.env.MAX_KEYWORDS) || 6,
  maxFileHints: Number(process.env.MAX_FILE_HINTS) || 5,
};

// ─── Sessions with auto-cleanup ──────────────────────────────────────────────
const sessions = new Map();

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > CONFIG.sessionTtl) {
      sessions.delete(id);
    }
  }
}
setInterval(cleanupSessions, 60_000);

// ─── Lazy OpenAI client ──────────────────────────────────────────────────────
let _openai = null;
function getOpenAI(apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return null;
  if (!_openai || _openai.apiKey !== key) _openai = new OpenAI({ apiKey: key });
  return _openai;
}

// ─── Shell-safe command execution (no injection) ─────────────────────────────
function run(cmd, args = [], cwd) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      timeout: CONFIG.cmdTimeout,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd || process.cwd(),
    }).trim();
  } catch {
    return "";
  }
}

function gitRun(...args) {
  return run("git", args);
}

// ─── System prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert software engineer prompt enhancer.
Your only task: take a short/vague developer prompt and rewrite it into a very detailed, precise, structured, actionable prompt that will be given to a coding LLM (Claude).
Rules you MUST follow:
- Return ONLY the enhanced prompt text — nothing else
- No explanation, no preamble, no markdown, no "Here is the improved prompt:", no fences
- Make the prompt extremely clear and specific
- Include relevant project context when available (CLAUDE.md content, recently changed files)
- Reference exact file names, function names, classes, variables, error messages, edge cases, desired architecture/style, testing approach, performance considerations when they make sense
- When code snippets are provided, reference specific line numbers and function names from them
- Keep the enhanced prompt concise — do not pad it. Simple tasks should stay short, complex tasks can be longer.
- Use chain-of-thought style instructions when the task is complex
- Prefer step-by-step instructions over vague goals
- End the prompt with clear success criteria / acceptance tests
Input format you will receive:
Project context (CLAUDE.md if exists):
[CLAUDE.md content or empty]
Recently modified files or ticket info:
[context]
User prompt:
[short original prompt]
Output: ONLY the rewritten, detailed prompt`;

// ─── Linear ──────────────────────────────────────────────────────────────────
async function fetchLinearTicket(ticketId, apiKey) {
  const query = `
    query($identifier: String!) {
      issue(id: $identifier) {
        identifier title description priority
        branchName
        comments { nodes { body } }
        labels { nodes { name } }
      }
    }`;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables: { identifier: ticketId } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data.issue;
}

// ─── Code context helpers ────────────────────────────────────────────────────
function getCurrentBranch() {
  return gitRun("rev-parse", "--abbrev-ref", "HEAD");
}

function detectRepo() {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  const remote = gitRun("remote", "get-url", "origin") || gitRun("remote", "get-url", "upstream");
  if (!remote) return null;
  const match = remote.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function extractBranchFromText(text = "") {
  const patterns = [
    /\bcheckout\s+(?:-b\s+)?([a-zA-Z0-9/_-]+)/,
    /\bbranch[:\s]+([a-zA-Z0-9/_-]+)/i,
    /\bPR[:\s#]+\d+.*?([a-zA-Z0-9/_-]+)/i,
    /feature\/([a-zA-Z0-9/_-]+)/,
    /fix\/([a-zA-Z0-9/_-]+)/,
    /chore\/([a-zA-Z0-9/_-]+)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1] || m[0];
  }
  return null;
}

// ─── LLM-based extraction ────────────────────────────────────────────────────
async function extractContextWithLLM(ticketText, repoName = "") {
  const client = getOpenAI();
  if (!client || !ticketText) return { file_paths: [], keywords: [] };
  try {
    const repoHint = repoName ? `The repository is "${repoName}".` : "";
    const res = await client.chat.completions.create({
      model: CONFIG.extractorModel,
      max_tokens: 300,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{
        role: "system",
        content: `You are a code assistant analyzing a software ticket. Extract:
1. "file_paths": source file paths that likely ALREADY EXIST in the repo and are relevant to implementing this ticket.
   Rules:
   - INCLUDE any file that is referenced as something to modify, add to, or read as context
   - INCLUDE files whose existence would help understand how to implement the ticket
   - EXCLUDE files that are clearly example OUTPUT content of the endpoint/feature
   - Strip any repo name prefix from paths
2. "keywords": 4-8 technical terms to search the codebase for (function names, API route paths, variable names, endpoint paths).
${repoHint}
Return ONLY valid JSON: { "file_paths": [...], "keywords": [...] }`
      }, {
        role: "user",
        content: ticketText,
      }],
    });

    const raw = res.choices[0]?.message?.content;
    if (!raw) return { file_paths: [], keywords: [] };

    const parsed = JSON.parse(raw);
    const filePaths = Array.isArray(parsed.file_paths) ? parsed.file_paths : [];
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
    const repoBaseName = repoName ? repoName.split("/").pop() : "";

    return {
      file_paths: filePaths
        .filter(f => typeof f === "string" && f.includes(".") && f.length > 3)
        .map(f => repoBaseName && f.startsWith(repoBaseName + "/") ? f.slice(repoBaseName.length + 1) : f),
      keywords: keywords.filter(k => typeof k === "string" && k.length > 2),
    };
  } catch {
    return { file_paths: [], keywords: [] };
  }
}

// ─── Branch resolution ───────────────────────────────────────────────────────
function resolveBranch(explicitBranch, ticket) {
  if (explicitBranch) return { branch: explicitBranch, source: "explicit" };
  if (ticket?.branchName) return { branch: ticket.branchName, source: "linear" };
  const ticketText = `${ticket?.description || ""} ${(ticket?.comments?.nodes || []).map(c => c.body).join(" ")}`;
  const fromText = extractBranchFromText(ticketText);
  if (fromText) return { branch: fromText, source: "ticket-text" };
  const current = getCurrentBranch();
  if (current) return { branch: current, source: "current-local" };
  return { branch: null, source: "unknown" };
}

// ─── Safe path validation (prevents traversal) ──────────────────────────────
function safePath(filePath, baseDir) {
  const base = resolve(baseDir || process.cwd());
  const full = resolve(base, normalize(filePath));
  const rel = relative(base, full);
  if (rel.startsWith("..") || resolve(full) === resolve(base)) return null;
  return full;
}

function readLocalFile(filePath, branch) {
  if (branch) {
    const content = gitRun("show", `${branch}:${filePath}`);
    if (content) return { content, source: `git:${branch}` };
  }
  const fullPath = safePath(filePath);
  if (!fullPath) return null;
  if (existsSync(fullPath)) {
    const content = readFileSync(fullPath, "utf-8");
    return { content, source: "local" };
  }
  return null;
}

// ─── Relevant line extraction ────────────────────────────────────────────────
function extractRelevantLines(content, keywords = []) {
  const lines = content.split("\n");
  if (lines.length < 100) return { snippet: content, start_line: 1, end_line: lines.length };

  const matchedLines = new Set();
  for (const kw of keywords) {
    try {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      lines.forEach((l, i) => { if (re.test(l)) matchedLines.add(i); });
    } catch { /* skip invalid regex */ }
  }

  if (matchedLines.size === 0) {
    return { snippet: lines.slice(0, 60).join("\n"), start_line: 1, end_line: Math.min(60, lines.length) };
  }

  const sorted = [...matchedLines].sort((a, b) => a - b).slice(0, 3);
  const windows = [];
  for (const ln of sorted) {
    const s = Math.max(0, ln - 20);
    const e = Math.min(lines.length - 1, ln + 20);
    if (windows.length && s <= windows[windows.length - 1].e + 2) {
      windows[windows.length - 1].e = e;
    } else {
      windows.push({ s, e });
    }
  }

  const snippet = windows.map(w => lines.slice(w.s, w.e + 1).join("\n")).join("\n// ...\n");
  return { snippet, start_line: windows[0].s + 1, end_line: windows[windows.length - 1].e + 1 };
}

// ─── GitHub helpers ──────────────────────────────────────────────────────────
async function fetchGitHubFile(repo, filePath, branch, token, keywords = [], localBranch = null) {
  if (!token || !repo) return null;
  const [owner, repoName] = repo.split("/");
  const headers = { Authorization: `token ${token}`, Accept: "application/vnd.github.v3.raw" };

  const tryFetch = async (ref) => {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${filePath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return await res.text();
  };

  try {
    const refsToTry = [
      branch,
      localBranch && localBranch !== branch ? localBranch : null,
      "staging",
      "main",
      null,
    ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

    let content = null;
    let usedRef = null;
    for (const ref of refsToTry) {
      content = await tryFetch(ref);
      if (content) { usedRef = ref; break; }
    }
    if (!content) return null;

    const { snippet, start_line, end_line } = extractRelevantLines(content, keywords);
    const note = usedRef !== branch ? ` (used ${usedRef} — "${branch}" not found)` : "";
    return { content, snippet, start_line, end_line, source: `github:${repo}/${usedRef}${note}` };
  } catch {
    return null;
  }
}

async function searchGitHubCode(keywords, repo, token) {
  if (!token || !repo || !keywords.length) return [];
  const results = [];
  for (const kw of keywords.slice(0, 4)) {
    if (kw.length < 4) continue;
    try {
      const url = `https://api.github.com/search/code?q=${encodeURIComponent(kw)}+repo:${encodeURIComponent(repo)}&per_page=3`;
      const res = await fetch(url, {
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3.text-match+json" },
      });
      if (!res.ok) continue;
      const json = await res.json();
      for (const item of (json.items || [])) {
        const fp = item.path;
        if (results.some(r => r.file_path === fp)) continue;
        const file = await fetchGitHubFile(repo, fp, null, token, [kw]);
        if (file) {
          results.push({
            file_path: fp,
            start_line: file.start_line,
            end_line: file.end_line,
            snippet: file.snippet,
            source: `github-search:${repo}`,
            reason: `matches keyword "${kw}" (GitHub code search)`,
          });
        }
        if (results.length >= CONFIG.maxCodeFiles) return results;
      }
    } catch { /* skip failed searches */ }
  }
  return results;
}

// ─── Local grep (safe — uses execFileSync, no shell) ─────────────────────────
function grepLocalRepo(keywords) {
  const results = [];
  const extArgs = CONFIG.searchExtensions.flatMap(e => ["--include", `*.${e}`]);
  const excludeArgs = CONFIG.excludeDirs.flatMap(d => ["--exclude-dir", d]);

  for (const kw of keywords.slice(0, CONFIG.maxKeywords)) {
    if (kw.length < 4) continue;

    const files = run("grep", ["-rl", ...extArgs, ...excludeArgs, "--ignore-case", kw, process.cwd()]);
    for (const file of files.split("\n").filter(Boolean).slice(0, 3)) {
      if (results.some(r => r.file === file)) continue;

      const lineOut = run("grep", ["-n", "--ignore-case", kw, file]);
      if (!lineOut) continue;

      const firstMatch = lineOut.split("\n")[0];
      const lineNum = parseInt(firstMatch.split(":")[0], 10);
      const startLine = Math.max(1, lineNum - 5);
      const endLine = startLine + 20;

      // Read snippet with Node.js instead of sed (no shell needed)
      const fullPath = safePath(file.replace(process.cwd() + "/", ""));
      if (!fullPath || !existsSync(fullPath)) continue;
      const allLines = readFileSync(fullPath, "utf-8").split("\n");
      const snippet = allLines.slice(startLine - 1, endLine).join("\n");

      results.push({
        file_path: file.replace(process.cwd() + "/", ""),
        start_line: startLine,
        snippet,
        source: "local-grep",
        reason: `matches keyword "${kw}"`,
      });
      if (results.length >= CONFIG.maxCodeFiles) return results;
    }
  }
  return results;
}

// ─── Core routing & enhancement ──────────────────────────────────────────────
async function routeAndEnhance({ ticket_id, prompt, include_code_context, branch_name, local_branch, repo }) {
  const client = getOpenAI();
  if (!client) return { error: "OPENAI_API_KEY is not set." };

  repo = repo || detectRepo() || null;

  const result = {
    ticket_summary: null,
    branch: null,
    repo_context: [],
    assumptions: [],
    clarification_questions: [],
    execution_prompt: "",
  };

  let ticket = null;
  let ticketText = "";

  // ── Step 1: Fetch ticket ──
  if (ticket_id) {
    if (!process.env.LINEAR_API_KEY) return { error: "LINEAR_API_KEY is not set. Required for ticket lookup." };
    try {
      ticket = await fetchLinearTicket(ticket_id, process.env.LINEAR_API_KEY);
      if (!ticket) return { error: `Ticket "${ticket_id}" not found in Linear.` };
      const comments = (ticket.comments?.nodes || []).map(c => c.body).join("\n");
      ticketText = `${ticket.title} ${ticket.description || ""} ${comments}`;
      result.ticket_summary = {
        id: ticket.identifier,
        title: ticket.title,
        labels: (ticket.labels?.nodes || []).map(l => l.name),
        description: ticket.description || "",
        comments: (ticket.comments?.nodes || []).map(c => c.body),
      };
    } catch (err) {
      return { error: `Linear API error: ${err.message}` };
    }
  }

  // ── Step 2: Resolve branch ──
  const localBranch = local_branch || getCurrentBranch();
  const { branch, source: branchSource } = resolveBranch(branch_name, ticket);
  result.branch = branch;
  if (branch) {
    result.assumptions.push(`Branch resolved to "${branch}" (source: ${branchSource})`);
  } else {
    result.clarification_questions.push("Which branch should code context be read from?");
  }
  if (localBranch && localBranch !== branch) {
    result.assumptions.push(`Local branch: "${localBranch}" (GitHub fallback if ticket branch not found)`);
  }

  // ── Step 3: Gather code context ──
  if (include_code_context) {
    const githubToken = process.env.GITHUB_TOKEN;
    const githubAttempts = [];

    if (!repo && !gitRun("rev-parse", "--git-dir")) {
      result.clarification_questions.push("No local git repo found and no 'repo' provided. Which GitHub repo should be searched? (format: owner/repo)");
    }

    const { file_paths: fileHints, keywords } = await extractContextWithLLM(
      ticketText + (prompt ? `\nAdditional intent: ${prompt}` : ""),
      repo
    );
    result.assumptions.push(`LLM extracted ${fileHints.length} file hint(s) and ${keywords.length} keyword(s)`);

    // Fetch file hints in parallel for speed
    const fileHintResults = await Promise.allSettled(
      fileHints.slice(0, CONFIG.maxFileHints).map(async (hint) => {
        const local = readLocalFile(hint, branch);
        if (local) {
          const { snippet, start_line, end_line } = extractRelevantLines(local.content, keywords);
          return {
            file_path: hint, start_line, end_line, snippet,
            source: local.source,
            reason: "explicitly mentioned in ticket/prompt",
          };
        }
        if (repo || githubToken) {
          githubAttempts.push(`${repo}/${hint}@${branch || "default"}`);
          const gh = await fetchGitHubFile(repo, hint, branch, githubToken, keywords, localBranch);
          if (gh) {
            return {
              file_path: hint, start_line: gh.start_line, end_line: gh.end_line, snippet: gh.snippet,
              source: gh.source,
              reason: "explicitly mentioned in ticket/prompt (GitHub)",
            };
          }
        }
        return null;
      })
    );

    for (const r of fileHintResults) {
      if (r.status === "fulfilled" && r.value) result.repo_context.push(r.value);
    }

    // Fallback: need more context
    if (result.repo_context.length < 3) {
      const localRemote = detectRepo();
      const isInsideTargetRepo = localRemote && repo && localRemote === repo;
      if (isInsideTargetRepo) {
        const grepResults = grepLocalRepo(keywords);
        for (const r of grepResults) {
          if (!result.repo_context.some(x => x.file_path === r.file_path)) result.repo_context.push(r);
        }
        if (grepResults.length > 0) {
          result.assumptions.push(`Local keyword search found ${grepResults.length} file(s)`);
        }
      }

      if (result.repo_context.length < 3 && repo && githubToken) {
        const ghSearchResults = await searchGitHubCode(keywords, repo, githubToken);
        for (const r of ghSearchResults) {
          if (!result.repo_context.some(x => x.file_path === r.file_path)) result.repo_context.push(r);
        }
        if (ghSearchResults.length > 0) {
          result.assumptions.push(`GitHub code search found ${ghSearchResults.length} file(s) in ${repo}`);
        }
      }
    }

    if (githubAttempts.length > 0) {
      const fetched = result.repo_context.filter(r => r.source?.startsWith("github")).map(r => r.file_path);
      const failed = githubAttempts.filter(a => !fetched.some(f => a.includes(f)));
      if (fetched.length > 0) result.assumptions.push(`GitHub fetched: ${fetched.join(", ")} from ${repo}`);
      if (failed.length > 0) result.assumptions.push(`GitHub attempted but not found: ${failed.join(", ")}`);
    }
  }

  // ── Step 4: Build user message for GPT ──
  let claudeMdContent = "";
  const claudeMdPath = safePath("CLAUDE.md");
  if (claudeMdPath && existsSync(claudeMdPath)) {
    try { claudeMdContent = readFileSync(claudeMdPath, "utf-8"); } catch { /* ignore */ }
  }

  const recentFiles = gitRun("diff", "--name-only", "HEAD~3");

  const codeSection = result.repo_context.length
    ? result.repo_context.map(r => `File: ${r.file_path} (lines ${r.start_line}-${r.end_line}) [${r.source}]\nReason: ${r.reason}\n\`\`\`\n${r.snippet}\n\`\`\``).join("\n\n")
    : "";

  const ticketSection = ticket
    ? `Linear Ticket: ${ticket.identifier} — ${ticket.title}
Labels: ${result.ticket_summary.labels.join(", ") || "none"}
Description: ${ticket.description || "No description"}
Comments: ${result.ticket_summary.comments.join("\n") || "none"}`
    : "";

  const intentLine = prompt
    ? (ticket ? `${prompt}\n\nContext: ${ticket.identifier} — ${ticket.title}` : prompt)
    : (ticket ? `Resolve ${ticket.identifier}: ${ticket.title}` : "");

  const userMessage = `Project context (CLAUDE.md if exists):
${claudeMdContent}

Recently modified files:
${recentFiles || "none"}

${ticketSection}

${codeSection ? `Relevant code:\n${codeSection}` : ""}

User prompt:
${intentLine}`.trim();

  // ── Step 5: Call GPT ──
  try {
    const response = await client.chat.completions.create({
      model: CONFIG.enhancerModel,
      max_tokens: CONFIG.maxTokens,
      temperature: CONFIG.temperature,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMessage }],
    });
    result.execution_prompt = response.choices[0].message.content;
  } catch (err) {
    return { error: `OpenAI error: ${err.message}` };
  }

  return result;
}

// ─── Format output for Claude ────────────────────────────────────────────────
function formatOutput(result, preview) {
  if (result.error) return `Error: ${result.error}`;

  const lines = [];

  if (result.ticket_summary) {
    lines.push(`Ticket: ${result.ticket_summary.id} — ${result.ticket_summary.title}`);
    if (result.ticket_summary.labels.length) lines.push(`Labels: ${result.ticket_summary.labels.join(", ")}`);
  }
  if (result.branch) lines.push(`Branch: ${result.branch}`);
  if (result.assumptions.length) lines.push(`\nAssumptions:\n${result.assumptions.map(a => `• ${a}`).join("\n")}`);
  if (result.repo_context.length) {
    lines.push(`\nCode context gathered (${result.repo_context.length} file${result.repo_context.length > 1 ? "s" : ""}):`);
    result.repo_context.forEach(r => lines.push(`  • ${r.file_path}:${r.start_line} — ${r.reason} [${r.source}]`));
  }
  if (result.clarification_questions.length) {
    lines.push(`\nNeeds clarification:\n${result.clarification_questions.map(q => `? ${q}`).join("\n")}`);
    if (result.clarification_questions.length > 0 && !result.execution_prompt) return lines.join("\n");
  }

  lines.push(`\n${"─".repeat(60)}\nEnhanced prompt:\n\n${result.execution_prompt}`);

  if (preview) lines.push(`\n${"─".repeat(60)}\nProceed with this enhanced prompt? (yes / edit / cancel)`);

  return lines.join("\n");
}

// ─── Backward-compat helper ──────────────────────────────────────────────────
export async function enhancePrompt(originalPrompt) {
  const result = await routeAndEnhance({ prompt: originalPrompt });
  return result.error || result.execution_prompt;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "prompt-enhancer", version: "1.0.0" });

  server.tool(
    "enhance_prompt",
    "Takes a vague or short user prompt and rewrites it into a detailed, context-aware prompt. When preview is true (default): show the result and ask for confirmation before proceeding.",
    {
      prompt: z.string().describe("The short or vague prompt to enhance"),
      preview: z.boolean().optional().describe("If true (default), show the result and ask for confirmation."),
    },
    async ({ prompt, preview = true }) => {
      const enhanced = await enhancePrompt(prompt);
      const text = preview ? `PREVIEW — Enhanced prompt:\n\n${enhanced}\n\n---\nProceed with this enhanced prompt? (yes / edit / cancel)` : enhanced;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "enhance_from_ticket",
    "DEPRECATED: Use the 'enhance' tool instead — it supports code context, GitHub, and branch resolution. This tool only fetches a Linear ticket and generates a basic enhanced prompt without code context.",
    {
      ticket_id: z.string().describe("Linear ticket ID, e.g. SCL-112"),
      prompt: z.string().optional().describe("Optional additional intent to combine with ticket context"),
      preview: z.boolean().optional().describe("If true (default), show the result and ask for confirmation."),
    },
    async ({ ticket_id, prompt = "", preview = true }) => {
      const result = await routeAndEnhance({ ticket_id, prompt: prompt || undefined });
      const text = formatOutput(result, preview);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "enhance",
    `PRIMARY TOOL for all prompt enhancement. Use this tool whenever the user says "enhance", "use enhance", or wants a prompt improved.
Supports: prompt-only, Linear ticket-only, ticket+prompt, and optional real code context from local repo or GitHub.
When include_code_context is true:
  STEP 1 — Before calling this tool, run these two commands in the user's project directory:
    - git rev-parse --abbrev-ref HEAD  → pass result as local_branch
    - git remote get-url origin        → parse owner/repo from the GitHub URL, pass as repo
  STEP 2 — Tool fetches files from GitHub: ticket branch → local_branch → staging → main
When preview is true (default): show the full result and ask "Proceed with this enhanced prompt? (yes / edit / cancel)" before doing anything.`,
    {
      ticket_id: z.string().optional().describe("Linear ticket ID, e.g. SCL-112"),
      prompt: z.string().optional().describe("Vague or short user intent to enhance"),
      include_code_context: z.boolean().optional().describe("If true, gather relevant code from local repo or GitHub"),
      branch_name: z.string().optional().describe("Explicit branch to read code from (overrides auto-detection)"),
      local_branch: z.string().optional().describe("User's current git branch (run: git rev-parse --abbrev-ref HEAD in their project dir)"),
      repo: z.string().optional().describe("GitHub repo as owner/repo (run: git remote get-url origin in their project dir, then parse)"),
      preview: z.boolean().optional().describe("If true (default), show the result and ask for confirmation."),
    },
    async ({ ticket_id, prompt, include_code_context = false, branch_name, local_branch, repo, preview = true }) => {
      if (!ticket_id && !prompt) {
        return { content: [{ type: "text", text: "Error: provide at least one of ticket_id or prompt." }] };
      }
      const result = await routeAndEnhance({ ticket_id, prompt, include_code_context, branch_name, local_branch, repo });
      const text = formatOutput(result, preview);
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const SERVER_CARD = {
  serverInfo: { name: "prompt-enhancer", version: "1.0.0" },
  tools: [
    {
      name: "enhance",
      description: "PRIMARY TOOL. Transforms a short/vague prompt into a detailed, actionable prompt. Supports optional Linear ticket context and real code from GitHub or local git.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Short or vague user intent to enhance" },
          ticket_id: { type: "string", description: "Linear ticket ID, e.g. SCL-112" },
          include_code_context: { type: "boolean", description: "If true, fetch relevant code from local repo or GitHub" },
          branch_name: { type: "string", description: "Explicit branch to read code from" },
          local_branch: { type: "string", description: "User's current git branch" },
          repo: { type: "string", description: "GitHub repo as owner/repo" },
          preview: { type: "boolean", description: "If true (default), show result and ask for confirmation" },
        },
      },
    },
    {
      name: "enhance_prompt",
      description: "Simple prompt-only enhancement. Rewrites a short/vague prompt into a detailed, structured, actionable prompt.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The short or vague prompt to enhance" },
          preview: { type: "boolean", description: "If true (default), show result and ask for confirmation" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "enhance_from_ticket",
      description: "DEPRECATED: Use enhance instead. Fetches a Linear ticket and generates a basic enhanced prompt.",
      inputSchema: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Linear ticket ID, e.g. SCL-112" },
          prompt: { type: "string", description: "Optional additional intent" },
          preview: { type: "boolean", description: "If true (default), show result and ask for confirmation" },
        },
        required: ["ticket_id"],
      },
    },
  ],
};

const httpServer = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost`);
  const { pathname } = parsedUrl;

  if (pathname === "/health") { res.writeHead(200); res.end("OK"); return; }

  if (pathname === "/.well-known/mcp/server-card.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(SERVER_CARD));
    return;
  }

  if (pathname === "/mcp") {
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = parsedUrl.searchParams.get("openaiApiKey") || "";
    if (!process.env.LINEAR_API_KEY) process.env.LINEAR_API_KEY = parsedUrl.searchParams.get("linearApiKey") || "";
    if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = parsedUrl.searchParams.get("githubToken") || "";

    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.handleRequest(req, res);
      return;
    }
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId });
    const server = createMcpServer();
    await server.connect(transport);
    sessions.set(newSessionId, { server, transport, createdAt: Date.now() });
    transport.onclose = () => sessions.delete(newSessionId);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

httpServer.listen(CONFIG.port, () => console.log(`prompt-enhancer MCP server running on port ${CONFIG.port}`));
