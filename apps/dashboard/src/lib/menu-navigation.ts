export function nextIndex(key: string, current: number, disabled: boolean[]): number {
  const count = disabled.length
  if (count === 0) return current

  if (key === 'Home' || key === 'End') {
    for (let offset = 0; offset < count; offset++) {
      const index = key === 'Home' ? offset : count - 1 - offset
      if (!disabled[index]) return index
    }
    return current
  }

  if (key !== 'ArrowDown' && key !== 'ArrowUp') return current

  const direction = key === 'ArrowDown' ? 1 : -1
  for (let offset = 1; offset <= count; offset++) {
    const index = ((current + direction * offset) % count + count) % count
    if (!disabled[index]) return index
  }
  return current
}

export function typeaheadIndex(query: string, labels: string[], current: number): number {
  if (query === '') return -1

  const search = query.toLowerCase()
  for (let offset = 1; offset <= labels.length; offset++) {
    const index = ((current + offset) % labels.length + labels.length) % labels.length
    if (labels[index].toLowerCase().startsWith(search)) return index
  }
  return -1
}
