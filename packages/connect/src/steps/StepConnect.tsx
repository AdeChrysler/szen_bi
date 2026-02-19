import { useState } from 'react'
import type { SetupState } from '../App'

interface Props {
  state: SetupState
  merge: (p: Partial<SetupState>) => void
  onNext: () => void
}

export default function StepConnect({ state, merge, onNext }: Props) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function validate() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${state.planeUrl}/api/v1/workspaces/${state.workspaceSlug}/members/`, {
        headers: { 'X-API-Key': state.apiToken },
      })
      if (!res.ok) throw new Error(`Plane returned ${res.status} — check URL and token`)
      onNext()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Connect to Plane</h2>
        <p className="text-sm text-zinc-400">Enter your self-hosted Plane URL and API token to get started.</p>
      </div>
      <Field label="Plane URL" placeholder="https://plane.yourdomain.com" value={state.planeUrl}
        onChange={v => merge({ planeUrl: v.replace(/\/$/, '') })} />
      <Field label="Workspace Slug" placeholder="my-workspace"
        hint="Found in your Plane URL: plane.io/<slug>/..."
        value={state.workspaceSlug} onChange={v => merge({ workspaceSlug: v })} />
      <Field label="API Token" type="password" placeholder="plane_api_..."
        hint="Settings → API Tokens in Plane"
        value={state.apiToken} onChange={v => merge({ apiToken: v })} />
      {error && <p className="text-sm text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">{error}</p>}
      <button
        onClick={validate}
        disabled={loading || !state.planeUrl || !state.apiToken || !state.workspaceSlug}
        className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
      >
        {loading ? 'Validating...' : 'Validate & Continue →'}
      </button>
    </div>
  )
}

function Field({ label, placeholder, value, onChange, type = 'text', hint }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; type?: string; hint?: string
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 focus:border-blue-500 rounded-lg text-white placeholder-zinc-600 outline-none transition-colors text-sm" />
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  )
}
