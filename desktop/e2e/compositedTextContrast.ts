import type { Page } from '@playwright/test'

/** Measure ink against rendered glass/background pixels, rather than assuming an opaque panel. */
export async function compositedTextContrast(page: Page, selector: string, placeholder = false) {
  const inks = await page.locator(selector).evaluateAll((elements, placeholder) => elements.flatMap(element => {
    const rect = element.getBoundingClientRect(), y = rect.y + rect.height / 2
    if (!rect.width || !rect.height || y < 0 || y >= innerHeight) return []
    element.setAttribute('data-composer-contrast-ink', '')
    const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d')!
    context.fillStyle = getComputedStyle(element, placeholder ? '::placeholder' : undefined).color
    context.fillRect(0, 0, 1, 1)
    return [{ label: element instanceof HTMLTextAreaElement ? placeholder ? element.placeholder : element.value : element.textContent?.slice(0, 80),
      color: [...context.getImageData(0, 0, 1, 1).data], points: [.2, .5, .8].map(t => ({
        x: Math.max(0, Math.min(innerWidth - 1, Math.floor(rect.x + rect.width * t))), y: Math.floor(y) })) }]
  }), placeholder)
  const hidden = await page.addStyleTag({ content: '[data-composer-contrast-ink], [data-composer-contrast-ink]::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }' })
  let pixels: Buffer
  try { pixels = await page.screenshot({ animations: 'disabled' }) }
  finally {
    await hidden.evaluate(el => el.remove())
    await page.locator('[data-composer-contrast-ink]').evaluateAll(elements => elements.forEach(el => el.removeAttribute('data-composer-contrast-ink')))
  }
  return page.evaluate(async ({ data, inks }) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode()
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!; context.drawImage(image, 0, 0)
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map(c => c / 255).reduce((sum, value, index) =>
      sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index], 0)
    return inks.map(ink => ({ label: ink.label, ratio: Math.min(...ink.points.map(({ x, y }) => {
      const background = [...context.getImageData(x, y, 1, 1).data]
      const foreground = ink.color.map((channel, index) => channel * ink.color[3] / 255 + background[index] * (1 - ink.color[3] / 255))
      const a = luminance(background), b = luminance(foreground)
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    })) }))
  }, { data: pixels.toString('base64'), inks })
}
