import { expect, test } from 'vitest'
import { clampPaneWidth, paneWidthFromPointer } from './resizable-pane'

test('右侧面板宽度限制在可用范围并随左边界拖动计算', () => {
  expect(clampPaneWidth(100, 1280)).toBe(240)
  expect(clampPaneWidth(800, 1280)).toBe(560)
  expect(clampPaneWidth(800, 700)).toBe(340)
  expect(paneWidthFromPointer(900, 1280)).toBe(380)
})
