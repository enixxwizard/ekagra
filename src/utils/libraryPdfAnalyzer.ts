import * as pdfjsLib from 'pdfjs-dist';
import type {
  LibraryAnalysisStatus,
  LibraryCoverTemplateId,
  LibraryTopic,
} from '../types/library';
import {
  inferCleanTitleAndSubtitle,
  inferSubjectAndTemplate,
} from './libraryCoverGenerator';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface LibraryPdfAnalysisProgress {
  stage: 'loading' | 'outline' | 'scanning_pages' | 'ocr' | 'finalizing';
  currentPage: number;
  totalPages: number;
  percent: number;
  message: string;
}

export interface LibraryPdfAnalysisResult {
  title: string;
  subtitle: string;
  subject: string;
  coverTemplate: LibraryCoverTemplateId;
  description: string;
  totalPages: number;
  topics: LibraryTopic[];
  analysisStatus: LibraryAnalysisStatus;
  analysisNote: string | null;
}

interface PdfOutlineItem {
  title?: string;
  dest?: string | unknown[] | null;
  items?: PdfOutlineItem[];
}

interface TextLineItem {
  text: string;
  fontSize: number;
  y: number;
}

function makeTopicId(index: number): string {
  return `top_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`;
}

async function resolveOutlineDestToPage(
  pdf: pdfjsLib.PDFDocumentProxy,
  dest: string | unknown[] | null | undefined
): Promise<number | null> {
  if (!dest) return null;
  try {
    let resolvedDest: unknown[] | null = null;
    if (typeof dest === 'string') {
      resolvedDest = await pdf.getDestination(dest);
    } else if (Array.isArray(dest)) {
      resolvedDest = dest;
    }
    if (!resolvedDest || resolvedDest.length === 0) return null;
    const ref = resolvedDest[0];
    if (typeof ref === 'number') {
      return ref + 1;
    }
    if (ref && typeof ref === 'object') {
      const pageIdx = await pdf.getPageIndex(ref as never);
      return pageIdx + 1;
    }
  } catch {
    return null;
  }
  return null;
}

function cleanTopicHeadingText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\.{3,}\s*\d*\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 140);
}

function isLikelyNoiseHeading(text: string): boolean {
  if (text.length < 3 || text.length > 110) return true;
  if (/^\d+$/.test(text)) return true;
  if (/^page\s+\d+(?:\s+of\s+\d+)?$/i.test(text)) return true;
  if (/^(?:copyright|all rights reserved|www\.|https?:\/\/)/i.test(text)) return true;
  if (/^[^a-zA-Z0-9]+$/.test(text)) return true;
  return false;
}

function extractLinesWithFontSize(
  items: Array<{ str: string; transform?: number[]; height?: number }>
): { lines: TextLineItem[]; medianFont: number; plainText: string } {
  const tokens: Array<{ text: string; y: number; x: number; fontSize: number }> = [];
  const sizes: number[] = [];

  for (const it of items) {
    const str = it.str.replace(/\s+/g, ' ').trim();
    if (!str) continue;
    const t = Array.isArray(it.transform) ? it.transform : [10, 0, 0, 10, 0, 0];
    const fontSize =
      typeof it.height === 'number' && it.height > 0
        ? it.height
        : Math.hypot(Number(t[0]) || 0, Number(t[1]) || 0) || 10;
    const x = Number(t[4]) || 0;
    const y = Number(t[5]) || 0;
    tokens.push({ text: str, y, x, fontSize });
    sizes.push(fontSize);
  }

  if (tokens.length === 0) {
    return { lines: [], medianFont: 11, plainText: '' };
  }

  sizes.sort((a, b) => a - b);
  const medianFont = sizes[Math.floor(sizes.length * 0.5)] || 11;

  tokens.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 4.5) return b.y - a.y;
    return a.x - b.x;
  });

  const rows: Array<typeof tokens> = [];
  for (const tok of tokens) {
    const prevRow = rows[rows.length - 1];
    if (!prevRow || Math.abs(prevRow[0].y - tok.y) > 4.5) {
      rows.push([tok]);
    } else {
      prevRow.push(tok);
    }
  }

  const lines: TextLineItem[] = rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      const joined = row.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim();
      const maxFont = row.reduce((m, r) => Math.max(m, r.fontSize), 0);
      return {
        text: joined,
        fontSize: maxFont,
        y: row[0].y,
      };
    })
    .filter((l) => l.text.length > 0);

  return {
    lines,
    medianFont,
    plainText: lines.map((l) => l.text).join('\n'),
  };
}

function isStrongHeadingCandidate(line: TextLineItem, medianFont: number): boolean {
  const txt = cleanTopicHeadingText(line.text);
  if (isLikelyNoiseHeading(txt)) return false;

  const isStructuralPrefix =
    /^(?:chapter|unit|module|lesson|part|section|topic)\s+(?:\d+|[IVXLCDM]+)\b[:.\-\s]*/i.test(
      txt
    ) || /^\d+(?:\.\d+){0,2}[.)]\s+[A-Z]/.test(txt);

  const wordCount = txt.split(/\s+/).length;
  const significantlyLarger = line.fontSize >= medianFont * 1.24 && wordCount <= 12;
  const moderatelyLargerStructural =
    line.fontSize >= medianFont * 1.08 && isStructuralPrefix && wordCount <= 14;

  if (significantlyLarger) return true;
  if (moderatelyLargerStructural) return true;
  if (isStructuralPrefix && wordCount >= 2 && wordCount <= 10 && !/[.;!?]$/.test(txt)) {
    return true;
  }
  return false;
}

function buildDescriptionFromFacts(params: {
  title: string;
  subject: string;
  totalPages: number;
  topics: LibraryTopic[];
  sampleLeadText: string;
  isScanned: boolean;
}): string {
  const { title, subject, totalPages, topics, sampleLeadText, isScanned } = params;

  if (isScanned) {
    return `${totalPages}-page scanned or image-based ${subject.toLowerCase()} PDF. Open the reader to browse every page or run free local OCR to index topics.`;
  }

  const namedTopics = topics
    .map((t) => t.title)
    .filter((t) => t.length >= 3)
    .slice(0, 4);

  if (namedTopics.length >= 2) {
    return `${totalPages}-page ${subject.toLowerCase()} resource covering ${namedTopics.join(', ')}${topics.length > 4 ? ', and more' : ''}.`;
  }

  const sentenceMatch = sampleLeadText
    .replace(/\s+/g, ' ')
    .match(/[A-Z][^.!?]{35,190}[.!?]/);
  if (sentenceMatch) {
    return sentenceMatch[0].trim();
  }

  return `${title} — ${totalPages}-page ${subject.toLowerCase()} reference saved in your personal library.`;
}

function buildPagedTopicsWithEndPages(
  entries: Array<{ title: string; startPage: number; verificationStatus: LibraryTopic['verificationStatus'] }>,
  totalPages: number
): LibraryTopic[] {
  const sorted = [...entries]
    .filter((e) => e.startPage >= 1 && e.startPage <= totalPages)
    .sort((a, b) => a.startPage - b.startPage);

  // Deduplicate identical titles on the same page
  const deduped: typeof sorted = [];
  for (const item of sorted) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.startPage === item.startPage &&
      prev.title.toLowerCase() === item.title.toLowerCase()
    ) {
      continue;
    }
    if (deduped.some((d) => d.title.toLowerCase() === item.title.toLowerCase() && Math.abs(d.startPage - item.startPage) <= 1)) {
      continue;
    }
    deduped.push(item);
  }

  return deduped.map((item, idx) => {
    const next = deduped[idx + 1];
    const endPage = next
      ? Math.max(item.startPage, Math.min(totalPages, next.startPage - 1 || item.startPage))
      : totalPages;

    return {
      id: makeTopicId(idx),
      title: item.title,
      startPage: item.startPage,
      endPage,
      verificationStatus: item.verificationStatus,
    };
  });
}

