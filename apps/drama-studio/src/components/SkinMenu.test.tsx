import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { SkinMenu } from './SkinMenu'
import { SKINS, applySkin, introduceYaoye, storedSkin } from '../lib/skins'

afterEach(() => { cleanup(); localStorage.clear(); applySkin('default') })

test('选择皮肤后页面与本浏览器保存的选择一致，菜单标出当前皮肤；明暗主题不受影响', () => {
  document.documentElement.dataset.theme = 'dark'
  render(<SkinMenu />)
  fireEvent.click(screen.getByRole('button', { name: '切换皮肤' }))
  expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(SKINS.map(skin => expect.stringContaining(skin.name)))
  fireEvent.click(screen.getByRole('menuitemradio', { name: /稿纸/ }))
  expect(document.documentElement.dataset.skin).toBe('paper')
  expect(storedSkin()).toBe('paper')
  expect(document.documentElement.dataset.theme).toBe('dark')
  fireEvent.click(screen.getByRole('button', { name: '切换皮肤' }))
  expect(screen.getByRole('menuitemradio', { name: /稿纸/ }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('menuitemradio', { name: /经典/ }))
  expect(document.documentElement.dataset.skin).toBeUndefined()
})

test('本浏览器里保存的是未知皮肤时回到默认样式', () => {
  localStorage.setItem('drama-studio:skin', 'removed-skin')
  expect(storedSkin()).toBe('default')
})

test('曜夜首次引导只切皮肤、不改明暗主题：没选过主题的浏览器保持默认浅色', () => {
  localStorage.setItem('drama-studio:theme', 'light')
  introduceYaoye()
  expect(storedSkin()).toBe('yaoye')
  expect(localStorage.getItem('drama-studio:theme')).toBe('light')
  localStorage.clear()
  introduceYaoye()
  expect(localStorage.getItem('drama-studio:theme')).toBeNull()
})
