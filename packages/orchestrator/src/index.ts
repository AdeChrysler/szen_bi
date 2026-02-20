import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serveStatic } from '@hono/node-server/serve-static'
import { randomUUID, createHmac, timingSafeEqual } from 'crypto'
import type { PlaneWebhookPayload, QueuedTask } from './types.js'
import { Dispatcher } from './config.js'
import { TaskQueue } from './queue.js'
import { ContainerManager } from './docker.js'
import { PlaneClient } from './plane-client.js'

export const app = new Hono()
app.use('*', logger())

let dispatcher: Dispatcher | null = null
let queue: TaskQueue | null = null
let containers: ContainerManager | null = null
let plane: PlaneClient | null = null
let webhookSecret: string | null = null
let redisClient: any = null

export function init(deps: {
  dispatcher: Dispatcher
  queue: TaskQueue
  containers: ContainerManager
  plane: PlaneClient
  webhookSecret?: string
  redis?: any
}) {
  dispatcher = deps.dispatcher
  queue = deps.queue
  containers = deps.containers
  plane = deps.plane
  webhookSecret = deps.webhookSecret ?? null
  redisClient = deps.redis ?? null
}

// Redis-backed settings store
function settingsKey(ws: string) { return `zenova:settings:${ws}` }
function reposKey(ws: string) { return `zenova:repos:${ws}` }

async function getSetting(key: string, ws = 'default'): Promise<string> {
  if (!redisClient) return process.env[key] ?? ''
  const val = await redisClient.hget(settingsKey(ws), key)
  return val ?? process.env[key] ?? ''
}

async function getAllSettings(ws = 'default'): Promise<Record<string, string>> {
  if (!redisClient) return {}
  return await redisClient.hgetall(settingsKey(ws)) ?? {}
}

async function setSetting(key: string, value: string, ws = 'default'): Promise<void> {
  if (!redisClient) return
  if (value) { await redisClient.hset(settingsKey(ws), key, value) }
  else { await redisClient.hdel(settingsKey(ws), key) }
}

async function getRepoForProject(projectId: string, ws = 'default'): Promise<string> {
  if (!redisClient) return process.env.REPO_URL ?? ''
  const url = await redisClient.hget(reposKey(ws), projectId)
  return url ?? await getSetting('DEFAULT_REPO_URL', ws) ?? process.env.REPO_URL ?? ''
}

async function getAllRepos(ws = 'default'): Promise<Record<string, string>> {
  if (!redisClient) return {}
  return await redisClient.hgetall(reposKey(ws)) ?? {}
}

async function setRepoForProject(projectId: string, url: string, ws = 'default'): Promise<void> {
  if (!redisClient) return
  if (url) { await redisClient.hset(reposKey(ws), projectId, url) }
  else { await redisClient.hdel(reposKey(ws), projectId) }
}

function verifyWebhookSignature(body: string, signature: string | null): boolean {
  if (!webhookSecret) return true
  if (!signature) return false
  const expected = createHmac('sha256', webhookSecret).update(body).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

// ============================================================
// Static: Connect Wizard SPA
// ============================================================

app.get('/connect', (c) => c.redirect('/connect/index.html'))
app.use('/connect/*', serveStatic({ root: './public' }))

// ============================================================
// Debug: docker socket diagnostics
// ============================================================

app.get('/debug/docker', async (c) => {
  const { existsSync } = await import('fs')
  const { execSync } = await import('child_process')
  const paths = ['/var/run/docker.sock', '/run/docker.sock']
  const check: Record<string, any> = {}
  for (const p of paths) {
    check[p] = existsSync(p)
  }
  let ls = ''
  try { ls = execSync('ls -la /var/run/ /run/ 2>&1 | head -20').toString() } catch {}
  return c.json({ socketPaths: check, ls })
})

// ============================================================
// Proxy: validate Plane credentials (avoids browser CORS)
// ============================================================

app.post('/api/validate-plane', async (c) => {
  try {
    const { planeUrl, apiToken, workspaceSlug } = await c.req.json()
    if (!planeUrl || !apiToken || !workspaceSlug) {
      return c.json({ ok: false, error: 'planeUrl, apiToken, workspaceSlug required' }, 400)
    }
    const res = await fetch(`${planeUrl}/api/v1/workspaces/${workspaceSlug}/members/`, {
      headers: { 'X-API-Key': apiToken },
    })
    if (!res.ok) return c.json({ ok: false, error: `Plane returned ${res.status}` }, 400)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 400)
  }
})

