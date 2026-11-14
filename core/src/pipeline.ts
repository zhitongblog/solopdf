/**
 * Multi-step PDF Processing Pipeline definitions & presets
 * (mirrors Rust `pdfops::PipelineStep` serialized with `#[serde(tag = "op", rename_all = "snake_case")]`).
 */

export type PipelineStepSpec =
  | { op: 'remove_blank'; threshold?: number }
  | {
      op: 'split2up'
      direction?: 'vertical' | 'horizontal'
      rtl?: boolean
      only_wide?: boolean
      overlap?: number
    }
  | { op: 'single_large_page'; gap?: number; border?: boolean }
  | {
      op: 'crop'
      margins?: [number, number, number, number]
      box_rect?: [number, number, number, number] | null
      pages?: number[]
    }
  | { op: 'rotate'; pages?: number[]; degrees: number }
  | { op: 'deskew'; max_angle?: number; clean_borders?: number }
  | { op: 'binarize'; k?: number; window_size?: number; clean_borders?: number }
  | { op: 'grayscale'; whiten_bg?: boolean }
  | { op: 'resize'; width: number; height: number }
  | {
      op: 'nup'
      cols: number
      rows: number
      landscape?: boolean | null
      margin?: number
      gap?: number
      border?: boolean
    }
  | { op: 'booklet'; border?: boolean }
  | {
      op: 'watermark'
      text: string
      font_size?: number
      color?: [number, number, number]
      opacity?: number
      rotate?: number
      position?: string
      tile_spacing?: number
      under?: boolean
    }
  | {
      op: 'page_numbers'
      format?: string
      position?: string
      start_number?: number
      from_page?: number
      to_page?: number
      font_size?: number
      margin?: number
    }
  | { op: 'flatten' }
  | {
      op: 'sanitize'
      metadata: boolean
      annotations: boolean
      attachments: boolean
      javascript_actions: boolean
      forms: boolean
    }
  | { op: 'compress'; max_dim?: number; quality?: number }
  | { op: 'protect'; password: string; owner_password?: string }

export type PipelinePresetId =
  | 'scan_clean'
  | 'scan_binarize'
  | 'confidential_share'
  | 'print_handout'
  | 'archive_slim'

export interface PipelinePresetOptions {
  watermarkText?: string
  pageNumberFormat?: string
  password?: string
  rtl?: boolean
}

/**
 * Build a ready-to-run sequence of `PipelineStepSpec` for a named preset.
 */
export function buildPresetPipeline(
  preset: PipelinePresetId,
  opts: PipelinePresetOptions = {},
): PipelineStepSpec[] {
  switch (preset) {
    case 'scan_clean':
      return [
        { op: 'remove_blank', threshold: 0.005 },
        {
          op: 'split2up',
          direction: 'vertical',
          rtl: opts.rtl ?? false,
          only_wide: true,
          overlap: 6,
        },
        { op: 'deskew', max_angle: 12, clean_borders: 0.02 },
        { op: 'grayscale', whiten_bg: true },
      ]
    case 'scan_binarize':
      return [
        { op: 'remove_blank', threshold: 0.005 },
        { op: 'deskew', max_angle: 12, clean_borders: 0.03 },
        { op: 'binarize', k: 0.2, window_size: 31, clean_borders: 0.02 },
      ]
    case 'confidential_share': {
      const steps: PipelineStepSpec[] = [
        {
          op: 'watermark',
          text: (opts.watermarkText || 'CONFIDENTIAL 机密').trim(),
          font_size: 42,
          opacity: 0.2,
          rotate: 45,
          position: 'tile',
          tile_spacing: 180,
          under: false,
        },
        {
          op: 'page_numbers',
          format: opts.pageNumberFormat || '{n} / {total}',
          position: 'bottom-center',
          start_number: 1,
          from_page: 1,
          to_page: 0,
          font_size: 10,
          margin: 24,
        },
        { op: 'flatten' },
        {
          op: 'sanitize',
          metadata: true,
          annotations: false,
          attachments: false,
          javascript_actions: true,
          forms: false,
        },
      ]
      if (opts.password && opts.password.trim()) {
        steps.push({ op: 'protect', password: opts.password.trim() })
      }
      return steps
    }
    case 'print_handout':
      return [
        { op: 'remove_blank', threshold: 0.005 },
        { op: 'resize', width: 595.28, height: 841.89 },
        {
          op: 'nup',
          cols: 2,
          rows: 2,
          landscape: true,
          margin: 18,
          gap: 12,
          border: true,
        },
        {
          op: 'page_numbers',
          format: opts.pageNumberFormat || '{n} / {total}',
          position: 'bottom-center',
          start_number: 1,
          from_page: 1,
          to_page: 0,
          font_size: 10,
          margin: 14,
        },
      ]
    case 'archive_slim':
      return [
        { op: 'remove_blank', threshold: 0.005 },
        {
          op: 'sanitize',
          metadata: true,
          annotations: false,
          attachments: false,
          javascript_actions: true,
          forms: false,
        },
        { op: 'compress', max_dim: 1600, quality: 75 },
      ]
  }
}

/** Validate a user-constructed or JSON-parsed pipeline array. */
export function validatePipelineSteps(steps: unknown): {
  valid: boolean
  error?: string
  steps: PipelineStepSpec[]
} {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { valid: false, error: 'Pipeline must contain at least one step', steps: [] }
  }
  const validOps = new Set([
    'remove_blank',
    'split_2up',
    'split2up',
    'single_large_page',
    'crop',
    'rotate',
    'deskew',
    'binarize',
    'grayscale',
    'resize',
    'nup',
    'booklet',
    'watermark',
    'page_numbers',
    'flatten',
    'sanitize',
    'compress',
    'protect',
  ])
  for (let i = 0; i < steps.length; i++) {
    const item = steps[i] as Record<string, unknown> | null
    if (!item || typeof item !== 'object' || typeof item.op !== 'string') {
      return { valid: false, error: `Step ${i + 1} is missing an 'op' field`, steps: [] }
    }
    if (!validOps.has(item.op)) {
      return { valid: false, error: `Step ${i + 1} has unknown op '${item.op}'`, steps: [] }
    }
  }
  return { valid: true, steps: steps as PipelineStepSpec[] }
}
