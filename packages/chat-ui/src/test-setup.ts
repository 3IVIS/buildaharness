import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement scrollIntoView; App.tsx calls it to keep the latest message in view.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {}
}
