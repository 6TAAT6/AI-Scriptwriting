const greetingPeriods = [
  { start: 18, text: '晚上好' },
  { start: 14, text: '下午好' },
  { start: 12, text: '中午好' },
  { start: 9, text: '上午好' },
  { start: 5, text: '早上好' },
]

export function welcomeGreeting(hour = new Date().getHours()): string {
  const period = greetingPeriods.find(period => hour >= period.start)?.text ?? '晚上好'
  return `${period}，开始创作吧！`
}
