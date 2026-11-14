/**
 * Region Math / Formula Recognition to LaTeX (`$...$` / `$$...$$`)
 *
 * Converts spatially positioned PDF text items (including Unicode math symbols,
 * Greek letters, superscripts/subscripts via baseline & height geometry, and
 * stacked numerator/denominator fractions) into clean LaTeX expressions.
 */
import type { SnipRect, SnipTextItem } from './table-snip.js'

export interface MathSnipItem extends SnipTextItem {
  fontName?: string
}

export interface ExtractMathOptions {
  /**
   * Coordinate system vertical direction:
   * - `'down'` (default): top-down viewport / normalized coordinates (smaller Y = higher on page)
   * - `'up'`: PDF bottom-up user space coordinates (larger Y = higher on page)
   */
  yDirection?: 'down' | 'up'
  /** Force display-mode (`$$ ... $$`) output; otherwise auto-detected. */
  block?: boolean
}

export interface MathSnipResult {
  /** Raw LaTeX expression without surrounding `$` delimiters */
  body: string
  /** Delimited LaTeX (`$...$` or `$$\n...\n$$`) */
  latex: string
  /** Plain concatenated text before LaTeX conversion */
  rawText: string
  /** Whether the formula was formatted as a display block */
  isBlock: boolean
}

const UNICODE_MATH_MAP: Record<string, string> = {
  // Greek lowercase
  α: '\\alpha',
  β: '\\beta',
  γ: '\\gamma',
  δ: '\\delta',
  ε: '\\varepsilon',
  ϵ: '\\epsilon',
  ζ: '\\zeta',
  η: '\\eta',
  θ: '\\theta',
  ϑ: '\\vartheta',
  ι: '\\iota',
  κ: '\\kappa',
  λ: '\\lambda',
  μ: '\\mu',
  ν: '\\nu',
  ξ: '\\xi',
  π: '\\pi',
  ρ: '\\rho',
  ϱ: '\\varrho',
  σ: '\\sigma',
  ς: '\\varsigma',
  τ: '\\tau',
  υ: '\\upsilon',
  φ: '\\varphi',
  ϕ: '\\phi',
  χ: '\\chi',
  ψ: '\\psi',
  ω: '\\omega',
  // Greek uppercase
  Γ: '\\Gamma',
  Δ: '\\Delta',
  Θ: '\\Theta',
  Λ: '\\Lambda',
  Ξ: '\\Xi',
  Π: '\\Pi',
  Σ: '\\Sigma',
  Υ: '\\Upsilon',
  Φ: '\\Phi',
  Ψ: '\\Psi',
  Ω: '\\Omega',
  // Big operators & calculus
  '∑': '\\sum',
  '∏': '\\prod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '∇': '\\nabla',
  '∂': '\\partial',
  '√': '\\sqrt',
  '∞': '\\infty',
  // Binary operators & relations
  '±': '\\pm',
  '∓': '\\mp',
  '×': '\\times',
  '÷': '\\div',
  '·': '\\cdot',
  '⋅': '\\cdot',
  '∗': '\\ast',
  '∘': '\\circ',
  '⊕': '\\oplus',
  '⊗': '\\otimes',
  '⊙': '\\odot',
  '≤': '\\le',
  '⩽': '\\leqslant',
  '≥': '\\ge',
  '⩾': '\\geqslant',
  '≠': '\\ne',
  '≈': '\\approx',
  '≡': '\\equiv',
  '≅': '\\cong',
  '∼': '\\sim',
  '≃': '\\simeq',
  '∝': '\\propto',
  '≪': '\\ll',
  '≫': '\\gg',
  // Set theory & logic
  '∈': '\\in',
  '∉': '\\notin',
  '∋': '\\ni',
  '⊂': '\\subset',
  '⊃': '\\supset',
  '⊆': '\\subseteq',
  '⊇': '\\supseteq',
  '∪': '\\cup',
  '∩': '\\cap',
  '∅': '\\emptyset',
  '∀': '\\forall',
  '∃': '\\exists',
  '∄': '\\nexists',
  '¬': '\\neg',
  '∧': '\\land',
  '∨': '\\lor',
  '⊢': '\\vdash',
  '⊨': '\\models',
  '⊥': '\\perp',
  '∥': '\\parallel',
  // Arrows & misc
  '→': '\\to',
  '←': '\\leftarrow',
  '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto',
  '↑': '\\uparrow',
  '↓': '\\downarrow',
  '…': '\\dots',
  '⋯': '\\cdots',
  '⋮': '\\vdots',
  '⋱': '\\ddots',
  '′': "'",
  '″': "''",
  '−': '-',
  '–': '-',
  '⟨': '\\langle',
  '⟩': '\\rangle',
  '⌈': '\\lceil',
  '⌉': '\\rceil',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',
  'ℝ': '\\mathbb{R}',
  'ℤ': '\\mathbb{Z}',
  'ℕ': '\\mathbb{N}',
  'ℚ': '\\mathbb{Q}',
  'ℂ': '\\mathbb{C}',
  '𝔼': '\\mathbb{E}',
  'ℙ': '\\mathbb{P}',
  'ℓ': '\\ell',
  'ℏ': '\\hbar',
}

