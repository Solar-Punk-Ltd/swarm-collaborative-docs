const CURSOR_COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#a8dadc', '#457b9d', '#c77dff', '#06d6a0']

export function colorForAddress(address: string): string {
  const index = parseInt(address.slice(0, 8), 16) % CURSOR_COLORS.length

  return CURSOR_COLORS[index]
}
