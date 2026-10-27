import qrcode from 'qrcode-generator'

const BLOCKS = [' ', '▄', '▀', '█']

// Half blocks keep a complete four-module quiet zone without stretching the QR.
export function qrLines(value: string, { color = true } = {}) {
  const qr = qrcode(0, 'L')
  qr.addData(value.toUpperCase(), 'Alphanumeric')
  qr.make()
  const size = qr.getModuleCount(),
    margin = 4,
    width = size + margin * 2
  const dark = (x: number, y: number) =>
    x >= margin &&
    x < size + margin &&
    y >= margin &&
    y < size + margin &&
    qr.isDark(y - margin, x - margin)
  const lines = []
  for (let y = 0; y < width; y += 2) {
    let row = ''
    for (let x = 0; x < width; x++) {
      row += BLOCKS[Number(dark(x, y)) * 2 + Number(dark(x, y + 1))]
    }

    lines.push(color ? '\x1b[30;47m' + row + '\x1b[0m' : row)
  }

  return lines
}