const SUPERSCRIPT_CHARS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
  '⁼': '=',
  '⁽': '(',
  '⁾': ')',
  'ⁿ': 'n',
  'ⁱ': 'i',
}

const SUBSCRIPT_CHARS: Record<string, string> = {
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
  '₊': '+',
  '₋': '-',
  '₌': '=',
  '₍': '(',
  '₎': ')',
  'ₐ': 'a',
  'ₑ': 'e',
  'ₕ': 'h',
  'ᵢ': 'i',
  'ⱼ': 'j',
  'ₖ': 'k',
  'ₗ': 'l',
  'ₘ': 'm',
  'ₙ': 'n',
  'ₒ': 'o',
  'ₚ': 'p',
  'ᵣ': 'r',
  'ₛ': 's',
  'ₜ': 't',
  'ᵤ': 'u',
  'ᵥ': 'v',
  'ₓ': 'x',
}

const MATH_FUNC_NAMES = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'log',
  'ln',
  'lg',
  'exp',
  'lim',
  'sup',
  'inf',
  'max',
  'min',
  'argmax',
  'argmin',
  'det',
  'dim',
  'ker',
  'deg',
  'gcd',
  'Pr',
  'softmax',
])

function formatScriptArg(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return ''
  if (trimmed.length === 1 && /^[a-zA-Z0-9]$/.test(trimmed)) return trimmed
  return `{${trimmed}}`
}

/**
 * Convert a raw Unicode math string into valid LaTeX tokens.
 */
export function textToLatex(raw: string): string {
  if (!raw || !raw.trim()) return ''

  let out = ''
  let i = 0
  const chars = Array.from(raw)

  while (i < chars.length) {
    const ch = chars[i]

    // Group contiguous Unicode superscript characters into ^{...}
    if (ch in SUPERSCRIPT_CHARS) {
      let sup = ''
      while (i < chars.length && chars[i] in SUPERSCRIPT_CHARS) {
        sup += SUPERSCRIPT_CHARS[chars[i]]
        i++
      }
      out += `^${formatScriptArg(sup)}`
      continue
    }

    // Group contiguous Unicode subscript characters into _{...}
    if (ch in SUBSCRIPT_CHARS) {
      let sub = ''
      while (i < chars.length && chars[i] in SUBSCRIPT_CHARS) {
        sub += SUBSCRIPT_CHARS[chars[i]]
        i++
      }
      out += `_${formatScriptArg(sub)}`
      continue
    }

    // Check √ followed by parenthesized or contiguous token
    if (ch === '√') {
      i++
      while (i < chars.length && chars[i] === ' ') i++
      if (i < chars.length && chars[i] === '(') {
        let depth = 0
        let inner = ''
        i++ // skip '('
        depth = 1
        while (i < chars.length && depth > 0) {
          if (chars[i] === '(') depth++
          else if (chars[i] === ')') {
            depth--
            if (depth === 0) {
              i++
              break
            }
          }
          inner += chars[i]
          i++
        }
        out += `\\sqrt{${textToLatex(inner)}}`
      } else {
        let rad = ''
        while (i < chars.length && /[a-zA-Z0-9]/.test(chars[i])) {
          rad += chars[i]
          i++
        }
        out += rad ? `\\sqrt{${rad}}` : '\\sqrt{}'
      }
      continue
    }

    if (ch in UNICODE_MATH_MAP) {
      const mapped = UNICODE_MATH_MAP[ch]
      const next = chars[i + 1] ?? ''
      if (mapped.startsWith('\\') && /^[a-zA-Z]/.test(next)) {
        out += `${mapped} `
      } else {
        out += mapped
      }
      i++
      continue
    }

    out += ch
    i++
  }

  // Convert standalone function names (sin, cos, log, lim, max, min, softmax...) to \sin, \operatorname{softmax}
  out = out.replace(/(?<!\\)\b([a-zA-Z]{2,7})\b/g, (match) => {
    if (!MATH_FUNC_NAMES.has(match)) return match
    if (match === 'argmax' || match === 'argmin' || match === 'softmax') {
      return `\\operatorname{${match}}`
    }
    return `\\${match}`
  })

  // Collapse redundant whitespace while keeping spaces after LaTeX control words
  out = out.replace(/[ \t]+/g, ' ').trim()
  return out
}