// ============================================================
// Health & Status
// ============================================================

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('/status', async (c) => c.json({ running: containers?.getRunning() ?? [], queueDepth: await queue?.depth() ?? 0 }))

// ============================================================
// Workspace Setup
// ============================================================

app.post('/setup', async (c) => {
  try {
    const body = await c.req.json() as {
      planeUrl?: string
      apiToken?: string
      workspaceSlug?: string
    }
    const { planeUrl, apiToken, workspaceSlug } = body
    if (!planeUrl || !apiToken || !workspaceSlug) {
      return c.json({ ok: false, error: 'planeUrl, apiToken, workspaceSlug are required' }, 400)
    }
    const { bootstrapWorkspace } = await import('./setup.js')
    const protocol = c.req.header('x-forwarded-proto') ?? 'http'
    const host = c.req.header('host') ?? 'localhost:4000'
    const webhookUrl = `${protocol}://${host}/webhooks/plane`
    const result = await bootstrapWorkspace({
      planeUrl, apiToken, workspaceSlug, webhookUrl, redis: redisClient,
    })
    return c.json({ ok: true, ...result })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 400)
  }
})


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
const SETTINGS_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','GEMINI_API_KEY','GITHUB_TOKEN','DEFAULT_REPO_URL'];

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
    if (data.running.length === 0) {
      list.innerHTML = '<div style="color:#666">No agents running. Queue depth: ' + data.queueDepth + '</div>';
    } else {
      list.innerHTML = data.running.map(r =>
        '<div class="agent"><span class="agent-name">' + r.agentType + '</span><span>' + r.issueId + '</span></div>'
      ).join('');
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
</html>`

app.get('/admin', (c) => c.html(ADMIN_HTML))

app.get('/admin/api/settings', async (c) => {
  const settings = await getAllSettings()
  // Mask sensitive values for display
  const masked: Record<string, string> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (v && v.length > 8 && (k.includes('TOKEN') || k.includes('KEY') || k.includes('SECRET'))) {
      masked[k] = v.slice(0, 6) + '...' + v.slice(-4)
    } else {
      masked[k] = v
    }
  }
  const repos = await getAllRepos()
  return c.json({ settings: masked, repos })
})

app.post('/admin/api/settings', async (c) => {
  try {
    const body = await c.req.json()
    const { settings, repos } = body as { settings: Record<string, string>; repos: Record<string, string> }
    if (settings) {
      for (const [k, v] of Object.entries(settings)) {
        // Don't overwrite with masked values
        if (v && !v.includes('...')) {
          await setSetting(k, v)
        }
      }
    }
    if (repos) {
      // Clear existing and set new
      if (redisClient) await redisClient.del(reposKey('default'))
      for (const [projectId, url] of Object.entries(repos)) {
        await setRepoForProject(projectId, url)
      }
    }
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500)
  }
})

app.get('/admin/api/settings/:workspace', async (c) => {
  const ws = c.req.param('workspace')
  const settings = await getAllSettings(ws)
  const masked: Record<string, string> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (v && v.length > 8 && (k.includes('TOKEN') || k.includes('KEY') || k.includes('SECRET'))) {
      masked[k] = v.slice(0, 6) + '...' + v.slice(-4)
    } else { masked[k] = v }
  }
  const repos = await getAllRepos(ws)
  return c.json({ settings: masked, repos })
})

app.post('/admin/api/settings/:workspace', async (c) => {
  const ws = c.req.param('workspace')
  try {
    const { settings, repos } = await c.req.json() as { settings: Record<string, string>; repos: Record<string, string> }
    if (settings) {
      for (const [k, v] of Object.entries(settings)) {
        if (v && !v.includes('...')) await setSetting(k, v, ws)
      }
    }
    if (repos) {
      if (redisClient) await redisClient.del(reposKey(ws))
      for (const [pid, url] of Object.entries(repos)) await setRepoForProject(pid, url, ws)
    }
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500)
  }
})

// ============================================================
// Webhook Handler
// ============================================================

app.post('/webhooks/plane', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-plane-signature') ?? c.req.header('x-webhook-signature')

  if (!verifyWebhookSignature(rawBody, signature ?? null)) {
    return c.json({ error: 'invalid signature' }, 401)
  }

  const payload: PlaneWebhookPayload = JSON.parse(rawBody)
  console.log(`[webhook] ${payload.event}.${payload.action}`)
  if (!dispatcher || !queue || !containers) return c.json({ error: 'not initialized' }, 503)

  const match = dispatcher.shouldDispatch(payload)
  if (!match) return c.json({ skipped: true, reason: 'no matching agent' })

  const { agentConfig, priority } = match
  const task: QueuedTask = {
    id: randomUUID(), issueId: payload.data.id, projectId: payload.data.project,
    workspaceSlug: payload.data.workspace, agentType: agentConfig.name,
    priority, payload: payload.data, queuedAt: new Date().toISOString(),
  }

  if (plane) {
    try {
      await plane.addComment(
        payload.data.workspace, payload.data.project, payload.data.id,
        `Agent ${agentConfig.name} picked up this issue.`
      )
    } catch (err) {
      console.error('[plane] Failed to post comment:', err)
    }
  }

  const running = containers.getRunningCount(agentConfig.name)
  if (running >= agentConfig.maxConcurrency) {
    await queue.enqueue(task)
    console.log(`[queue] Task ${task.id} queued (${agentConfig.name} at capacity)`)
    return c.json({ queued: true, taskId: task.id })
  }

  // Build secrets from Redis settings + env fallbacks
  const repoUrl = await getRepoForProject(task.projectId, task.workspaceSlug)
  const secrets = {
    GITHUB_TOKEN: await getSetting('GITHUB_TOKEN', task.workspaceSlug) || process.env.GITHUB_TOKEN || '',
    CLAUDE_CODE_OAUTH_TOKEN: await getSetting('CLAUDE_CODE_OAUTH_TOKEN', task.workspaceSlug) || process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
    ANTHROPIC_API_KEY: await getSetting('ANTHROPIC_API_KEY', task.workspaceSlug) || process.env.ANTHROPIC_API_KEY || '',
    GEMINI_API_KEY: await getSetting('GEMINI_API_KEY', task.workspaceSlug) || process.env.GEMINI_API_KEY || '',
    PLANE_API_URL: process.env.PLANE_API_URL ?? '',
    PLANE_API_TOKEN: process.env.PLANE_API_TOKEN ?? '',
    REPO_URL: repoUrl,
  }
  // Try Docker first; fall back to inline Anthropic API if socket unavailable
  const { existsSync: fsExistsSync } = await import('fs')
  const dockerAvailable = fsExistsSync('/var/run/docker.sock') || fsExistsSync('/run/docker.sock')

  if (!dockerAvailable) {
    console.log(`[dispatch] Docker unavailable — running ${agentConfig.name} inline via Anthropic API`)
    const { runInlineAgent } = await import('./agent-runner.js')
    runInlineAgent(task, secrets, plane!).catch(err =>
      console.error(`[agent] Inline agent error:`, err)
    )
    return c.json({ dispatched: true, taskId: task.id, mode: 'inline' })
  }

  const containerId = await containers.runAgent(agentConfig, task, secrets)
  console.log(`[dispatch] Agent ${agentConfig.name} started: ${containerId}`)

  return c.json({ dispatched: true, taskId: task.id, containerId })
})

export default app

// Server startup when run directly
const isMainModule = !process.argv[1] || process.argv[1].includes('index')
if (isMainModule && process.env.NODE_ENV !== 'test') {
  const { serve } = await import('@hono/node-server')
  const { default: Dockerode } = await import('dockerode')
  const { default: Redis } = await import('ioredis')
  const { loadAgentConfigs, Dispatcher: DispatcherClass } = await import('./config.js')

  const port = parseInt(process.env.PORT || '4000')
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  const { existsSync } = await import('fs')
  const socketPath = process.env.DOCKER_SOCKET ||
    (existsSync('/var/run/docker.sock') ? '/var/run/docker.sock' :
     existsSync('/run/docker.sock') ? '/run/docker.sock' : '/var/run/docker.sock')
  console.log(`[docker] Using socket: ${socketPath} (exists: ${existsSync(socketPath)})`)
  const docker = new Dockerode({ socketPath })
  const agents = loadAgentConfigs(process.env.AGENTS_CONFIG || './config/agents.yaml')
  const planeClient = new PlaneClient(
    process.env.PLANE_API_URL || 'http://localhost:8000',
    process.env.PLANE_API_TOKEN || ''
  )

  init({
    dispatcher: new DispatcherClass(agents),
    queue: new TaskQueue(redis),
    containers: new ContainerManager(docker),
    plane: planeClient,
    webhookSecret: process.env.WEBHOOK_SECRET,
    redis,
  })

  serve({ fetch: app.fetch, port }, () => {
    console.log(`Orchestrator listening on port ${port}`)
    console.log(`Admin panel: http://localhost:${port}/admin`)
  })
}
