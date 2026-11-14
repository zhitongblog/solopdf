import { describe, expect, it } from 'vitest'
import {
  sanitizeFilenameStem,
  suggestPdfFilename,
  buildPresetPipeline,
  validatePipelineSteps,
} from '../src/index.js'

describe('Smart PDF Auto-Rename (suggestPdfFilename)', () => {
  it('builds a clean filename from XMP / Info metadata and strips forbidden characters', () => {
    const res = suggestPdfFilename({
      info: {
        Title: 'Attention Is All You Need: A New Architecture / Transformer?',
        Author: 'Ashish Vaswani; Noam Shazeer',
        CreationDate: 'D:20170612000000Z',
      },
    })
    expect(res.filename).toBe(
      '2017 - Vaswani et al. - Attention Is All You Need A New Architecture Transformer.pdf',
    )
    expect(res.stem).not.toMatch(/[/:?]/)
  })

  it('gracefully collapses missing fields in templates without leaving dangling hyphens', () => {
    const res = suggestPdfFilename(
      {
        info: {
          Title: '深度学习导论（第二版）',
        },
      },
      '{year} - {author} - {title}',
    )
    expect(res.filename).toBe('深度学习导论（第二版）.pdf')
  })

  it('handles Windows reserved names and long titles cleanly', () => {
    expect(sanitizeFilenameStem('CON')).toBe('_CON')
    expect(sanitizeFilenameStem('..hidden..')).toBe('hidden')
    const longTitle = 'Word '.repeat(40).trim()
    const truncated = sanitizeFilenameStem(longTitle, 50)
    expect(truncated.length).toBeLessThanOrEqual(50)
  })
})

describe('Multi-step PDF Pipeline presets & validation', () => {
  it('builds all 4 presets with valid steps', () => {
    for (const preset of [
      'scan_clean',
      'confidential_share',
      'print_handout',
      'archive_slim',
    ] as const) {
      const steps = buildPresetPipeline(preset, {
        watermarkText: 'INTERNAL',
        password: 'secret',
        rtl: true,
      })
      const check = validatePipelineSteps(steps)
      expect(check.valid).toBe(true)
      expect(check.steps.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('rejects empty or invalid pipeline step arrays', () => {
    expect(validatePipelineSteps([]).valid).toBe(false)
    expect(validatePipelineSteps([{ op: 'unknown_op' }]).valid).toBe(false)
    expect(validatePipelineSteps([{ op: 'split_2up', only_wide: true }]).valid).toBe(true)
  })
})
