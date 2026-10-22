import { expect, test, type Page } from '@playwright/test'

/**
 * Aielia Write while a model call runs, in a real browser: the page header and chat box keep their layout, the working block shows its steps and
 * clears, the changed passage is lit, Stop ends a check between claims, and nothing overflows on a phone or animates under reduced motion.
 *
 * The page is the real WriteApp over scripted model calls (e2e/write-scripted, served on :4174 by vite.write-scripted.config.ts), so no key is needed.
 * jsdom cannot see any of this: a CSS class that collided with the page header's passed 130 jsdom tests and broke the page. Like the other specs
 * here it cannot run in the dev container (no Chromium); it runs on a dev machine or in CI.
 */
const PAGE = 'http://127.0.0.1:4174/?delay=700'

async function open(page: Page): Promise<void> {
  await page.goto(PAGE)
  await page.waitForSelector('textarea[aria-label="Article text"]', { timeout: 20_000 })
}
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('textarea[aria-label="Message"]', text)
  await page.keyboard.press('Enter')
}
const mode = (page: Page, value: 'answer' | 'suggest' | 'edit'): Promise<string[]> => page.selectOption('select[aria-label="When I ask for a change"]', value)

test('the page header and the chat box keep their layout', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await open(page)
  // A new class that reuses the header's own (it once did) turned the header's children into tall blocks.
  const bar = await page.locator('.write__bar').first().boundingBox()
  expect(bar?.height ?? 999).toBeLessThan(100)
  const publish = await page.getByRole('button', { name: 'Publish' }).boundingBox()
  expect(publish?.height ?? 999).toBeLessThan(80)
  // The whole chat box, down to the send button, is inside the window.
  const sendBtn = await page.getByRole('button', { name: 'Send' }).boundingBox()
  expect(sendBtn).not.toBeNull()
  expect((sendBtn?.y ?? 0) + (sendBtn?.height ?? 0)).toBeLessThanOrEqual(800)
})

test('an edit shows its steps, ticks them off, lights the changed passage and clears', async ({ page }) => {
  await open(page)
  await mode(page, 'edit')
  await send(page, 'Make the second sentence stronger')
  const block = page.locator('.write__work')
  await expect(block).toBeVisible()
  await expect(block.getByText('Saving your text')).toBeVisible()
  await expect(block.getByRole('button', { name: /Stop/ })).toBeVisible()
  await expect(block.locator('li.is-done').first()).toBeVisible()
  // The changed words are lit once the article has the edit, and the block is gone after its short "Done." hold.
  await expect(page.locator('.write__flash').first()).toBeVisible({ timeout: 15_000 })
  await expect(block).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByText(/I saved a version first/)).toBeVisible()
  expect(await page.title()).not.toContain('Working')
})

test('a plain answer streams into the block and then becomes the chat line', async ({ page }) => {
  await open(page)
  await mode(page, 'answer')
  await send(page, 'Is the latency figure convincing?')
  await expect(page.locator('.write__stream')).toContainText('p99', { timeout: 15_000 })
  await expect(page.locator('.write__work')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('.write__line--aielia').last()).toContainText('single percentile')
})

test('Stop ends a check between claims and keeps the claims already checked', async ({ page }) => {
  await open(page)
  await page.selectOption('select[aria-label="Adjust"]', 'action:verify')
  const block = page.locator('.write__work')
  await expect(block.getByRole('progressbar')).toBeVisible({ timeout: 15_000 })
  await block.getByRole('button', { name: /Stop/ }).click()
  await expect(block.getByText('Stopping after this step…')).toBeVisible()
  await expect(page.getByText(/Stopped early: \d claims? (was|were) checked/)).toBeVisible({ timeout: 20_000 })
  await expect(block).toHaveCount(0, { timeout: 15_000 })
})

test('on a phone width nothing overflows sideways while a job runs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await page.getByRole('button', { name: /^Chat/ }).last().click()
  await mode(page, 'edit')
  await send(page, 'Make the second sentence stronger')
  await expect(page.locator('.write__work')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('with reduced motion nothing in the working block animates', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await open(page)
  await mode(page, 'edit')
  await send(page, 'Make the second sentence stronger')
  await expect(page.locator('.write__work')).toBeVisible()
  const animations = await page.evaluate(() => [...document.querySelectorAll('.write__pulse i, .write__compose textarea')].map((e) => getComputedStyle(e).animationName))
  expect(animations.length).toBeGreaterThan(0)
  expect(animations.every((a) => a === 'none')).toBe(true)
  await context.close()
})
