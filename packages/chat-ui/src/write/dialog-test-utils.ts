import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** Answers the question the page is asking: types `text` when it asks for a line of text, then agrees (OK, or the yes button). */
export async function answerDialog(text?: string): Promise<void> {
  const box = within(await screen.findByRole('dialog'))
  if (text !== undefined) {
    const input = box.getByLabelText('Your answer')
    await userEvent.clear(input)
    if (text) await userEvent.type(input, text)
  }
  await userEvent.click(box.getByRole('button', { name: /^(OK|Yes|Restore|Remove|Forget|Delete everything)$/ }))
}

/** Declines the question the page is asking (Cancel, or No). */
export async function declineDialog(): Promise<void> {
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^(Cancel|No)$/ }))
}
