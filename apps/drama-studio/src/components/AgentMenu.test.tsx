import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { Composer } from './Composer'
import { workspace } from '../store/workspace'
import { CAPABILITIES } from '../lib/capabilities'

afterEach(() => { cleanup(); workspace.reset() })

test('/调用列出创作能力，选择规则不改变模型且不发送消息', () => {
  workspace.reset()
  workspace.editComposer({ text: '/调用' })
  workspace.session.set({ runtimeId: '', storedId: '', info: { model: 'chosen-model' } })
  render(<Composer />)
  expect(screen.getAllByRole('option').map(row => row.querySelector('strong')?.textContent)).toEqual(CAPABILITIES.map(row => row.display_name))
  fireEvent.click(screen.getByRole('option', { name: /巨豹 Agent1-适配巨豹满血版 V1.1/ }))
  expect(workspace.composer.get().capabilityCommands?.[0].capability.id).toBe('gm3-1')
  expect(workspace.session.get().info.model).toBe('chosen-model')
  expect(workspace.conversation.get().entries).toEqual([])
})