function extractTocLinesWithoutFakePages(lines: TextLineItem[]): LibraryTopic[] {
  const tocCandidates: LibraryTopic[] = [];
  let inToc = false;

  for (const line of lines) {
    const txt = line.text.trim();
    if (/^(?:table\s+of\s+contents|contents|index|syllabus)\b/i.test(txt)) {
      inToc = true;
      continue;
    }
    if (!inToc) continue;

    // Match lines like "1. Introduction .... 4" or "Operators in Java --- 63"
    const dotted = /^(.{3,80}?)\s*(?:\.{2,}|_{2,}|-{2,})\s*(\d{1,4})\s*$/.exec(txt);
    if (dotted) {
      const cleanTitle = cleanTopicHeadingText(dotted[1]);
      if (!isLikelyNoiseHeading(cleanTitle)) {
        tocCandidates.push({
          id: makeTopicId(tocCandidates.length),
          title: cleanTitle,
          // Do NOT blindly treat printed book page numbers as PDF page numbers unless verified!
          startPage: null,
          endPage: null,
          verificationStatus: 'unverified',
        });
      }
    }
    if (tocCandidates.length >= 25) break;
  }

  return tocCandidates;
}

export async function analyzePdfForLibrary(
  source: Uint8Array | ArrayBuffer,
  fileName: string,
  onProgress?: (progress: LibraryPdfAnalysisProgress) => void
): Promise<LibraryPdfAnalysisResult> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  onProgress?.({
    stage: 'loading',
    currentPage: 0,
    totalPages: 0,
    percent: 5,
    message: 'Opening PDF document…',
  });

  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
  });

  let pdf: pdfjsLib.PDFDocumentProxy;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    const name = (err as { name?: string })?.name || '';
    if (name === 'PasswordException') {
      throw new Error('This PDF is password-protected. Please upload an unlocked PDF.');
    }
    throw new Error('Could not read this PDF file. Please make sure the file is not corrupted.');
  }

  const totalPages = Math.max(1, pdf.numPages);
  let metaTitle: string | null = null;
  let metaSubject: string | null = null;

  try {
    const meta = await pdf.getMetadata();
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    if (typeof info.Title === 'string' && info.Title.trim()) {
      metaTitle = info.Title.trim();
    }
    if (typeof info.Subject === 'string' && info.Subject.trim()) {
      metaSubject = info.Subject.trim();
    }
  } catch {
    // Metadata is optional
  }

  // 1. Check PDF native Outline / Bookmarks first (highest precision)
  onProgress?.({
    stage: 'outline',
    currentPage: 0,
    totalPages,
    percent: 15,
    message: 'Checking embedded table of contents…',
  });

  const outlineEntries: Array<{
    title: string;
    startPage: number;
    verificationStatus: LibraryTopic['verificationStatus'];
  }> = [];

  try {
    const outline = (await pdf.getOutline()) as PdfOutlineItem[] | null;
    if (Array.isArray(outline) && outline.length > 0) {
      const walkOutline = async (nodes: PdfOutlineItem[], depth: number) => {
        for (const node of nodes) {
          if (outlineEntries.length >= 60) break;
          const clean = cleanTopicHeadingText(node.title || '');
          if (clean && !isLikelyNoiseHeading(clean)) {
            const pageNum = await resolveOutlineDestToPage(pdf, node.dest);
            if (pageNum !== null && pageNum >= 1 && pageNum <= totalPages) {
              outlineEntries.push({
                title: clean,
                startPage: pageNum,
                verificationStatus: 'verified_outline',
              });
            }
          }
          if (depth < 1 && Array.isArray(node.items) && node.items.length > 0) {
            await walkOutline(node.items, depth + 1);
          }
        }
      };
      await walkOutline(outline, 0);
    }
  } catch {
    // Fallback to text heading detection below
  }

  // 2. Scan pages cleanly in batches (even if outline exists, sample first pages for subject & description)
  const pagesToScan =
    outlineEntries.length >= 2 ? Math.min(totalPages, 5) : Math.min(totalPages, 160);

  let totalNonWhitespace = 0;
  let firstPagesSampleText = '';
  const headingCandidates: Array<{
    title: string;
    startPage: number;
    verificationStatus: LibraryTopic['verificationStatus'];
  }> = [];
  const unverifiedTocTopics: LibraryTopic[] = [];

  for (let p = 1; p <= pagesToScan; p++) {
    if (p % 6 === 0 || p === pagesToScan) {
      const pct = Math.min(90, 20 + Math.round((p / pagesToScan) * 68));
      onProgress?.({
        stage: 'scanning_pages',
        currentPage: p,
        totalPages,
        percent: pct,
        message: `Indexing pages (${p} / ${totalPages})…`,
      });
      await new Promise((r) => setTimeout(r, 0));
    }

    try {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const rawItems = content.items.filter(
        (item): item is Extract<(typeof content.items)[number], { str: string }> => 'str' in item
      );
      const { lines, medianFont, plainText } = extractLinesWithFontSize(rawItems);
      const charCount = plainText.replace(/\s+/g, '').length;
      totalNonWhitespace += charCount;

      if (p <= 5 && plainText) {
        firstPagesSampleText += `\n${plainText.slice(0, 1200)}`;
      }

      if (outlineEntries.length < 2) {
        if (p <= 8 && unverifiedTocTopics.length === 0) {
          const toc = extractTocLinesWithoutFakePages(lines);
          if (toc.length > 0) {
            unverifiedTocTopics.push(...toc);
          }
        }

        // Only consider top-half or prominently styled headings directly observed on page p
        let pageHeadingsAdded = 0;
        for (const line of lines) {
          if (pageHeadingsAdded >= 2) break;
          if (isStrongHeadingCandidate(line, medianFont)) {
            const clean = cleanTopicHeadingText(line.text);
            headingCandidates.push({
              title: clean,
              startPage: p,
              verificationStatus: 'detected_heading',
            });
            pageHeadingsAdded++;
          }
        }
      }
    } catch {
      // Skip faulty page cleanly
    }
  }

  onProgress?.({
    stage: 'finalizing',
    currentPage: totalPages,
    totalPages,
    percent: 96,
    message: 'Preparing book cover and topic index…',
  });

  const avgCharsPerScannedPage =
    pagesToScan > 0 ? totalNonWhitespace / Math.min(pagesToScan, 8) : 0;
  const isScanned = totalNonWhitespace < 35 || (pagesToScan >= 2 && avgCharsPerScannedPage < 22);

  let finalTopics: LibraryTopic[] = [];
  let analysisStatus: LibraryAnalysisStatus = 'complete';
  let analysisNote: string | null = null;

  if (outlineEntries.length >= 1) {
    finalTopics = buildPagedTopicsWithEndPages(outlineEntries, totalPages);
    analysisNote = `Indexed ${finalTopics.length} verified topic${finalTopics.length === 1 ? '' : 's'} from the PDF outline.`;
  } else if (headingCandidates.length >= 1) {
    finalTopics = buildPagedTopicsWithEndPages(headingCandidates.slice(0, 45), totalPages);
    analysisNote = `Detected ${finalTopics.length} section heading${finalTopics.length === 1 ? '' : 's'} directly from document pages. You can refine any page range anytime.`;
  } else if (unverifiedTocTopics.length > 0) {
    finalTopics = unverifiedTocTopics;
    analysisNote =
      'Found topic names in the document index, but page offsets could not be verified automatically. Click "Mark Page" inside the reader to link exact PDF pages.';
  } else if (isScanned) {
    analysisStatus = 'scanned_needs_ocr';
    analysisNote =
      'This appears to be a scanned or handwritten PDF with no embedded text layer. You can still read every original page, run free local OCR, or mark topics manually inside the reader.';
  } else {
    analysisNote =
      'No distinct chapter headings were detected automatically. You can add and bookmark topics directly while reading.';
  }

  const { title, subtitle } = inferCleanTitleAndSubtitle(fileName, metaTitle);
  const { subject, coverTemplate } = inferSubjectAndTemplate(
    `${fileName} ${metaTitle ?? ''} ${metaSubject ?? ''} ${firstPagesSampleText.slice(0, 1500)}`
  );
  const description = buildDescriptionFromFacts({
    title,
    subject,
    totalPages,
    topics: finalTopics,
    sampleLeadText: firstPagesSampleText,
    isScanned,
  });

  await loadingTask.destroy().catch(() => undefined);

  return {
    title,
    subtitle,
    subject,
    coverTemplate,
    description,
    totalPages,
    topics: finalTopics,
    analysisStatus,
    analysisNote,
  };
}

