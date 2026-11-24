import { useEffect, useState } from 'react'
import { welcomeGreeting } from './greeting'

export function useWelcomeGreeting() {
  const [hour, setHour] = useState(() => new Date().getHours())

  useEffect(() => {
    let timer: number
    const update = () => {
      window.clearTimeout(timer)
      const now = new Date()
      setHour(now.getHours())
      const nextHour = new Date(now)
      nextHour.setHours(now.getHours() + 1, 0, 0, 0)
      timer = window.setTimeout(update, nextHour.getTime() - now.getTime())
    }
    const restoreVisibility = () => {
      if (document.visibilityState === 'visible') update()
    }

    update()
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', restoreVisibility)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', restoreVisibility)
    }
  }, [])

  return {
    title: welcomeGreeting(hour),
    note: hour >= 22 || hour < 5 ? '夜深了，还在工作嘛？' : '',
  }
}
