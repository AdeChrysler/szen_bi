import { useState } from 'react'
import StepConnect from './steps/StepConnect'
import StepConfigure from './steps/StepConfigure'
import StepDone from './steps/StepDone'

export interface SetupState {
  planeUrl: string
  apiToken: string
  workspaceSlug: string
  webhookId?: string
  webhookSecret?: string
}

const STEPS = ['Connect', 'Configure', 'Done'] as const

export default function App() {
  const [step, setStep] = useState(0)
  const [state, setState] = useState<SetupState>({ planeUrl: '', apiToken: '', workspaceSlug: '' })

  const merge = (patch: Partial<SetupState>) => setState(s => ({ ...s, ...patch }))

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-white mb-1">Zenova Agents</h1>
          <p className="text-zinc-400 text-sm">Connect AI agents to your Plane workspace</p>
        </div>

        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold
                ${i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-blue-500 text-white' : 'bg-zinc-800 text-zinc-500'}`}>
                {i < step ? '✓' : i + 1}
              </div>
              <span className={`text-sm ${i === step ? 'text-white' : 'text-zinc-500'}`}>{label}</span>
              {i < STEPS.length - 1 && <div className="w-8 h-px bg-zinc-700 mx-1" />}
            </div>
          ))}
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          {step === 0 && <StepConnect state={state} merge={merge} onNext={() => setStep(1)} />}
          {step === 1 && <StepConfigure state={state} merge={merge} onNext={() => setStep(2)} />}
          {step === 2 && <StepDone state={state} />}
        </div>
      </div>
    </div>
  )
}
