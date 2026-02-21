import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { TaskQueue } from './queue.js';
import { ContainerManager } from './docker.js';
import { PlaneClient } from './plane-client.js';
import { SessionManager, InMemorySessionManager } from './agent-session.js';
export const app = new Hono();
app.use('*', logger());
let dispatcher = null;
let queue = null;
let containers = null;
let plane = null;
let webhookSecret = null;
let redisClient = null;
let sessionManager = null;
let staleCleanupTimer = null;
let botUserId = null; // Claude's Plane user ID for self-loop prevention
export function init(deps) {
    dispatcher = deps.dispatcher;
    queue = deps.queue;
    containers = deps.containers;
    plane = deps.plane;
    webhookSecret = deps.webhookSecret ?? null;
    redisClient = deps.redis ?? null;
    // Initialize session manager — use Redis if available, otherwise in-memory
    if (redisClient) {
        sessionManager = new SessionManager(redisClient);
        console.log('[session] Using Redis-backed session manager');
    }
    else {
        sessionManager = new InMemorySessionManager();
        console.log('[session] Using in-memory session manager (no Redis)');
    }
    // Stale session cleanup every 5 minutes
    staleCleanupTimer = setInterval(async () => {
        if (!sessionManager)
            return;
        const cleaned = await sessionManager.cleanupStaleSessions();
        if (cleaned > 0)
            console.log(`[session] Cleaned up ${cleaned} stale sessions`);
    }, 5 * 60 * 1000);
    // Load bot user ID from settings (set via admin or env)
    loadBotUserId().catch(() => { });
}
async function loadBotUserId() {
    botUserId = await getSetting('BOT_USER_ID') || process.env.BOT_USER_ID || null;
}
// Redis-backed settings store
function settingsKey(ws) { return `zenova:settings:${ws}`; }
function reposKey(ws) { return `zenova:repos:${ws}`; }
async function getSetting(key, ws = 'default') {
    if (!redisClient)
        return process.env[key] ?? '';
    const val = await redisClient.hget(settingsKey(ws), key);
    return val ?? process.env[key] ?? '';
}
async function getAllSettings(ws = 'default') {
    if (!redisClient)
        return {};
    return await redisClient.hgetall(settingsKey(ws)) ?? {};
}
async function setSetting(key, value, ws = 'default') {
    if (!redisClient)
        return;
    if (value) {
        await redisClient.hset(settingsKey(ws), key, value);
    }
    else {
        await redisClient.hdel(settingsKey(ws), key);
    }
}
async function getRepoForProject(projectId, ws = 'default') {
    if (!redisClient)
        return process.env.REPO_URL ?? '';
    const url = await redisClient.hget(reposKey(ws), projectId);
    return url ?? await getSetting('DEFAULT_REPO_URL', ws) ?? process.env.REPO_URL ?? '';
}
async function getAllRepos(ws = 'default') {
    if (!redisClient)
        return {};
    return await redisClient.hgetall(reposKey(ws)) ?? {};
}
async function setRepoForProject(projectId, url, ws = 'default') {
    if (!redisClient)
        return;
    if (url) {
        await redisClient.hset(reposKey(ws), projectId, url);
    }
    else {
        await redisClient.hdel(reposKey(ws), projectId);
    }
}
function verifyWebhookSignature(body, signature) {
    if (!webhookSecret)
        return true;
    if (!signature)
        return false;
    const expected = createHmac('sha256', webhookSecret).update(body).digest('hex');
    console.log(`[sig] received(${signature.length}): ${signature.slice(0, 16)}... expected(${expected.length}): ${expected.slice(0, 16)}...`);
    try {
        return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    }
    catch {
        return false;
    }
}
// ─── Workspace UUID → slug mapping ───────────────────────────────────────────
const workspaceSlugCache = new Map();
function getWorkspaceSlug(workspaceId) {
    // Check cache
    const cached = workspaceSlugCache.get(workspaceId);
    if (cached)
        return cached;
    // Check env var fallback
    const defaultSlug = process.env.WORKSPACE_SLUG || '';
    if (defaultSlug) {
        workspaceSlugCache.set(workspaceId, defaultSlug);
        return defaultSlug;
    }
    // If it looks like a slug already (no dashes in UUID format), return as-is
    if (!workspaceId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/))
        return workspaceId;
    return workspaceId; // fallback: use UUID (will fail, but logged)
}
// ─── Normalize Plane webhook comment payload ────────────────────────────────
function normalizeCommentPayload(data) {
    // Plane sends `issue` not `issue_id`
    if (!data.issue_id && data.issue) {
        data.issue_id = data.issue;
    }
    // Plane sends workspace UUID, not slug — resolve it
    if (data.workspace && data.workspace.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/)) {
        const slug = getWorkspaceSlug(data.workspace);
        console.log(`[normalize] workspace UUID ${data.workspace} → slug "${slug}"`);
        data.workspace = slug;
    }
    // Extract comment_stripped from comment_html if missing
    if (!data.comment_stripped && data.comment_html) {
        data.comment_stripped = data.comment_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // Resolve actor_detail from actor/created_by if missing
    if (!data.actor_detail && (data.actor || data.created_by)) {
        data.actor_detail = { id: data.actor || data.created_by || 'unknown', display_name: 'User' };
    }
    return data;
}
// ─── Self-loop prevention (3 layers) ────────────────────────────────────────
function isBotComment(comment) {
    // Layer 1: Check external_source tag (set by our own comments)
    if (comment.external_source === 'zenova-agent') {
        console.log('[loop-prevention] Skipping: external_source is zenova-agent');
        return true;
    }
    // Layer 2: Check actor ID against bot user
    if (botUserId && comment.actor_detail?.id === botUserId) {
        console.log('[loop-prevention] Skipping: actor is bot user');
        return true;
    }
    // Layer 3: Check content prefix patterns
    const text = comment.comment_stripped ?? comment.comment_html ?? '';
    if (text.startsWith('🤖 Claude') || text.startsWith('🤖 **Claude')) {
        console.log('[loop-prevention] Skipping: content starts with bot prefix');
        return true;
    }
    return false;
}
// ─── Webhook deduplication ──────────────────────────────────────────────────
async function isDuplicateWebhook(commentId) {
    if (!redisClient)
        return false;
    const key = `zenova:webhook-dedup:${commentId}`;
    const result = await redisClient.set(key, '1', 'EX', 60, 'NX');
    return !result; // null means key already existed = duplicate
}
// ─── Build secrets helper ───────────────────────────────────────────────────
async function buildSecrets(workspace, projectId) {
    const repoUrl = await getRepoForProject(projectId, workspace);
    return {
        GITHUB_TOKEN: await getSetting('GITHUB_TOKEN', workspace) || process.env.GITHUB_TOKEN || '',
        CLAUDE_CODE_OAUTH_TOKEN: await getSetting('CLAUDE_CODE_OAUTH_TOKEN', workspace) || process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
        ANTHROPIC_API_KEY: await getSetting('ANTHROPIC_API_KEY', workspace) || process.env.ANTHROPIC_API_KEY || '',
        PLANE_API_URL: process.env.PLANE_API_URL ?? '',
        PLANE_API_TOKEN: process.env.PLANE_API_TOKEN ?? '',
        REPO_URL: repoUrl,
    };
}
// ─── Comment handler (shared between webhook and debug) ─────────────────────
async function handleCommentEvent(comment, skipDedup = false) {
    // Debug: log the comment payload fields
    console.log(`[webhook] comment payload: issue_id=${comment.issue_id} project=${comment.project} workspace=${comment.workspace} issue=${comment.issue}`);
    // Self-loop prevention
    if (isBotComment(comment)) {
        return { dispatched: false, skipped: true, reason: 'bot comment (self-loop prevention)' };
    }
    // Webhook deduplication
    if (!skipDedup && await isDuplicateWebhook(comment.id)) {
        console.log(`[webhook] Duplicate webhook for comment ${comment.id}`);
        return { dispatched: false, skipped: true, reason: 'duplicate webhook' };
    }
    // Extract text
    const rawHtml = comment.comment_html ?? '';
    const stripped = comment.comment_stripped?.trim()
        || rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const text = stripped.toLowerCase();
    console.log(`[webhook] comment text: "${text.slice(0, 100)}"`);
    if (!plane)
        return { dispatched: false, error: 'not initialized' };
    // Check for follow-up: if there's an awaiting_input session for this issue
    if (sessionManager) {
        const awaitingSession = await sessionManager.getAwaitingSessionForIssue(comment.issue_id);
        if (awaitingSession) {
            console.log(`[webhook] Follow-up detected for session ${awaitingSession.id}`);
            const issueDetails = await plane.getIssue(comment.workspace, comment.project, comment.issue_id);
            const secrets = await buildSecrets(comment.workspace, comment.project);
            const { runAgent } = await import('./agent-runner.js');
            runAgent({
                commentData: comment,
                issueDetails,
                secrets,
                plane,
                sessionManager,
                mode: 'comment',
                followUpSessionId: awaitingSession.id,
            }).catch((err) => console.error('[follow-up-agent] error:', err));
            return { dispatched: true, mode: 'follow-up' };
        }
    }
    // Check for @claude mention
    if (!text.includes('@claude')) {
        return { dispatched: false, skipped: true, reason: 'no @claude mention' };
    }
    try {
        const issueDetails = await plane.getIssue(comment.workspace, comment.project, comment.issue_id);
        const secrets = await buildSecrets(comment.workspace, comment.project);
        const { isActionRequest } = await import('./agent-runner.js');
        const userQuestion = stripped.replace(/@claude\b/i, '').trim();
        const autonomous = isActionRequest(userQuestion);
        const mode = autonomous ? 'autonomous' : 'comment';
        if (sessionManager) {
            // Use new unified agent with sessions
            const { runAgent } = await import('./agent-runner.js');
            console.log(`[webhook] @claude → ${mode} mode (session-based)`);
            runAgent({
                commentData: comment,
                issueDetails,
                secrets,
                plane,
                sessionManager,
                mode,
            }).catch((err) => console.error(`[${mode}-agent] error:`, err));
        }
        else {
            // Fallback: no Redis, no sessions — use legacy path
            console.log(`[webhook] @claude → ${mode} mode (legacy, no Redis)`);
            const { runInlineAgent } = await import('./agent-runner.js');
            const task = {
                id: randomUUID(),
                issueId: comment.issue_id,
                projectId: comment.project,
                workspaceSlug: comment.workspace,
                agentType: 'claude',
                priority: 2,
                payload: issueDetails,
                queuedAt: new Date().toISOString(),
            };
            runInlineAgent(task, secrets, plane).catch((err) => console.error('[legacy-agent] error:', err));
        }
        return { dispatched: true, mode };
    }
    catch (err) {
        console.error('[comment-handler] setup error:', err);
        return { dispatched: false, error: String(err) };
    }
}
// ============================================================
// Static: Connect Wizard SPA
// ============================================================
app.get('/connect', (c) => c.redirect('/connect/index.html'));
app.use('/connect/*', serveStatic({ root: './public' }));
// ============================================================
// Debug routes (gated behind non-production)
// ============================================================
if (process.env.NODE_ENV !== 'production') {
    app.post('/debug/webhook', async (c) => {
        const rawBody = await c.req.text();
        let payload;
        try {
            payload = JSON.parse(rawBody);
        }
        catch {
            return c.json({ error: 'invalid JSON' }, 400);
        }
        console.log(`[debug-webhook] ${payload.event}.${payload.action}`);
        if ((payload.event === 'comment' || payload.event === 'issue_comment') && payload.action === 'created') {
            const comment = payload.data;
            const result = await handleCommentEvent(comment, /* skipDedup */ true);
            if (result.error)
                return c.json({ error: result.error }, result.error === 'not initialized' ? 503 : 500);
            return c.json(result);
        }
        return c.json({ skipped: true, reason: 'not a comment.created event' });
    });
    app.get('/debug/docker', async (c) => {
        const { existsSync } = await import('fs');
        const { execSync } = await import('child_process');
        const paths = ['/var/run/docker.sock', '/run/docker.sock'];
        const check = {};
        for (const p of paths) {
            check[p] = existsSync(p);
        }
        let ls = '';
        try {
            ls = execSync('ls -la /var/run/ /run/ 2>&1 | head -20').toString();
        }
        catch { }
        let claudeVersion = '';
        let claudePath = '';
        try {
            claudeVersion = execSync('claude --version 2>&1').toString().trim();
        }
        catch {
            claudeVersion = 'NOT FOUND';
        }
        try {
            claudePath = execSync('which claude 2>&1').toString().trim();
        }
        catch {
            claudePath = 'NOT FOUND';
        }
        return c.json({ socketPaths: check, ls, claudeVersion, claudePath });
    });
}
// ============================================================
// Proxy: validate Plane credentials (avoids browser CORS)
// ============================================================
app.post('/api/validate-plane', async (c) => {
    try {
        const { planeUrl, apiToken, workspaceSlug } = await c.req.json();
        if (!planeUrl || !apiToken || !workspaceSlug) {
            return c.json({ ok: false, error: 'planeUrl, apiToken, workspaceSlug required' }, 400);
        }
        const res = await fetch(`${planeUrl}/api/v1/workspaces/${workspaceSlug}/members/`, {
            headers: { 'X-API-Key': apiToken },
        });
        if (!res.ok)
            return c.json({ ok: false, error: `Plane returned ${res.status}` }, 400);
        return c.json({ ok: true });
    }
    catch (err) {
        return c.json({ ok: false, error: String(err) }, 400);
    }
});
// ============================================================
// Session API
// ============================================================
app.get('/api/sessions', async (c) => {
    if (!sessionManager)
        return c.json({ error: 'sessions not available (no Redis)' }, 503);
    const sessions = await sessionManager.getActiveSessions();
    return c.json({ sessions });
});
app.get('/api/sessions/:id', async (c) => {
    if (!sessionManager)
        return c.json({ error: 'sessions not available' }, 503);
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session)
        return c.json({ error: 'session not found' }, 404);
    return c.json({ session });
});
app.get('/api/sessions/:id/stream', async (c) => {
    if (!sessionManager)
        return c.json({ error: 'sessions not available' }, 503);
    const sessionId = c.req.param('id');
    const session = await sessionManager.getSession(sessionId);
    if (!session)
        return c.json({ error: 'session not found' }, 404);
    // SSE stream
    const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            const send = (data) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            };
            // Send current state
            send({ type: 'session', session });
            // Poll for updates
            let lastUpdate = session.updatedAt;
            const interval = setInterval(async () => {
                const updated = await sessionManager.getSession(sessionId);
                if (!updated) {
                    send({ type: 'error', message: 'session not found' });
                    clearInterval(interval);
                    controller.close();
                    return;
                }
                if (updated.updatedAt > lastUpdate) {
                    lastUpdate = updated.updatedAt;
                    send({ type: 'session', session: updated });
                }
                if (updated.state === 'complete' || updated.state === 'error') {
                    send({ type: 'done', state: updated.state });
                    clearInterval(interval);
                    controller.close();
                }
            }, 2000);
            // Auto-close after 10 minutes
            setTimeout(() => {
                clearInterval(interval);
                controller.close();
            }, 10 * 60 * 1000);
        },
    });
    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
});
// ============================================================
// Health & Status
// ============================================================
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/status', async (c) => {
    try {
        const activeSessions = sessionManager ? await sessionManager.getActiveSessions() : [];
        return c.json({
            running: containers?.getRunning() ?? [],
            queueDepth: await queue?.depth() ?? 0,
            activeSessions: activeSessions.map(s => ({
                id: s.id,
                issueId: s.issueId,
                state: s.state,
                mode: s.mode,
                triggeredBy: s.triggeredBy,
            })),
        });
    }
    catch (err) {
        return c.json({
            running: containers?.getRunning() ?? [],
            queueDepth: 0,
            activeSessions: [],
            error: 'session data unavailable',
        });
    }
});
// ============================================================
// Workspace Setup
// ============================================================
app.post('/setup', async (c) => {
    try {
        const body = await c.req.json();
        const { planeUrl, apiToken, workspaceSlug } = body;
        if (!planeUrl || !apiToken || !workspaceSlug) {
            return c.json({ ok: false, error: 'planeUrl, apiToken, workspaceSlug are required' }, 400);
        }
        const { bootstrapWorkspace } = await import('./setup.js');
        const protocol = c.req.header('x-forwarded-proto') ?? 'http';
        const host = c.req.header('host') ?? 'localhost:4000';
        const webhookUrl = `${protocol}://${host}/webhooks/plane`;
        const result = await bootstrapWorkspace({
            planeUrl, apiToken, workspaceSlug, webhookUrl, redis: redisClient,
        });
        return c.json({ ok: true, ...result });
    }
    catch (err) {
        return c.json({ ok: false, error: String(err) }, 400);
    }
});
// ============================================================
// Admin Settings Page
// ============================================================
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Zenova Agents — Settings</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh}
    .container{max-width:720px;margin:0 auto;padding:2rem 1.5rem}
    h1{font-size:1.5rem;font-weight:600;margin-bottom:.25rem;color:#fff}
    .subtitle{color:#888;margin-bottom:2rem;font-size:.875rem}
    .card{background:#161616;border:1px solid #262626;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
    .card h2{font-size:1rem;font-weight:600;margin-bottom:1rem;color:#fff;display:flex;align-items:center;gap:.5rem}
    .badge{font-size:.65rem;padding:2px 8px;border-radius:99px;font-weight:500}
    .badge-green{background:#052e16;color:#4ade80;border:1px solid #166534}
    .badge-yellow{background:#422006;color:#fbbf24;border:1px solid #854d0e}
    .badge-red{background:#450a0a;color:#f87171;border:1px solid #991b1b}
    .field{margin-bottom:1rem}
    .field:last-child{margin-bottom:0}
    label{display:block;font-size:.8rem;font-weight:500;color:#999;margin-bottom:.35rem}
    input,select{width:100%;padding:.6rem .75rem;background:#0a0a0a;border:1px solid #333;border-radius:8px;color:#fff;font-size:.875rem;outline:none;transition:border-color .15s}
    input:focus{border-color:#3b82f6}
    input::placeholder{color:#555}
    .hint{font-size:.75rem;color:#666;margin-top:.25rem}
    .hint a{color:#60a5fa;text-decoration:none}
    .hint a:hover{text-decoration:underline}
    .btn{display:inline-flex;align-items:center;gap:.5rem;padding:.6rem 1.25rem;border-radius:8px;font-size:.875rem;font-weight:500;border:none;cursor:pointer;transition:all .15s}
    .btn-primary{background:#3b82f6;color:#fff}.btn-primary:hover{background:#2563eb}
    .btn-secondary{background:#262626;color:#e5e5e5;border:1px solid #333}.btn-secondary:hover{background:#333}
    .actions{display:flex;gap:.75rem;margin-top:1rem;justify-content:flex-end}
    .status-bar{position:fixed;bottom:0;left:0;right:0;padding:.75rem;text-align:center;font-size:.85rem;transform:translateY(100%);transition:transform .3s;z-index:50}
    .status-bar.show{transform:translateY(0)}
    .status-bar.success{background:#052e16;color:#4ade80;border-top:1px solid #166534}
    .status-bar.error{background:#450a0a;color:#f87171;border-top:1px solid #991b1b}
    .repo-row{display:flex;gap:.5rem;align-items:end;margin-bottom:.75rem}
    .repo-row input{flex:1}
    .repo-row .btn{padding:.6rem}
    .divider{height:1px;background:#262626;margin:1.25rem 0}
    .running-list{font-size:.85rem;color:#999}
    .running-list .agent{padding:.5rem 0;border-bottom:1px solid #1a1a1a;display:flex;justify-content:space-between}
    .running-list .agent:last-child{border:none}
    .running-list .agent-name{color:#fff;font-weight:500}
  </style>
</head>
<body>
<div class="container">
  <h1>Zenova Agent Hub</h1>
  <p class="subtitle">Configure API keys, repos, and manage your AI agents</p>

  <div class="card" id="status-card">
    <h2>System Status <span class="badge badge-green" id="health-badge">Healthy</span></h2>
    <div class="running-list" id="running-list">Loading...</div>
  </div>

  <div class="card">
    <h2>Claude Authentication</h2>
    <div class="field">
      <label>Claude Code OAuth Token</label>
      <input type="password" id="CLAUDE_CODE_OAUTH_TOKEN" placeholder="sk-ant-oat01-...">
      <div class="hint">
        Uses your Claude Pro/Max subscription. Get this by running <code>claude setup-token</code> in your terminal
        (<a href="https://docs.anthropic.com/en/docs/claude-code/cli-usage" target="_blank">install Claude Code CLI</a> first: <code>npm i -g @anthropic-ai/claude-code</code>).
      </div>
    </div>
    <div class="divider"></div>
    <div class="field">
      <label>Anthropic API Key (alternative — pay-per-use)</label>
      <input type="password" id="ANTHROPIC_API_KEY" placeholder="sk-ant-api03-...">
      <div class="hint">From <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>. Billed separately from subscription.</div>
    </div>
  </div>

  <div class="card">
    <h2>Google Gemini</h2>
    <div class="field">
      <label>Gemini API Key</label>
      <input type="password" id="GEMINI_API_KEY" placeholder="AIza...">
      <div class="hint">For the creative agent (image generation). Get from <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>.</div>
    </div>
  </div>

  <div class="card">
    <h2>GitHub</h2>
    <div class="field">
      <label>GitHub Personal Access Token</label>
      <input type="password" id="GITHUB_TOKEN" placeholder="ghp_...">
      <div class="hint">Agents use this to clone repos and create PRs. Create at <a href="https://github.com/settings/tokens?type=beta" target="_blank">github.com/settings/tokens</a> with repo access.</div>
    </div>
  </div>

  <div class="card">
    <h2>Self-Loop Prevention</h2>
    <div class="field">
      <label>Bot User ID (Plane User ID for Claude)</label>
      <input type="text" id="BOT_USER_ID" placeholder="uuid-of-claude-bot-user">
      <div class="hint">If Claude uses a dedicated Plane account, set its user ID here to prevent it from responding to its own comments.</div>
    </div>
  </div>

  <div class="card">
    <h2>Repository Mapping</h2>
    <p class="hint" style="margin-bottom:1rem">Map each Plane project to a GitHub repo. Agents will clone and push to the correct repo per project.</p>
    <div class="field">
      <label>Default Repo URL (used when no project mapping exists)</label>
      <input type="text" id="DEFAULT_REPO_URL" placeholder="https://github.com/your-org/your-repo">
    </div>
    <div class="divider"></div>
    <label>Per-Project Repos</label>
    <div id="repo-list"></div>
    <button class="btn btn-secondary" onclick="addRepoRow()">+ Add Project Mapping</button>
  </div>

  <div class="actions">
    <button class="btn btn-primary" onclick="saveAll()">Save Settings</button>
  </div>
</div>

<div class="status-bar" id="status-bar"></div>

<script>
const SETTINGS_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','GEMINI_API_KEY','GITHUB_TOKEN','DEFAULT_REPO_URL','BOT_USER_ID'];

async function loadSettings() {
  const res = await fetch('/admin/api/settings');
  const data = await res.json();
  for (const key of SETTINGS_KEYS) {
    const el = document.getElementById(key);
    if (el && data.settings[key]) el.value = data.settings[key];
  }
  const repoList = document.getElementById('repo-list');
  repoList.innerHTML = '';
  if (data.repos && Object.keys(data.repos).length > 0) {
    for (const [projectId, url] of Object.entries(data.repos)) {
      addRepoRow(projectId, url);
    }
  }
}

async function loadStatus() {
  try {
    const res = await fetch('/status');
    const data = await res.json();
    const badge = document.getElementById('health-badge');
    badge.textContent = 'Healthy';
    badge.className = 'badge badge-green';
    const list = document.getElementById('running-list');
    const parts = [];
    if (data.running.length > 0) {
      parts.push(data.running.map(r =>
        '<div class="agent"><span class="agent-name">' + r.agentType + '</span><span>' + r.issueId + '</span></div>'
      ).join(''));
    }
    if (data.activeSessions && data.activeSessions.length > 0) {
      parts.push(data.activeSessions.map(s =>
        '<div class="agent"><span class="agent-name">Session: ' + s.mode + '</span><span>' + s.state + ' (' + s.triggeredBy + ')</span></div>'
      ).join(''));
    }
    if (parts.length === 0) {
      list.innerHTML = '<div style="color:#666">No agents running. Queue depth: ' + data.queueDepth + '</div>';
    } else {
      list.innerHTML = parts.join('');
    }
  } catch {
    document.getElementById('health-badge').textContent = 'Error';
    document.getElementById('health-badge').className = 'badge badge-red';
  }
}

function addRepoRow(projectId, url) {
  const div = document.createElement('div');
  div.className = 'repo-row';
  div.innerHTML = '<input type="text" placeholder="Plane Project ID" value="' + (projectId||'') + '" class="repo-project">' +
    '<input type="text" placeholder="https://github.com/org/repo" value="' + (url||'') + '" class="repo-url">' +
    '<button class="btn btn-secondary" onclick="this.parentElement.remove()">X</button>';
  document.getElementById('repo-list').appendChild(div);
}

async function saveAll() {
  const settings = {};
  for (const key of SETTINGS_KEYS) {
    const el = document.getElementById(key);
    if (el) settings[key] = el.value;
  }
  const repos = {};
  document.querySelectorAll('.repo-row').forEach(row => {
    const pid = row.querySelector('.repo-project').value.trim();
    const url = row.querySelector('.repo-url').value.trim();
    if (pid && url) repos[pid] = url;
  });
  try {
    const res = await fetch('/admin/api/settings', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ settings, repos })
    });
    const data = await res.json();
    showStatus(data.ok ? 'Settings saved!' : 'Error saving', data.ok ? 'success' : 'error');
  } catch (e) {
    showStatus('Failed to save: ' + e.message, 'error');
  }
}

function showStatus(msg, type) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className = 'status-bar show ' + type;
  setTimeout(() => bar.className = 'status-bar', 3000);
}

loadSettings();
loadStatus();
setInterval(loadStatus, 10000);
</script>
</body>
</html>`;
app.get('/admin', (c) => c.html(ADMIN_HTML));
app.get('/admin/api/settings', async (c) => {
    const settings = await getAllSettings();
    // Mask sensitive values for display
    const masked = {};
    for (const [k, v] of Object.entries(settings)) {
        if (v && v.length > 8 && (k.includes('TOKEN') || k.includes('KEY') || k.includes('SECRET'))) {
            masked[k] = v.slice(0, 6) + '...' + v.slice(-4);
        }
        else {
            masked[k] = v;
        }
    }
    const repos = await getAllRepos();
    return c.json({ settings: masked, repos });
});
app.post('/admin/api/settings', async (c) => {
    try {
        const body = await c.req.json();
        const { settings, repos } = body;
        if (settings) {
            for (const [k, v] of Object.entries(settings)) {
                // Don't overwrite with masked values
                if (v && !v.includes('...')) {
                    await setSetting(k, v);
                }
            }
        }
        if (repos) {
            // Clear existing and set new
            if (redisClient)
                await redisClient.del(reposKey('default'));
            for (const [projectId, url] of Object.entries(repos)) {
                await setRepoForProject(projectId, url);
            }
        }
        // Reload bot user ID after settings save
        await loadBotUserId();
        return c.json({ ok: true });
    }
    catch (err) {
        return c.json({ ok: false, error: String(err) }, 500);
    }
});
app.get('/admin/api/settings/:workspace', async (c) => {
    const ws = c.req.param('workspace');
    const settings = await getAllSettings(ws);
    const masked = {};
    for (const [k, v] of Object.entries(settings)) {
        if (v && v.length > 8 && (k.includes('TOKEN') || k.includes('KEY') || k.includes('SECRET'))) {
            masked[k] = v.slice(0, 6) + '...' + v.slice(-4);
        }
        else {
            masked[k] = v;
        }
    }
    const repos = await getAllRepos(ws);
    return c.json({ settings: masked, repos });
});
app.post('/admin/api/settings/:workspace', async (c) => {
    const ws = c.req.param('workspace');
    try {
        const { settings, repos } = await c.req.json();
        if (settings) {
            for (const [k, v] of Object.entries(settings)) {
                if (v && !v.includes('...'))
                    await setSetting(k, v, ws);
            }
        }
        if (repos) {
            if (redisClient)
                await redisClient.del(reposKey(ws));
            for (const [pid, url] of Object.entries(repos))
                await setRepoForProject(pid, url, ws);
        }
        return c.json({ ok: true });
    }
    catch (err) {
        return c.json({ ok: false, error: String(err) }, 500);
    }
});
// ============================================================
// Webhook Handler
// ============================================================
app.post('/webhooks/plane', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('x-plane-signature') ?? c.req.header('x-webhook-signature');
    if (!verifyWebhookSignature(rawBody, signature ?? null)) {
        return c.json({ error: 'invalid signature' }, 401);
    }
    const payload = JSON.parse(rawBody);
    console.log(`[webhook] ${payload.event}.${payload.action}`);
    console.log(`[webhook] raw data keys: ${Object.keys(payload.data || {}).join(', ')}`);
    const _d = payload.data ?? {};
    console.log(`[webhook] data.issue_id=${_d.issue_id} data.issue=${_d.issue} data.project=${_d.project} data.workspace=${_d.workspace} data.workspace_detail=${JSON.stringify(_d.workspace_detail)?.slice(0, 100)}`);
    // ── Comment event: check for @claude mention ───────────────────────────────
    if ((payload.event === 'comment' || payload.event === 'issue_comment') && payload.action === 'created') {
        const comment = normalizeCommentPayload(payload.data);
        const result = await handleCommentEvent(comment);
        if (result.error === 'not initialized')
            return c.json({ error: result.error }, 503);
        if (result.error)
            return c.json({ error: result.error }, 500);
        return c.json(result);
    }
    // ── End comment handler ────────────────────────────────────────────────────
    // ── Issue update: check for assignment trigger ─────────────────────────────
    if (payload.event === 'issue' && payload.action === 'updated' && botUserId) {
        const issue = payload.data;
        if (issue.assignees?.includes(botUserId)) {
            console.log(`[webhook] Claude assigned to issue ${issue.id}`);
            if (plane && sessionManager) {
                // Check if there's already an active session
                const existing = await sessionManager.getActiveSessionForIssue(issue.id);
                if (!existing) {
                    const secrets = await buildSecrets(issue.workspace, issue.project);
                    const syntheticComment = {
                        id: `assign-${randomUUID()}`,
                        issue: issue.id,
                        issue_id: issue.id,
                        project: issue.project,
                        workspace: issue.workspace,
                        comment_stripped: `@claude Work on this issue based on the description.`,
                        comment_html: `<p>@claude Work on this issue based on the description.</p>`,
                        actor_detail: { id: 'system', display_name: 'Assignment' },
                    };
                    const { runAgent } = await import('./agent-runner.js');
                    runAgent({
                        commentData: syntheticComment,
                        issueDetails: issue,
                        secrets,
                        plane,
                        sessionManager,
                        mode: 'autonomous',
                    }).catch((err) => console.error('[assignment-agent] error:', err));
                    return c.json({ dispatched: true, mode: 'assignment-trigger' });
                }
            }
        }
    }
    // ── End assignment trigger ─────────────────────────────────────────────────
    if (!dispatcher || !queue || !containers)
        return c.json({ error: 'not initialized' }, 503);
    const match = dispatcher.shouldDispatch(payload);
    if (!match)
        return c.json({ skipped: true, reason: 'no matching agent' });
    const { agentConfig, priority } = match;
    const task = {
        id: randomUUID(), issueId: payload.data.id, projectId: payload.data.project,
        workspaceSlug: payload.data.workspace, agentType: agentConfig.name,
        priority, payload: payload.data, queuedAt: new Date().toISOString(),
    };
    if (plane) {
        try {
            await plane.addComment(payload.data.workspace, payload.data.project, payload.data.id, `Agent ${agentConfig.name} picked up this issue.`);
        }
        catch (err) {
            console.error('[plane] Failed to post comment:', err);
        }
    }
    const running = containers.getRunningCount(agentConfig.name);
    if (running >= agentConfig.maxConcurrency) {
        await queue.enqueue(task);
        console.log(`[queue] Task ${task.id} queued (${agentConfig.name} at capacity)`);
        return c.json({ queued: true, taskId: task.id });
    }
    // Build secrets from Redis settings + env fallbacks
    const repoUrl = await getRepoForProject(task.projectId, task.workspaceSlug);
    const secrets = {
        GITHUB_TOKEN: await getSetting('GITHUB_TOKEN', task.workspaceSlug) || process.env.GITHUB_TOKEN || '',
        CLAUDE_CODE_OAUTH_TOKEN: await getSetting('CLAUDE_CODE_OAUTH_TOKEN', task.workspaceSlug) || process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
        ANTHROPIC_API_KEY: await getSetting('ANTHROPIC_API_KEY', task.workspaceSlug) || process.env.ANTHROPIC_API_KEY || '',
        GEMINI_API_KEY: await getSetting('GEMINI_API_KEY', task.workspaceSlug) || process.env.GEMINI_API_KEY || '',
        PLANE_API_URL: process.env.PLANE_API_URL ?? '',
        PLANE_API_TOKEN: process.env.PLANE_API_TOKEN ?? '',
        REPO_URL: repoUrl,
    };
    // Try Docker first; fall back to inline Anthropic API if socket unavailable
    const { existsSync: fsExistsSync } = await import('fs');
    const dockerAvailable = fsExistsSync('/var/run/docker.sock') || fsExistsSync('/run/docker.sock');
    if (!dockerAvailable) {
        console.log(`[dispatch] Docker unavailable — running ${agentConfig.name} inline via Anthropic API`);
        const { runInlineAgent } = await import('./agent-runner.js');
        runInlineAgent(task, secrets, plane).catch(err => console.error(`[agent] Inline agent error:`, err));
        return c.json({ dispatched: true, taskId: task.id, mode: 'inline' });
    }
    const containerId = await containers.runAgent(agentConfig, task, secrets);
    console.log(`[dispatch] Agent ${agentConfig.name} started: ${containerId}`);
    return c.json({ dispatched: true, taskId: task.id, containerId });
});
export default app;
// Ensure claude CLI is available at startup (install if missing)
{
    const { execSync, spawnSync } = await import('child_process');
    const check = spawnSync('claude', ['--version'], { stdio: 'ignore' });
    if (check.error || check.status !== 0) {
        console.log('[startup] claude CLI not found — installing @anthropic-ai/claude-code globally...');
        try {
            execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'inherit' });
            console.log('[startup] claude CLI installed successfully');
        }
        catch (e) {
            console.error('[startup] WARNING: failed to install claude CLI:', e);
        }
    }
    else {
        console.log('[startup] claude CLI found:', spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout?.trim());
    }
}
// Server startup when run directly
const isMainModule = !process.argv[1] || process.argv[1].includes('index');
if (isMainModule && process.env.NODE_ENV !== 'test') {
    const { serve } = await import('@hono/node-server');
    const { default: Dockerode } = await import('dockerode');
    const { default: Redis } = await import('ioredis');
    const { loadAgentConfigs, Dispatcher: DispatcherClass } = await import('./config.js');
    const port = parseInt(process.env.PORT || '4000');
    let redis = null;
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
        try {
            redis = new Redis(redisUrl, {
                maxRetriesPerRequest: 3,
                retryStrategy: (times) => {
                    if (times > 5) {
                        console.log('[redis] Max retries reached, giving up. Using in-memory session manager.');
                        return null; // stop retrying
                    }
                    return Math.min(times * 500, 3000);
                },
                lazyConnect: true,
            });
            await redis.connect();
            console.log('[redis] Connected successfully');
        }
        catch (err) {
            console.log(`[redis] Connection failed: ${err}. Using in-memory session manager.`);
            redis = null;
        }
    }
    else {
        console.log('[redis] No REDIS_URL configured. Using in-memory session manager.');
    }
    const { existsSync } = await import('fs');
    const socketPath = process.env.DOCKER_SOCKET ||
        (existsSync('/var/run/docker.sock') ? '/var/run/docker.sock' :
            existsSync('/run/docker.sock') ? '/run/docker.sock' : '/var/run/docker.sock');
    console.log(`[docker] Using socket: ${socketPath} (exists: ${existsSync(socketPath)})`);
    const docker = new Dockerode({ socketPath });
    const agents = loadAgentConfigs(process.env.AGENTS_CONFIG || './config/agents.yaml');
    const planeClient = new PlaneClient(process.env.PLANE_API_URL || 'http://localhost:8000', process.env.PLANE_API_TOKEN || '');
    init({
        dispatcher: new DispatcherClass(agents),
        queue: redis ? new TaskQueue(redis) : { enqueue: async () => { }, dequeue: async () => null, depth: async () => 0, peek: async () => [] },
        containers: new ContainerManager(docker),
        plane: planeClient,
        webhookSecret: process.env.WEBHOOK_SECRET,
        redis: redis ?? undefined,
    });
    serve({ fetch: app.fetch, port }, () => {
        console.log(`Orchestrator listening on port ${port}`);
        console.log(`Admin panel: http://localhost:${port}/admin`);
    });
}
