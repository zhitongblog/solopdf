import { describe, it, expect } from 'vitest'
import {
  UndoStack, diffSections, applyChanges, placeSection, sectionText, diffSidecar, applyEdit,
} from '../src/history.js'
import { upsertAnnotation, removeAnnotation, parse } from '../src/sidecar.js'
import type { Annotation, SidecarMeta } from '../src/types.js'

const meta: SidecarMeta = { version: 1, pdfName: 'doc.pdf' }
const pdfPath = '/tmp/doc.pdf'

function ann(id: string, page = 1, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    anchor: { page, quads: [{ x1: 1, y1: 2, x2: 3, y2: 4 }], pre: 'a', post: 'b', text: 't' },
    excerpt: 'quoted ' + id,
    note: 'note ' + id,
    color: 'yellow',
    createdAt: '',
    ...extra,
  }
}

/** a three-section file with a user edit in the middle section */
function base(): string {
  let t = ''
  for (const id of ['aaa111', 'bbb222', 'ccc333']) t = upsertAnnotation(t, ann(id), pdfPath, meta)
  return t.replace('note bbb222', 'note bbb222\n\nuser wrote this in SoloMD #tag')
}

/** one edit + undo + redo, as the manager does it */
function roundTrip(oldText: string, newText: string): void {
  const ed = diffSidecar(oldText, newText)!
  expect(ed.changes.length).toBeGreaterThan(0)
  const undone = applyEdit(newText, ed, 'undo')
  expect(undone).toBe(oldText)
  const redone = applyEdit(undone!, ed, 'redo')
  expect(redone).toBe(newText)
}

describe('UndoStack', () => {
  it('undo/redo move entries between the two stacks', () => {
    const s = new UndoStack<number>()
    expect(s.canUndo).toBe(false)
    expect(s.undo()).toBeUndefined()
    s.push(1); s.push(2)
    expect(s.undo()).toBe(2)
    expect(s.canRedo).toBe(true)
    expect(s.peekRedo()).toBe(2)
    expect(s.redo()).toBe(2)
    expect(s.redo()).toBeUndefined()
    expect(s.undo()).toBe(2)
    expect(s.undo()).toBe(1)
    expect(s.canUndo).toBe(false)
  })

  it('a new push drops the redo branch', () => {
    const s = new UndoStack<string>()
    s.push('a'); s.push('b')
    s.undo()
    s.push('c')
    expect(s.canRedo).toBe(false)
    expect(s.undo()).toBe('c')
    expect(s.undo()).toBe('a')
  })

  it('is bounded — the oldest entry falls off', () => {
    const s = new UndoStack<number>(3)
    for (let i = 1; i <= 5; i++) s.push(i)
    expect([s.undo(), s.undo(), s.undo(), s.undo()]).toEqual([5, 4, 3, undefined])
  })

  it('clear empties both sides', () => {
    const s = new UndoStack<number>()
    s.push(1); s.push(2); s.undo()
    s.clear()
    expect(s.canUndo || s.canRedo).toBe(false)
  })
})

describe('section history', () => {
  it('create on an empty file: undo removes the section, redo restores it', () => {
    const t1 = upsertAnnotation('', ann('new001'), pdfPath, meta)
    const ch = diffSections('', t1)
    expect(ch).toEqual([expect.objectContaining({ id: 'new001', before: null })])
    const undone = applyChanges(t1, ch, 'undo')!
    expect(parse(undone).annotations).toHaveLength(0)
    expect(undone).toContain('solopdf:meta') // header survives
    const redone = applyChanges(undone, ch, 'redo')!
    expect(parse(redone).annotations.map((a) => a.id)).toEqual(['new001'])
  })

  it('create appended to an existing file round-trips byte-exact', () => {
    const t0 = base()
    roundTrip(t0, upsertAnnotation(t0, ann('ddd444'), pdfPath, meta))
  })

  it('delete restores the exact section, user text included, in place', () => {
    const t0 = base()
    for (const id of ['aaa111', 'bbb222', 'ccc333']) roundTrip(t0, removeAnnotation(t0, id))
    const del = removeAnnotation(t0, 'bbb222')
    const back = applyChanges(del, diffSections(t0, del), 'undo')!
    expect(sectionText(back, 'bbb222')).toContain('user wrote this in SoloMD #tag')
    expect(parse(back).annotations.map((a) => a.id)).toEqual(['aaa111', 'bbb222', 'ccc333'])
  })

  it('edit note / colour / kind round-trip', () => {
    const t0 = base()
    const a = parse(t0).annotations[0]
    roundTrip(t0, upsertAnnotation(t0, { ...a, note: 'changed' }, pdfPath, meta))
    roundTrip(t0, upsertAnnotation(t0, { ...a, color: 'pink' }, pdfPath, meta))
    roundTrip(t0, upsertAnnotation(t0, { ...a, kind: 'strike' }, pdfPath, meta))
  })

  it('a kind the history has never heard of is covered too', () => {
    const t0 = base()
    const t1 = upsertAnnotation(t0, ann('ink001', 2, { kind: 'ink' as never }), pdfPath, meta)
    roundTrip(t0, t1)
  })

  it('unrelated external edits elsewhere survive undo', () => {
    const t0 = base()
    const t1 = removeAnnotation(t0, 'aaa111')
    const ch = diffSections(t0, t1)
    // SoloMD edits another section before the user hits undo
    const ext = t1.replace('note ccc333', 'edited outside')
    const back = applyChanges(ext, ch, 'undo')!
    expect(back).toContain('edited outside')
    expect(sectionText(back, 'aaa111')).toBe(sectionText(t0, 'aaa111'))
  })

  it('refuses to undo over an external edit of the same section', () => {
    const t0 = base()
    const t1 = upsertAnnotation(t0, { ...parse(t0).annotations[2], note: 'mine' }, pdfPath, meta)
    const ch = diffSections(t0, t1)
    expect(applyChanges(t1.replace('mine', 'theirs'), ch, 'undo')).toBeNull()
    // …and to redo a create whose id reappeared meanwhile
    const t2 = upsertAnnotation(t0, ann('eee555'), pdfPath, meta)
    const c2 = diffSections(t0, t2)
    expect(applyChanges(t2, c2, 'redo')).toBeNull()
  })

  it('whitespace-only differences are not changes', () => {
    const t0 = base()
    expect(diffSections(t0, t0)).toEqual([])
    expect(diffSections(t0, t0 + '\n')).toEqual([])
  })

  it('placeSection falls back to append when the neighbour is gone', () => {
    const t0 = base()
    const sec = sectionText(t0, 'aaa111')!
    const without = removeAnnotation(removeAnnotation(t0, 'aaa111'), 'bbb222')
    const back = placeSection(without, 'aaa111', sec, 'bbb222')
    expect(parse(back).annotations.map((a) => a.id)).toEqual(['ccc333', 'aaa111'])
    expect(back).toMatch(/\n\n## p\.1 — 高亮 <!-- solopdf:id aaa111 -->/)
  })
})