export async function runLocalOcrOnPdf(
  source: Uint8Array | ArrayBuffer,
  options?: {
    maxPagesToScan?: number;
    onProgress?: (progress: LibraryPdfAnalysisProgress) => void;
  }
): Promise<{
  topics: LibraryTopic[];
  recognizedPages: number;
  note: string;
}> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const scanLimit = Math.min(totalPages, options?.maxPagesToScan ?? 18);

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');

  const detectedHeadings: Array<{
    title: string;
    startPage: number;
    verificationStatus: LibraryTopic['verificationStatus'];
  }> = [];
  let totalRecognizedChars = 0;

  try {
    for (let p = 1; p <= scanLimit; p++) {
      options?.onProgress?.({
        stage: 'ocr',
        currentPage: p,
        totalPages: scanLimit,
        percent: Math.round((p / scanLimit) * 95),
        message: `Running free local OCR on page ${p} of ${scanLimit}…`,
      });

      const page = await pdf.getPage(p);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = Math.min(1.8, Math.max(1.1, 1100 / Math.max(1, baseVp.width)));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;

      const {
        data: { text },
      } = await worker.recognize(canvas);

      const cleanText = (text || '').trim();
      totalRecognizedChars += cleanText.replace(/\s+/g, '').length;

      const lines = cleanText
        .split(/\r?\n/)
        .map((l) => cleanTopicHeadingText(l))
        .filter((l) => !isLikelyNoiseHeading(l));

      for (const line of lines.slice(0, 6)) {
        const looksLikeTopic =
          /^(?:chapter|unit|module|lesson|part|section|topic)\s+\d+/i.test(line) ||
          /^\d+[.)]\s+[A-Z][a-zA-Z0-9\s-]{3,50}$/.test(line) ||
          (line.split(/\s+/).length >= 2 &&
            line.split(/\s+/).length <= 7 &&
            /^[A-Z]/.test(line) &&
            !/[.,;!?]$/.test(line));
        if (looksLikeTopic) {
          detectedHeadings.push({
            title: line,
            startPage: p,
            verificationStatus: 'ocr_detected',
          });
          break;
        }
      }
    }
  } finally {
    await worker.terminate().catch(() => undefined);
    await loadingTask.destroy().catch(() => undefined);
  }

  const topics =
    detectedHeadings.length > 0
      ? buildPagedTopicsWithEndPages(detectedHeadings, totalPages)
      : [];

  const note =
    topics.length > 0
      ? `Local OCR scanned ${scanLimit} page${scanLimit === 1 ? '' : 's'} and found ${topics.length} heading${topics.length === 1 ? '' : 's'}. Review or adjust page ranges inside the reader.`
      : totalRecognizedChars < 80
      ? `Local OCR scanned ${scanLimit} page${scanLimit === 1 ? '' : 's'}, but the handwriting or scan contrast was too faint to index topics reliably. No page numbers were guessed — you can mark topics manually inside the PDF reader.`
      : `Local OCR scanned ${scanLimit} page${scanLimit === 1 ? '' : 's'}, but no clear section headings stood out. You can mark topic page ranges manually inside the PDF reader.`;

  return {
    topics,
    recognizedPages: scanLimit,
    note,
  };
}
