import { documentFormatForFile } from '@buildaharness/aielia'

/**
 * The text of a dropped file. Text and code files are read as they are; PDF and Word files have their text extracted in the browser. The
 * extraction libraries are loaded only when such a file is dropped, so the page does not carry them otherwise. Throws a reason the writer can read.
 */
export async function readFileText(file: File): Promise<string> {
  const format = documentFormatForFile(file)
  if (format === 'docx') {
    const mammoth = await import('mammoth')
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    return value.trim()
  }
  if (format === 'pdf') {
    const pdfjs = await import('pdfjs-dist')
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    const pages: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent()
      pages.push(content.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+\n/g, '\n').trim())
    }
    return pages.filter(Boolean).join('\n\n')
  }
  return file.text()
}
