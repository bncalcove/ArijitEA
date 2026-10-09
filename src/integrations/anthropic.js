// AI provider. AI_PROVIDER=auto (default) picks, in order:
//   1. api        — ANTHROPIC_API_KEY is set → Anthropic SDK
//   2. claude-cli — Claude Code is installed and logged in → `claude -p` (no API key needed)
//   3. off        — rule-based fallbacks in ai/extract.js and ai/classify.js
import Anthropic from '@anthropic-ai/sdk';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

// ---------- provider selection ----------
function findClaudeCli() {
  if (process.env.CLAUDE_CLI_PATH) return fs.existsSync(process.env.CLAUDE_CLI_PATH) ? process.env.CLAUDE_CLI_PATH : null;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const hit = execFileSync(cmd, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).find(Boolean);
    if (hit) return hit.trim();
  } catch { /* not on PATH */ }
  // Binary bundled with the VS Code extension; pick the newest installed version.
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const dirs = fs.readdirSync(extDir).filter(d => d.startsWith('anthropic.claude-code-'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
      const p = path.join(extDir, d, 'resources', 'native-binary', exe);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no extensions dir */ }
  return null;
}

let cliPath;
export function aiProvider() {
  const want = (process.env.AI_PROVIDER || 'auto').toLowerCase();
  if (want === 'off') return 'off';
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (want === 'api') return hasKey ? 'api' : 'off';
  if (want === 'auto' && hasKey) return 'api';
  // Re-scan if the extension auto-updated and the old path disappeared.
  if (!cliPath || !fs.existsSync(cliPath)) cliPath = findClaudeCli();
  return cliPath ? 'claude-cli' : 'off';
}

export const aiEnabled = () => aiProvider() !== 'off';

/**
 * One structured-output call. `system` is stable; `user` is the volatile part.
 * Returns the parsed JSON object that matches `schema`.
 */
export async function callJSON({ system, user, schema, effort = 'medium', maxTokens = 16000 }) {
  const provider = aiProvider();
  if (provider === 'api') return callApi({ system, user, schema, effort, maxTokens });
  if (provider === 'claude-cli') return callCli({ system, user, schema, effort });
  throw new Error('No AI provider available');
}

// ---------- Anthropic API ----------
let client;
async function callApi({ system, user, schema, effort, maxTokens }) {
  client ??= new Anthropic();
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    // Re-run on Anthropic's recommended fallback model if a safety classifier declines.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`Model declined (${res.stop_details?.category ?? 'unknown'})`);
  if (res.stop_reason === 'max_tokens') throw new Error('Model output hit max_tokens before finishing the JSON');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

// ---------- Claude Code CLI (uses the logged-in Claude account) ----------
const MAX_PARALLEL = 2;
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_PARALLEL) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

function callCli({ system, user, schema, effort }) {
  return withSlot(() => new Promise((resolve, reject) => {
    const args = [
      '-p', '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--system-prompt', system,
      '--model', MODEL,
      '--effort', effort,
      '--tools', '',                 // pure text task: no file/shell/web access
      '--strict-mcp-config',         // no MCP servers
      '--setting-sources', '',       // ignore user/project settings and hooks
      '--no-session-persistence',
    ];
    const child = execFile(cliPath, args, {
      cwd: os.tmpdir(), // keep the project's CLAUDE.md out of this call
      timeout: 240_000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      let out;
      try { out = JSON.parse(stdout); } catch {
        return reject(new Error(`Claude CLI failed: ${(stderr || err?.message || stdout).toString().slice(0, 300)}`));
      }
      if (out.is_error || out.subtype !== 'success') {
        return reject(new Error(`Claude CLI error: ${String(out.result || out.subtype).slice(0, 300)}${/log ?in|auth/i.test(out.result) ? ' — run `claude` once and log in' : ''}`));
      }
      if (out.structured_output) return resolve(out.structured_output);
      try { resolve(JSON.parse(out.result)); } catch { reject(new Error('Claude CLI returned no structured output')); }
    });
    child.stdin.end(user);
  }));
}
