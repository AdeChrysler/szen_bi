import type { SetupState } from '../App'

export default function StepDone({ state }: { state: SetupState }) {
  const planeUrl = `${state.planeUrl}/${state.workspaceSlug}/settings/members/`

  return (
    <div className="text-center space-y-5">
      <div className="w-16 h-16 bg-emerald-500/20 border border-emerald-500/30 rounded-full flex items-center justify-center mx-auto text-3xl">
        ✅
      </div>
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">Agents are ready!</h2>
        <p className="text-sm text-zinc-400">
          Your Plane workspace is now connected to Zenova Agents.
          Assign any issue to an agent user to get started.
        </p>
      </div>
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 text-left space-y-2">
        <p className="text-xs font-medium text-zinc-300 uppercase tracking-wide">How to use</p>
        <ol className="text-sm text-zinc-400 space-y-2 list-decimal list-inside">
          <li>Go to your Plane workspace</li>
          <li>Create or open an issue</li>
          <li>Assign it to <code className="text-emerald-400">@dev-agent</code>, <code className="text-emerald-400">@creative-agent</code>, etc.</li>
          <li>Watch the agent post activity in the issue comments</li>
          <li>Review and merge the PR when it is ready</li>
        </ol>
      </div>
      <a href={planeUrl} target="_blank" rel="noopener noreferrer"
        className="block w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors">
        Open Plane Workspace →
      </a>
      <a href="/admin" className="block text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
        View agent dashboard
      </a>
    </div>
  )
}
