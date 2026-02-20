import { describe, it, expect } from 'vitest'
import { isActionRequest } from '../agent-runner.js'

describe('isActionRequest', () => {
  it('returns true for action verbs', () => {
    expect(isActionRequest('implement the login feature')).toBe(true)
    expect(isActionRequest('fix the null pointer error')).toBe(true)
    expect(isActionRequest('build a new API endpoint')).toBe(true)
    expect(isActionRequest('refactor the payment module')).toBe(true)
    expect(isActionRequest('write tests for auth')).toBe(true)
    expect(isActionRequest('work on this issue')).toBe(true)
    expect(isActionRequest('debug the crash')).toBe(true)
    expect(isActionRequest('review this PR')).toBe(true)
  })

  it('returns false for Q&A verbs', () => {
    expect(isActionRequest('explain the acceptance criteria')).toBe(false)
    expect(isActionRequest('what does this issue mean?')).toBe(false)
    expect(isActionRequest('how should I approach this?')).toBe(false)
    expect(isActionRequest('list all the tasks')).toBe(false)
    expect(isActionRequest('describe the requirements')).toBe(false)
    expect(isActionRequest('')).toBe(false)
    expect(isActionRequest('what is the review process?')).toBe(false)
    expect(isActionRequest('please update me on the status')).toBe(false)
    expect(isActionRequest('can you test my understanding?')).toBe(false)
    expect(isActionRequest('how do I add this feature?')).toBe(false)
  })
})
