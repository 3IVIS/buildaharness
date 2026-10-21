import { beforeAll, describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readFileText } from './file-text'

// In Node there is no worker file to load; pdf.js uses a worker module found on the global scope instead.
beforeAll(async () => { (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import('pdfjs-dist/build/pdf.worker.min.mjs') })

/** A one-page PDF with one line of text, written by hand (no library). */
function tinyPdf(text: string): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${`BT /F1 12 Tf 10 50 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 10 50 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(out)
}

describe('readFileText', () => {
  it('reads a text file as it is', async () => {
    expect(await readFileText(new File(['plain words'], 'a.txt', { type: 'text/plain' }))).toBe('plain words')
  })
  it('extracts the text of a Word file', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The p99 was 18 ms.</w:t></w:r></w:p></w:body></w:document>')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    expect(await readFileText(new File([bytes as BlobPart], 'brief.docx'))).toBe('The p99 was 18 ms.')
  })
  it('extracts the text of a PDF', async () => {
    expect(await readFileText(new File([tinyPdf('The p99 was 18 ms.') as BlobPart], 'paper.pdf', { type: 'application/pdf' }))).toContain('The p99 was 18 ms.')
  })
})
