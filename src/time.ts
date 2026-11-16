/** "たった今", "5 分前", "3 時間前", "昨日", "4 日前", "11月2日", "2025年11月2日". */
export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'たった今'
  if (s < 3600) return `${Math.floor(s / 60)} 分前`
  const d = new Date(ms)
  const today = new Date(now)
  const days = Math.round((startOfDay(today) - startOfDay(d)) / 86400_000)
  if (days === 0) return `${Math.floor(s / 3600)} 時間前`
  if (days === 1) return '昨日'
  if (days < 7) return `${days} 日前`
  return d.getFullYear() === today.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Full date and time, for a tooltip next to a relative time. */
export const fullTime = (ms: number) => new Date(ms).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })
