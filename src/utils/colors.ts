import { ActivityColor } from '../types/dayflow';

export interface ColorPaletteToken {
  label: string;
  swatch: string;
  blockBg: string;
  blockBorder: string;
  blockText: string;
  dot: string;
  chartHex: string;
}

export const ACTIVITY_COLORS: Record<ActivityColor, ColorPaletteToken> = {
  indigo: {
    label: 'Cobalt',
    swatch: 'bg-[#5B6EE1]',
    blockBg: 'bg-[#EEF1FC] dark:bg-[#23273A]',
    blockBorder: 'border-[#D5DCF7] dark:border-[#343B59]',
    blockText: 'text-[var(--df-text)]',
    dot: 'bg-[#5B6EE1]',
    chartHex: '#5B6EE1',
  },
  emerald: {
    label: 'Lime',
    swatch: 'bg-[#8CC83A]',
    blockBg: 'bg-[#F0F9E2] dark:bg-[#222B1B]',
    blockBorder: 'border-[#D4ECA9] dark:border-[#384B27]',
    blockText: 'text-[var(--df-text)]',
    dot: 'bg-[#6FA822]',
    chartHex: '#8CC83A',
  },
  amber: {
    label: 'Honey',
    swatch: 'bg-[#E5A93B]',
    blockBg: 'bg-[#FCF5E6] dark:bg-[#2D2619]',
    blockBorder: 'border-[#F2DFB6] dark:border-[#4A3D24]',
    blockText: 'text-[var(--df-text)]',
    dot: 'bg-[#D28E1C]',
    chartHex: '#E5A93B',
  },
  sky: {
    label: 'Mist',
    swatch: 'bg-[#4BA3C7]',
    blockBg: 'bg-[#EBF6FA] dark:bg-[#1D2A30]',
    blockBorder: 'border-[#CBE6F1] dark:border-[#2E444E]',
    blockText: 'text-[var(--df-text)]',
    dot: 'bg-[#3588AA]',
    chartHex: '#4BA3C7',
  },
  rose: {
    label: 'Coral',
    swatch: 'bg-[#DF6A61]',
    blockBg: 'bg-[#FCEEEB] dark:bg-[#312120]',
    blockBorder: 'border-[#F5CFCB] dark:border-[#503230]',
    blockText: 'text-[var(--df-text)]',
    dot: 'bg-[#C95249]',
    chartHex: '#DF6A61',
  },
  violet: {
    label: 'Plum',
    swatch: 'bg-[#9472D9]',
    blockBg: 'bg-[#F3EFFB] dark:bg-[#272233]',
    blockBorder: 'border-[#DFD5F5] dark:border-[#3E3554]',
    blockText: 'text-[var(--df-text)]',
    dot: 'bg-[#7A57C4]',
    chartHex: '#9472D9',
  },
  slate: {
    label: 'Stone',
    swatch: 'bg-[#8A8C84]',
    blockBg: 'bg-[#F3F1EC] dark:bg-[#252622]',
    blockBorder: 'border-[#E2DFD5] dark:border-[#393B34]',
    blockText: 'text-[var(--df-text)]',
    dot: 'bg-[#6B6D67]',
    chartHex: '#6B6D67',
  },
};

export const CATEGORY_DEFAULT_COLORS: Record<string, ActivityColor> = {
  Work: 'indigo',
  Study: 'sky',
  Health: 'emerald',
  Personal: 'amber',
  'Deep Focus': 'violet',
  Admin: 'slate',
};

export const CATEGORY_CHART_COLORS: Record<string, string> = {
  Work: '#5B6EE1',
  Study: '#4BA3C7',
  Health: '#8CC83A',
  Personal: '#E5A93B',
  'Deep Focus': '#9472D9',
  Admin: '#6B6D67',
};
