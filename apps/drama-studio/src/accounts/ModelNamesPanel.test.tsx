import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ModelsPanel } from './ModelsPanel'
import { loadCurrentUser } from './api'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('root 保存品牌入口后重新打开仍读取已保存的名字，并通知模型选择器刷新', async () => {
  let models = [{ id: 'brand-text', kind: 'text', provider: 'writer', model: 'internal-writer', display_name: '原写作名', visible: true }, { id: 'brand-image', kind: 'image', provider: 'images', model: 'internal-image', display_name: '原生图名', visible: true }]
  const targets = [{ provider: 'writer', provider_name: '写作接入', models: ['internal-writer', 'new-writer'], image_models: [] }, { provider: 'images', provider_name: '生图接入', models: [], image_models: ['internal-image'] }]
  const changed = vi.fn()
  window.addEventListener('studio:models-changed', changed)
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/studio/auth/me') return Response.json({ user: { id: 'root', role: 'super_admin' }, csrfToken: 'fixture' })
    if (url === '/studio/admin/models') return Response.json({ endpoints: [] })
    if (url === '/studio/admin/model-names') {
      if (init?.method === 'POST') { expect(init.headers).toMatchObject({ 'X-Studio-CSRF': 'fixture' }); models = JSON.parse(String(init.body)).models }
      return Response.json({ models, targets })
    }
    throw new Error('未实现的测试接口')
  })
  await loadCurrentUser()
  const view = render(<ModelsPanel />)
  await screen.findByLabelText('brand-text 的前端名称')
  fireEvent.click(screen.getByRole('combobox', { name: '原写作名的后台模型' }))
  fireEvent.click(screen.getByRole('option', { name: '写作接入 · new-writer' }))
  fireEvent.click(screen.getByRole('button', { name: '保存品牌入口' }))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  view.unmount()
  render(<ModelsPanel />)
  expect((await screen.findByLabelText('brand-text 的前端名称') as HTMLInputElement).value).toBe('原写作名')
  expect((screen.getByLabelText('brand-image 的前端名称') as HTMLInputElement).value).toBe('原生图名')
  expect(models[0]).toMatchObject({ id: 'brand-text', model: 'new-writer', display_name: '原写作名', visible: true })
  window.removeEventListener('studio:models-changed', changed)
  await act(async () => {})
})
