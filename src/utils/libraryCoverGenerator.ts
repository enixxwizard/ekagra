import type { LibraryCoverTemplateId } from '../types/library';

export interface CoverTemplateDefinition {
  id: LibraryCoverTemplateId;
  label: string;
  bgPrimary: string;
  bgSecondary: string;
  spineBg: string;
  accentPrimary: string;
  accentSecondary: string;
  textPrimary: string;
  textMuted: string;
  badgeBg: string;
  badgeText: string;
  motif: 'code_grid' | 'compass_arcs' | 'editorial_rules' | 'botanical_rings' | 'orbital_waves' | 'swiss_blocks';
}

export const COVER_TEMPLATES: Record<LibraryCoverTemplateId, CoverTemplateDefinition> = {
  charcoal_tech: {
    id: 'charcoal_tech',
    label: 'Charcoal & Citron',
    bgPrimary: '#1A1C19',
    bgSecondary: '#222520',
    spineBg: '#121311',
    accentPrimary: '#B9E769',
    accentSecondary: '#F97316',
    textPrimary: '#F6F5F0',
    textMuted: '#A8ACA2',
    badgeBg: '#2A2F26',
    badgeText: '#B9E769',
    motif: 'code_grid',
  },
  cobalt_math: {
    id: 'cobalt_math',
    label: 'Cobalt Blueprint',
    bgPrimary: '#111A2E',
    bgSecondary: '#18243F',
    spineBg: '#0B1120',
    accentPrimary: '#60A5FA',
    accentSecondary: '#38BDF8',
    textPrimary: '#F1F5F9',
    textMuted: '#94A3B8',
    badgeBg: '#1E2D4C',
    badgeText: '#93C5FD',
    motif: 'compass_arcs',
  },
  editorial_humanities: {
    id: 'editorial_humanities',
    label: 'Archival Cream',
    bgPrimary: '#F3ECE0',
    bgSecondary: '#EAE0CE',
    spineBg: '#27221C',
    accentPrimary: '#B45309',
    accentSecondary: '#5F7A4A',
    textPrimary: '#241E17',
    textMuted: '#685D50',
    badgeBg: '#E4D8C4',
    badgeText: '#43382B',
    motif: 'editorial_rules',
  },
  botanical_bio: {
    id: 'botanical_bio',
    label: 'Botanical Emerald',
    bgPrimary: '#11221B',
    bgSecondary: '#172E25',
    spineBg: '#0B1712',
    accentPrimary: '#4ADE80',
    accentSecondary: '#2DD4BF',
    textPrimary: '#ECFDF5',
    textMuted: '#9AC2B0',
    badgeBg: '#1D382D',
    badgeText: '#86EFAC',
    motif: 'botanical_rings',
  },
  obsidian_physics: {
    id: 'obsidian_physics',
    label: 'Obsidian Orbit',
    bgPrimary: '#17161F',
    bgSecondary: '#201F2B',
    spineBg: '#0F0E15',
    accentPrimary: '#FBBF24',
    accentSecondary: '#A78BFA',
    textPrimary: '#F5F3FF',
    textMuted: '#ABA6BF',
    badgeBg: '#282638',
    badgeText: '#FDE68A',
    motif: 'orbital_waves',
  },
  terracotta_exam: {
    id: 'terracotta_exam',
    label: 'Terracotta Swiss',
    bgPrimary: '#231B18',
    bgSecondary: '#2D231F',
    spineBg: '#17110F',
    accentPrimary: '#FB7185',
    accentSecondary: '#B9E769',
    textPrimary: '#FDF8F6',
    textMuted: '#BFAEA7',
    badgeBg: '#3A2B26',
    badgeText: '#FDA4AF',
    motif: 'swiss_blocks',
  },
};

export const LIBRARY_SUBJECTS = [
  'Computer Science',
  'Mathematics',
  'Physics & Chemistry',
  'Biology & Medicine',
  'Humanities & History',
  'Economics & Business',
  'Exam Prep',
  'General Studies',
] as const;

