// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { Brand } from './Brand'
import { version } from '../../package.json'

afterEach(cleanup)

test('测试版品牌显示包中声明的产品版本', () => {
  render(<Brand showVersion />)
  expect(screen.getByText(`v${version}`)).toBeTruthy()
})
