import { useEffect, useRef } from 'react'
import { mountLoginWave } from './login-wave.mjs'
import './LoginBackdrop.css'

export function LoginBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => mountLoginWave(canvasRef.current!), [])
  return <canvas ref={canvasRef} className="login-backdrop" aria-hidden="true" />
}
