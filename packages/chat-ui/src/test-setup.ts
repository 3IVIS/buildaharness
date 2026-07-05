import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement scrollIntoView; App.tsx calls it to keep the latest message in view.
// Guarded because this file is also picked up by root's shared vitest config, which runs some
// test files (e.g. packages/proxy's) in a non-jsdom environment with no `window` global at all.
if (typeof window !== 'undefined' && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {}
}
