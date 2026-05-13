export function getCaretXY(el: HTMLTextAreaElement, position: number): { top: number; left: number } {
  const style = window.getComputedStyle(el)
  const div = document.createElement('div')

  const props = [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'fontVariant',
    'lineHeight',
    'letterSpacing',
    'wordSpacing',
    'textTransform',
    'textIndent',
    'whiteSpace',
    'wordBreak',
    'wordWrap',
    'tabSize',
  ] as const

  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.top = '-9999px'
  div.style.left = '-9999px'
  div.style.overflow = 'hidden'
  props.forEach(p => {
    div.style[p as never] = style[p as never]
  })

  const text = el.value.slice(0, position)
  div.textContent = text || ' '
  const span = document.createElement('span')
  span.textContent = el.value[position] ?? ' '
  div.appendChild(span)
  document.body.appendChild(div)
  const coords = { top: span.offsetTop, left: span.offsetLeft }
  document.body.removeChild(div)

  return coords
}

const CURSOR_COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#a8dadc', '#457b9d', '#c77dff', '#06d6a0']

export function colorForAddress(address: string): string {
  const index = parseInt(address.slice(0, 8), 16) % CURSOR_COLORS.length

  return CURSOR_COLORS[index]
}

export function injectPeerStyle(key: string, address: string, username: string, color: string) {
  const style = document.createElement('style')

  style.textContent = `
    .remote-selection-${key} {
      background: ${color}33;  /* 20% opacity */
    }
    .remote-cursor-head-${key}::before {
      content: '';
      display: inline-block;
      width: 2px;
      height: 1.2em;
      background: ${color};
      margin-left: -1px;
      position: absolute;
    }
    .remote-cursor-head-${key}::after {
      content: '${username}';
      background: ${color};
      color: #fff;
      font-size: 11px;
      padding: 1px 4px;
      border-radius: 2px;
      position: absolute;
      top: -1.4em;
      left: 0;
      white-space: nowrap;
      pointer-events: none;
    }
  `
  document.head.appendChild(style)
}