function median(xs: number[]): number {
  if (!xs.length) return 10
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function overlapsRect(item: SnipTextItem, rect: SnipRect): boolean {
  const iw = Math.max(0, item.width)
  const ih = Math.max(0, item.height)
  const rx2 = rect.x + rect.width
  const ry2 = rect.y + rect.height
  return item.x + iw >= rect.x && item.x <= rx2 && item.y + ih >= rect.y && item.y <= ry2
}

interface NormalizedToken {
  str: string
  x: number
  /** Visual top-down Y (smaller = higher on page) */
  topY: number
  width: number
  height: number
}

function isFractionBarToken(t: NormalizedToken, medH: number): boolean {
  const s = t.str.trim()
  if (/^[—―─━_\-=]+$/.test(s) && s !== '=' && t.width >= medH * 0.6) {
    return true
  }
  return false
}

function renderHorizontalTokens(tokens: NormalizedToken[], baseH: number): string {
  if (!tokens.length) return ''
  const sorted = [...tokens].sort((a, b) => a.x - b.x)

  // Determine main baseline (median topY of full-size tokens)
  const mainCandidates = sorted.filter((t) => t.height >= baseH * 0.8)
  const mainTopY = median((mainCandidates.length ? mainCandidates : sorted).map((t) => t.topY))

  let result = ''
  let i = 0
  while (i < sorted.length) {
    const cur = sorted[i]
    const curLatex = textToLatex(cur.str)

    // Look ahead for attached superscripts and/or subscripts that immediately follow in X
    const supTokens: NormalizedToken[] = []
    const subTokens: NormalizedToken[] = []
    let j = i + 1
    let lastXEnd = cur.x + cur.width

    while (j < sorted.length) {
      const nxt = sorted[j]
      const xGap = nxt.x - lastXEnd
      if (xGap > baseH * 1.1) break

      // Compare vertical center or top relative to current token / main line
      const dyTop = nxt.topY - cur.topY
      const isSmaller = nxt.height <= cur.height * 0.85
      const isSup =
        dyTop < -cur.height * 0.18 || (isSmaller && nxt.topY < mainTopY - baseH * 0.12)
      const isSub =
        dyTop > cur.height * 0.22 || (isSmaller && nxt.topY > mainTopY + baseH * 0.18)

      if (isSup && !isSub) {
        supTokens.push(nxt)
        lastXEnd = Math.max(lastXEnd, nxt.x + nxt.width)
        j++
      } else if (isSub && !isSup) {
        subTokens.push(nxt)
        lastXEnd = Math.max(lastXEnd, nxt.x + nxt.width)
        j++
      } else {
        break
      }
    }

    if (result && !result.endsWith(' ') && !result.endsWith('{')) {
      const prev = sorted[i - 1]
      if (prev && cur.x - (prev.x + prev.width) > baseH * 0.35) {
        result += ' '
      } else if (/\\[a-zA-Z]+$/.test(result) && /^[a-zA-Z0-9]/.test(curLatex)) {
        result += ' '
      }
    }

    result += curLatex
    if (subTokens.length > 0) {
      const subStr = subTokens.map((t) => textToLatex(t.str)).join('')
      result += `_${formatScriptArg(subStr)}`
    }
    if (supTokens.length > 0) {
      const supStr = supTokens.map((t) => textToLatex(t.str)).join('')
      result += `^${formatScriptArg(supStr)}`
    }

    i = j
  }

  return result.trim()
}

/**
 * Extract a structured LaTeX formula from spatially positioned PDF text items.
 */
export function extractLatexFromItems(
  items: MathSnipItem[],
  rect?: SnipRect,
  opts: ExtractMathOptions = {},
): MathSnipResult {
  const yDir = opts.yDirection ?? 'down'

  const filtered = items.filter((item) => {
    if (!item.str || !item.str.trim()) return false
    if (rect && !overlapsRect(item, rect)) return false
    return true
  })

  if (!filtered.length) {
    return { body: '', latex: '', rawText: '', isBlock: false }
  }

  const medH = median(filtered.map((i) => i.height).filter((h) => h > 0))
  const maxY = Math.max(...filtered.map((i) => i.y))

  // Convert all tokens into visual top-down coordinates (`topY`: smaller = higher)
  const tokens: NormalizedToken[] = filtered.map((it) => {
    const h = it.height > 0 ? it.height : medH
    const w = it.width > 0 ? it.width : it.str.trim().length * h * 0.55
    const topY = yDir === 'up' ? maxY - it.y : it.y
    return {
      str: it.str.trim(),
      x: it.x,
      topY,
      width: w,
      height: h,
    }
  })

  const rawText = [...tokens]
    .sort((a, b) => (Math.abs(a.topY - b.topY) <= medH * 0.45 ? a.x - b.x : a.topY - b.topY))
    .map((t) => t.str)
    .join(' ')

  // Check for explicit fraction bar tokens or 2-row stacked fraction structure
  const used = new Set<number>()
  const compositeTokens: NormalizedToken[] = []

  for (let idx = 0; idx < tokens.length; idx++) {
    const bar = tokens[idx]
    if (!isFractionBarToken(bar, medH)) continue

    const bx1 = bar.x - medH * 0.4
    const bx2 = bar.x + bar.width + medH * 0.4
    const numIdxs: number[] = []
    const denIdxs: number[] = []

    tokens.forEach((cand, cIdx) => {
      if (cIdx === idx || used.has(cIdx)) return
      const cxMid = cand.x + cand.width * 0.5
      if (cxMid < bx1 || cxMid > bx2) return
      const dy = cand.topY - bar.topY
      if (dy < -medH * 0.15 && dy >= -medH * 2.5) {
        numIdxs.push(cIdx)
      } else if (dy > medH * 0.15 && dy <= medH * 2.5) {
        denIdxs.push(cIdx)
      }
    })

    if (numIdxs.length > 0 && denIdxs.length > 0) {
      used.add(idx)
      numIdxs.forEach((k) => used.add(k))
      denIdxs.forEach((k) => used.add(k))
      const numLatex = renderHorizontalTokens(
        numIdxs.map((k) => tokens[k]),
        medH,
      )
      const denLatex = renderHorizontalTokens(
        denIdxs.map((k) => tokens[k]),
        medH,
      )
      compositeTokens.push({
        str: `\\frac{${numLatex}}{${denLatex}}`,
        x: bar.x,
        topY: bar.topY,
        width: bar.width,
        height: medH,
      })
    }
  }

  for (let idx = 0; idx < tokens.length; idx++) {
    if (!used.has(idx)) compositeTokens.push(tokens[idx])
  }

  // Also detect bar-less stacked 2-line fractions when two tokens share X center and are vertically stacked by ~1.0-2.0x medH
  const body = renderHorizontalTokens(compositeTokens, medH)
  const isBlock =
    opts.block ??
    (/\\(frac|sum|prod|int|iint|oint|begin)\b/.test(body) || body.length > 48)

  const latex = body ? (isBlock ? `$$\n${body}\n$$` : `$${body}$`) : ''
  return { body, latex, rawText, isBlock }
}
