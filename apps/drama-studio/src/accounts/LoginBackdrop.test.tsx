import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { LoginBackdrop } from './LoginBackdrop'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function animationSurface() {
  let hidden = false, reduced = false, sequence = 0
  const pending = new Map<number, FrameRequestCallback>()
  const media = new EventTarget()
  Object.defineProperty(media, 'matches', { get: () => reduced })
  vi.stubGlobal('matchMedia', () => media)
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++sequence; pending.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pending.delete(id) })
  const brush = { clearRect: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    createRadialGradient: () => ({ addColorStop: vi.fn() }), drawImage: vi.fn(), fillRect: vi.fn(), globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1 }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(brush as unknown as CanvasRenderingContext2D)
  return { pending, brush, step(time: number) { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(time)) },
    hide(value: boolean) { hidden = value; document.dispatchEvent(new Event('visibilitychange')) },
    reduce(value: boolean) { reduced = value; media.dispatchEvent(new Event('change')) } }
}

test('登录背景随页面可见性与减少动态效果设置停帧，恢复后仍可响应鼠标', () => {
  const surface = animationSurface()
  const view = render(<main><LoginBackdrop /><input aria-label="账号" /></main>)
  expect(surface.pending.size).toBe(1)
  const host = view.container.querySelector('main')!
  const move = () => fireEvent.pointerMove(host, { clientX: 120, clientY: 100, pointerType: 'mouse' })
  move()
  expect(surface.pending.size).toBe(1)
  const initialDraws = surface.brush.clearRect.mock.calls.length
  act(() => surface.step(performance.now() + 40))
  expect(surface.brush.clearRect.mock.calls.length).toBeGreaterThan(initialDraws)
  expect(surface.pending.size).toBe(1)
  act(() => surface.hide(true))
  expect(surface.pending.size).toBe(0)
  const hiddenDraws = surface.brush.clearRect.mock.calls.length
  move(); fireEvent(window, new Event('resize'))
  expect(surface.pending.size).toBe(0)
  expect(surface.brush.clearRect.mock.calls.length).toBe(hiddenDraws)
  act(() => surface.hide(false))
  move()
  expect(surface.pending.size).toBe(1)
  act(() => surface.reduce(true))
  expect(surface.pending.size).toBe(0)
  move()
  expect(surface.pending.size).toBe(0)
  act(() => surface.reduce(false))
  move()
  expect(surface.pending.size).toBe(1)
})

test('登录背景卸载清除帧与事件，输入及鼠标事件保持可用', () => {
  const surface = animationSurface()
  const clicked = vi.fn()
  const view = render(<main><LoginBackdrop /><button onClick={clicked}>登录</button></main>)
  const host = view.container.querySelector('main')!
  fireEvent.click(view.getByRole('button', { name: '登录' }))
  expect(clicked).toHaveBeenCalledOnce()
  fireEvent.pointerMove(host, { clientX: 120, clientY: 100, pointerType: 'mouse' })
  expect(surface.pending.size).toBe(1)
  view.unmount()
  expect(surface.pending.size).toBe(0)
  const draws = surface.brush.clearRect.mock.calls.length
  host.dispatchEvent(new Event('pointermove')); window.dispatchEvent(new Event('resize'))
  surface.hide(false); surface.reduce(false)
  expect(surface.pending.size).toBe(0)
  expect(surface.brush.clearRect.mock.calls.length).toBe(draws)
})