export function inferSubjectAndTemplate(
  rawText: string
): { subject: string; coverTemplate: LibraryCoverTemplateId } {
  const lower = rawText.toLowerCase();

  if (
    /\b(java|python|javascript|typescript|c\+\+|react|spring|sql|postgres|dbms|database|algorithm|data structure|dsa|operating system|computer|software|programming|coding|git|html|css|backend|frontend|api|strings|oop)\b/.test(
      lower
    )
  ) {
    return { subject: 'Computer Science', coverTemplate: 'charcoal_tech' };
  }
  if (
    /\b(math|calculus|algebra|geometry|trigonometry|probability|statistics|differential|matrix|linear|discrete|theorem|integral|ssc maths|quant)\b/.test(
      lower
    )
  ) {
    return { subject: 'Mathematics', coverTemplate: 'cobalt_math' };
  }
  if (
    /\b(physics|chemistry|quantum|thermodynamics|mechanics|electromagnet|organic|inorganic|optics|molecule|atom|relativity)\b/.test(
      lower
    )
  ) {
    return { subject: 'Physics & Chemistry', coverTemplate: 'obsidian_physics' };
  }
  if (
    /\b(biology|anatomy|physiology|medicine|genetics|cell|neuro|botany|zoology|biochem|pharmacology|pathology)\b/.test(
      lower
    )
  ) {
    return { subject: 'Biology & Medicine', coverTemplate: 'botanical_bio' };
  }
  if (
    /\b(history|literature|philosophy|sociology|psychology|polity|civics|constitution|geography|essay|art|humanities|ethics)\b/.test(
      lower
    )
  ) {
    return { subject: 'Humanities & History', coverTemplate: 'editorial_humanities' };
  }
  if (
    /\b(economics|finance|accounting|macroeconomics|microeconomics|business|management|marketing|commerce)\b/.test(
      lower
    )
  ) {
    return { subject: 'Economics & Business', coverTemplate: 'editorial_humanities' };
  }
  if (
    /\b(exam|upsc|gate|jee|neet|sat|gre|gmat|ssc|mcq|mock test|practice set|previous year|question bank|syllabus)\b/.test(
      lower
    )
  ) {
    return { subject: 'Exam Prep', coverTemplate: 'terracotta_exam' };
  }

  return { subject: 'General Studies', coverTemplate: 'terracotta_exam' };
}

