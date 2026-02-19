import { useState } from 'react'
import type { SetupState } from '../App'

interface Props {
  state: SetupState
  merge: (p: Partial<SetupState>) => void
  onNext: () => void
}

const AVAILABLE_AGENTS = [
  { id: 'dev', label: 'Dev Agent', desc: 'Writes code, creates PRs, handles engineering tasks' },
  { id: 'creative', label: 'Creative Agent', desc: 'Generates images, visuals, and creative assets' },
  { id: 'strategy', label: 'Strategy Agent', desc: 'Writes plans, docs, and strategic content' },
  { id: 'landing', label: 'Landing Agent', desc: 'Builds marketing pages and web content' },
]

export default function StepConfigure({ state, merge, onNext }: Props) {
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['dev'])
  const [githubToken, setGithubToken] = useState('')
  const [claudeToken, setClaudeToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<string[]>([])

  function toggleAgent(id: string) {
    setSelectedAgents(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id])
  }

  async function runSetup() {
    setError('')
    setLoading(true)
    setProgress([])
    try {
      setProgress(p => [...p, 'Connecting to orchestrator...'])
      const res = await fetch('/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planeUrl: state.planeUrl, apiToken: state.apiToken, workspaceSlug: state.workspaceSlug }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
      setProgress(p => [...p, `✓ Webhook registered (ID: ${data.webhookId})`])
      if (githubToken || claudeToken) {
        setProgress(p => [...p, 'Saving API keys...'])
        await fetch(`/admin/api/settings/${state.workspaceSlug}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            settings: {
              ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
              ...(claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}),
            },
            repos: {},
          }),
        })
        setProgress(p => [...p, '✓ API keys saved'])
      }
      merge({ webhookId: data.webhookId, webhookSecret: data.webhookSecret })
      setProgress(p => [...p, '✓ Setup complete!'])
      setTimeout(onNext, 800)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Configure Agents</h2>
        <p className="text-sm text-zinc-400">Choose which agents to enable and add your API keys.</p>
      </div>
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2">Enable agents</label>
        <div className="space-y-2">
          {AVAILABLE_AGENTS.map(a => (
            <label key={a.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
              ${selectedAgents.includes(a.id) ? 'border-blue-500 bg-blue-950/30' : 'border-zinc-700 hover:border-zinc-600'}`}>
              <input type="checkbox" checked={selectedAgents.includes(a.id)} onChange={() => toggleAgent(a.id)}
                className="mt-0.5 accent-blue-500" />
              <div>
                <div className="text-sm font-medium text-white">{a.label}</div>
                <div className="text-xs text-zinc-400">{a.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">GitHub Token</label>
          <input type="password" value={githubToken} onChange={e => setGithubToken(e.target.value)}
            placeholder="ghp_..." className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 focus:border-blue-500 rounded-lg text-white placeholder-zinc-600 outline-none text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Claude OAuth Token</label>
          <input type="password" value={claudeToken} onChange={e => setClaudeToken(e.target.value)}
            placeholder="sk-ant-oat01-..." className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 focus:border-blue-500 rounded-lg text-white placeholder-zinc-600 outline-none text-sm" />
          <p className="mt-1 text-xs text-zinc-500">Run <code className="text-zinc-300">claude setup-token</code> in terminal to get this</p>
        </div>
      </div>
      {progress.length > 0 && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-1">
          {progress.map((p, i) => <p key={i} className="text-xs text-zinc-300 font-mono">{p}</p>)}
        </div>
      )}
      {error && <p className="text-sm text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">{error}</p>}
      <button onClick={runSetup} disabled={loading || selectedAgents.length === 0}
        className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors">
        {loading ? 'Setting up...' : 'Run Setup →'}
      </button>
    </div>
  )
}