export function inferCleanTitleAndSubtitle(
  fileNameOrRawTitle: string,
  pdfMetaTitle?: string | null
): { title: string; subtitle: string } {
  const cleanFileBase = fileNameOrRawTitle
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let working =
    pdfMetaTitle &&
    pdfMetaTitle.trim().length >= 3 &&
    !/^(microsoft word|untitled|document\d*|slide\s*1|presentation)$/i.test(pdfMetaTitle.trim())
      ? pdfMetaTitle.trim()
      : cleanFileBase;

  // Remove noisy bracketed/version suffixes like (Latest), [2026], v2, note no 1
  let noteTag = '';
  const noteMatch = /\b(?:note|notes|lecture|part|ch|chapter)\s*(?:no\.?|#)?\s*(\d+)\b/i.exec(working);
  if (noteMatch) {
    noteTag = `Notes ${noteMatch[1]}`;
  }

  working = working
    .replace(/\((?:latest|final|updated|new|draft|v\d+(?:\.\d+)?)\)/gi, '')
    .replace(/\[[^\]]{1,30}\]/g, '')
    .replace(/\b(?:note|notes)\s*(?:no\.?|#)?\s*\d+\b/gi, '')
    .replace(/\b(?:final|latest|copy|compressed|ilovepdf)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '')
    .trim();

  // Split "Core Java till Strings" or "DBMS: Normalization and Indexing" cleanly
  const colonParts = working.split(/\s*[:|–—-]\s*/).filter(Boolean);
  if (colonParts.length >= 2 && colonParts[0].length >= 3 && colonParts[0].length <= 42) {
    const mainTitle = colonParts[0].trim();
    const rest = colonParts.slice(1).join(' · ').trim();
    return {
      title: mainTitle,
      subtitle: noteTag && !rest.toLowerCase().includes('note') ? `${rest} · ${noteTag}` : rest,
    };
  }

  const tillMatch = /^(.{3,32}?)\s+\b(?:till|to|through|part|vol)\b\s+(.+)$/i.exec(working);
  if (tillMatch) {
    const mainTitle = tillMatch[1].trim();
    const scope = tillMatch[0].slice(mainTitle.length).trim();
    const formattedScope = scope.charAt(0).toUpperCase() + scope.slice(1);
    return {
      title: mainTitle,
      subtitle: noteTag ? `${formattedScope} · ${noteTag}` : formattedScope,
    };
  }

  const finalTitle = working || cleanFileBase || 'Study Resource';
  if (finalTitle.length > 44) {
    const words = finalTitle.split(/\s+/);
    const shortTitle = words.slice(0, 4).join(' ');
    const remainder = words.slice(4).join(' ');
    return {
      title: shortTitle,
      subtitle: noteTag ? `${remainder} · ${noteTag}` : remainder,
    };
  }

  return {
    title: finalTitle,
    subtitle: noteTag,
  };
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) {
        lines.push(current);
        if (lines.length === maxLines) {
          lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(3, lines[maxLines - 1].length - 1))}…`;
          return lines;
        }
        current = word;
      } else {
        // Hard wrap single very long token
        let clipped = word;
        while (clipped.length > 3 && ctx.measureText(`${clipped}…`).width > maxWidth) {
          clipped = clipped.slice(0, -1);
        }
        lines.push(`${clipped}…`);
        if (lines.length === maxLines) return lines;
        current = '';
      }
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines;
}

function drawMotif(
  ctx: CanvasRenderingContext2D,
  template: CoverTemplateDefinition,
  x: number,
  y: number,
  w: number,
  h: number
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  if (template.motif === 'code_grid') {
    // Subtle geometric code bracket + node grid motif
    ctx.strokeStyle = 'rgba(185, 231, 105, 0.14)';
    ctx.lineWidth = 2;
    const step = 44;
    for (let gx = x; gx <= x + w; gx += step) {
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
      ctx.stroke();
    }
    for (let gy = y; gy <= y + h; gy += step) {
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
      ctx.stroke();
    }

    // Accent geometric blocks & curly-brace/chevron emblem
    ctx.fillStyle = template.accentPrimary;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(x + 42, y + 60, 120, 14);
    ctx.fillStyle = template.accentSecondary;
    ctx.globalAlpha = 0.88;
    ctx.fillRect(x + 178, y + 60, 52, 14);

    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = template.accentPrimary;
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Left angle <
    ctx.beginPath();
    ctx.moveTo(x + w - 200, y + h - 190);
    ctx.lineTo(x + w - 250, y + h - 140);
    ctx.lineTo(x + w - 200, y + h - 90);
    ctx.stroke();
    // Slash /
    ctx.strokeStyle = template.accentSecondary;
    ctx.beginPath();
    ctx.moveTo(x + w - 145, y + h - 200);
    ctx.lineTo(x + w - 175, y + h - 80);
    ctx.stroke();
    // Right angle >
    ctx.strokeStyle = template.accentPrimary;
    ctx.beginPath();
    ctx.moveTo(x + w - 120, y + h - 190);
    ctx.lineTo(x + w - 70, y + h - 140);
    ctx.lineTo(x + w - 120, y + h - 90);
    ctx.stroke();
  } else if (template.motif === 'compass_arcs') {
    const cx = x + w * 0.72;
    const cy = y + h * 0.56;
    ctx.strokeStyle = template.accentPrimary;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 2;
    for (const r of [90, 150, 210, 270]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = template.accentSecondary;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 40, cy);
    ctx.lineTo(x + w - 40, cy);
    ctx.moveTo(cx, y + 30);
    ctx.lineTo(cx, y + h - 30);
    ctx.stroke();

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = template.accentPrimary;
    ctx.beginPath();
    ctx.arc(cx - 110, cy - 80, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = template.accentSecondary;
    ctx.beginPath();
    ctx.arc(cx + 80, cy + 50, 8, 0, Math.PI * 2);
    ctx.fill();
  } else if (template.motif === 'editorial_rules') {
    ctx.strokeStyle = template.accentPrimary;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 36, y + 36, w - 72, h - 72);
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.28;
    ctx.strokeRect(x + 48, y + 48, w - 96, h - 96);

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = template.accentSecondary;
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = template.bgPrimary;
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, 30, 0, Math.PI * 2);
    ctx.fill();
  } else if (template.motif === 'botanical_rings') {
    const cx = x + w * 0.68;
    const cy = y + h * 0.58;
    ctx.strokeStyle = template.accentPrimary;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.42;
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI) / 3;
      ctx.beginPath();
      ctx.ellipse(
        cx + Math.cos(angle) * 55,
        cy + Math.sin(angle) * 55,
        90,
        42,
        angle,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = template.accentSecondary;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.fill();
  } else if (template.motif === 'orbital_waves') {
    const cx = x + w * 0.66;
    const cy = y + h * 0.54;
    ctx.strokeStyle = template.accentSecondary;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.5;
    for (const rot of [-0.55, 0.25, 1.05]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, 175, 58, rot, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = template.accentPrimary;
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // swiss_blocks
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = template.accentPrimary;
    ctx.fillRect(x + 48, y + 64, 156, 156);
    ctx.fillStyle = template.accentSecondary;
    ctx.fillRect(x + 224, y + 64, 72, 156);
    ctx.fillStyle = template.textPrimary;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(x + 48, y + 240, 248, 42);
  }

  ctx.restore();
}

export interface RenderCoverOptions {
  title: string;
  subtitle?: string;
  subject: string;
  templateId: LibraryCoverTemplateId;
  totalPages?: number | null;
}

export function renderBookCoverToCanvas(
  canvas: HTMLCanvasElement,
  options: RenderCoverOptions
): void {
  const width = 900;
  const height = 1200;
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const tpl = COVER_TEMPLATES[options.templateId] ?? COVER_TEMPLATES.charcoal_tech;

  // Base cover gradient
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, tpl.bgPrimary);
  grad.addColorStop(1, tpl.bgSecondary);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Left book spine band + subtle crease highlight
  const spineW = 54;
  ctx.fillStyle = tpl.spineBg;
  ctx.fillRect(0, 0, spineW, height);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(spineW, 0, 3, height);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(spineW + 3, 0, 6, height);

  // Content safe margins
  const left = spineW + 64;
  const rightMargin = 64;
  const contentW = width - left - rightMargin;

  // Top bar: Subject + EKAGRA imprint
  ctx.fillStyle = tpl.badgeBg;
  ctx.beginPath();
  ctx.roundRect(left, 68, Math.min(contentW * 0.64, Math.max(180, options.subject.length * 16 + 48)), 44, 8);
  ctx.fill();

  ctx.font = '700 20px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.fillStyle = tpl.badgeText;
  ctx.textBaseline = 'middle';
  ctx.fillText(options.subject.toUpperCase(), left + 22, 90);

  ctx.font = '700 18px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = tpl.textMuted;
  ctx.textAlign = 'right';
  ctx.fillText('EKAGRA', width - rightMargin, 90);
  ctx.textAlign = 'left';

  // Horizontal accent hairline
  ctx.fillStyle = tpl.accentPrimary;
  ctx.fillRect(left, 140, 96, 5);

  // Main Title
  const cleanTitle = (options.title || 'Study Resource').trim();
  const titleFontSize = cleanTitle.length > 26 ? 62 : cleanTitle.length > 16 ? 74 : 86;
  ctx.font = `800 ${titleFontSize}px "Sora", "Plus Jakarta Sans", system-ui, sans-serif`;
  ctx.fillStyle = tpl.textPrimary;
  ctx.textBaseline = 'top';
  const titleLines = wrapLines(ctx, cleanTitle, contentW, 4);
  let cursorY = 188;
  const lineHeight = titleFontSize * 1.12;
  for (const line of titleLines) {
    ctx.fillText(line, left, cursorY);
    cursorY += lineHeight;
  }

  // Optional Subtitle
  const cleanSubtitle = (options.subtitle || '').trim();
  if (cleanSubtitle) {
    cursorY += 18;
    ctx.font = '500 32px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillStyle = tpl.textMuted;
    const subLines = wrapLines(ctx, cleanSubtitle, contentW, 2);
    for (const sLine of subLines) {
      ctx.fillText(sLine, left, cursorY);
      cursorY += 42;
    }
  }

  // Geometric Motif artwork zone in lower half
  const artworkTop = Math.max(cursorY + 36, 560);
  const artworkHeight = height - artworkTop - 132;
  if (artworkHeight > 160) {
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.roundRect(left, artworkTop, contentW, artworkHeight, 20);
    ctx.fill();
    drawMotif(ctx, tpl, left, artworkTop, contentW, artworkHeight);
  }

  // Bottom footer line
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  if (tpl.id === 'editorial_humanities') {
    ctx.fillStyle = 'rgba(36, 30, 23, 0.14)';
  }
  ctx.fillRect(left, height - 96, contentW, 2);

  ctx.font = '600 20px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = tpl.textMuted;
  ctx.textBaseline = 'middle';
  ctx.fillText('PERSONAL STUDY EDITION', left, height - 56);

  if (options.totalPages && options.totalPages > 0) {
    ctx.textAlign = 'right';
    ctx.fillText(`${options.totalPages} PAGES`, width - rightMargin, height - 56);
    ctx.textAlign = 'left';
  }
}

export async function generateBookCoverPngBlob(
  options: RenderCoverOptions
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  renderBookCoverToCanvas(canvas, options);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Could not encode book cover image.'));
        }
      },
      'image/png',
      0.95
    );
  });
}
