/**
 * Undo/redo for sidecar edits — pure text logic, no I/O.
 *
 * The unit of history is the raw `##` section of one annotation, keyed by
 * its anchor id. A command records, per touched id, the section text before
 * and after the edit (null = absent). Undo puts the "before" text back by id
 * (or removes the section), redo puts the "after" text back — the same
 * locate-and-replace splice the rest of the sidecar code uses, so edits to
 * OTHER sections made in the meantime are never touched.
 *
 * Because the diff is taken on sidecar text, every annotation kind is covered
 * the moment it is written through the manager, including kinds added later;
 * and a restored delete comes back byte-for-byte (user-written note, tags,
 * anything the user typed into that section in SoloMD).
 */

const ID_RE = /<!--\s*solopdf:id\s+([A-Za-z0-9_-]+)\s*-->/

interface RawSection {
  id: string
  text: string
  start: number
  end: number
}

/** `##` sections that carry a solopdf id, in file order. */
function sections(text: string): RawSection[] {
  const heads: number[] = []
  const re = /^## .*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) heads.push(m.index)
  const out: RawSection[] = []
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i]
    const end = i + 1 < heads.length ? heads[i + 1] : text.length
    const lineEnd = text.indexOf('\n', start)
    const header = text.slice(start, lineEnd < 0 ? end : lineEnd)
    const idm = header.match(ID_RE)
    if (idm) out.push({ id: idm[1], text: text.slice(start, end), start, end })
  }
  return out
}

/** Raw text of one annotation's section (header through trailing blank line). */
export function sectionText(text: string, id: string): string | null {
  return sections(text).find((s) => s.id === id)?.text ?? null
}

/** One id's before/after state inside a command. */
export interface SectionChange {
  id: string
  /** section text before the edit; null = did not exist */
  before: string | null
  /** section text after the edit; null = removed */
  after: string | null
  /** id of the section that followed it before the edit (restore position) */
  nextBefore: string | null
  /** id of the section that followed it after the edit */
  nextAfter: string | null
}

/** Which annotation sections an edit added, removed or changed. */
export function diffSections(oldText: string, newText: string): SectionChange[] {
  const a = sections(oldText)
  const b = sections(newText)
  const am = new Map(a.map((s, i) => [s.id, { s, next: a[i + 1]?.id ?? null }]))
  const bm = new Map(b.map((s, i) => [s.id, { s, next: b[i + 1]?.id ?? null }]))
  const out: SectionChange[] = []
  const ids = [...new Set([...a.map((s) => s.id), ...b.map((s) => s.id)])]
  for (const id of ids) {
    const x = am.get(id)
    const y = bm.get(id)
    // a pure spacing difference at the section tail is not an edit
    if (x && y && x.s.text.trimEnd() === y.s.text.trimEnd()) continue
    out.push({
      id,
      before: x?.s.text ?? null,
      after: y?.s.text ?? null,
      nextBefore: x?.next ?? null,
      nextAfter: y?.next ?? null,
    })
  }
  return out
}

/**
 * Put a section into the text by id: replace it when present, otherwise
 * insert it back in front of `beforeId` (its old neighbour), otherwise
 * append. `section === null` removes the id.
 */
export function placeSection(
  text: string,
  id: string,
  section: string | null,
  beforeId: string | null = null,
): string {
  const secs = sections(text)
  const cur = secs.find((s) => s.id === id)
  if (section === null) return cur ? text.slice(0, cur.start) + text.slice(cur.end) : text
  if (cur) return text.slice(0, cur.start) + section + text.slice(cur.end)
  const next = beforeId ? secs.find((s) => s.id === beforeId) : undefined
  if (next) return text.slice(0, next.start) + withBlankTail(section) + text.slice(next.start)
  const sep = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return text + sep + section
}

function withBlankTail(s: string): string {
  return s.endsWith('\n\n') ? s : s.endsWith('\n') ? s + '\n' : s + '\n\n'
}

/**
 * Apply a command backwards (undo) or forwards (redo). Returns null when
 * the current text no longer matches what the command expects — the section
 * was edited outside the app — so the caller can drop history instead of
 * clobbering the user's edit.
 */
export function applyChanges(
  text: string,
  changes: SectionChange[],
  dir: 'undo' | 'redo',
): string | null {
  for (const c of changes) {
    const expect = dir === 'undo' ? c.after : c.before
    const cur = sectionText(text, c.id)
    const same = cur === null || expect === null ? cur === expect : cur.trimEnd() === expect.trimEnd()
    if (!same) return null
  }
  let out = text
  // undo walks backwards so a batch unwinds in reverse order
  const list = dir === 'undo' ? [...changes].reverse() : changes
  for (const c of list) {
    out = dir === 'undo'
      ? placeSection(out, c.id, c.before, c.nextBefore)
      : placeSection(out, c.id, c.after, c.nextAfter)
  }
  return out
}

/**
 * One recorded edit: the touched sections plus the file's trailing
 * whitespace on either side (appending a section adds a separator to the
 * section before it; putting that back keeps undo byte-exact).
 */
export interface SidecarEdit {
  changes: SectionChange[]
  tailBefore: string
  tailAfter: string
}

const tailOf = (t: string): string => t.slice(t.trimEnd().length)

/** Diff two versions of a sidecar; null when no annotation section changed. */
export function diffSidecar(oldText: string, newText: string): SidecarEdit | null {
  const changes = diffSections(oldText, newText)
  if (!changes.length) return null
  return { changes, tailBefore: tailOf(oldText), tailAfter: tailOf(newText) }
}

/** applyChanges + restore the file tail recorded for that side. */
export function applyEdit(text: string, edit: SidecarEdit, dir: 'undo' | 'redo'): string | null {
  const out = applyChanges(text, edit.changes, dir)
  if (out === null) return null
  const tail = dir === 'undo' ? edit.tailBefore : edit.tailAfter
  // an empty "before" means the file did not exist yet — keep the header's own
  return out.trim() && tail ? out.trimEnd() + tail : out
}

/** Bounded two-stack history. A new push drops the redo branch. */
export class UndoStack<T> {
  private done: T[] = []
  private undone: T[] = []

  constructor(private limit = 100) {}

  get canUndo(): boolean { return this.done.length > 0 }
  get canRedo(): boolean { return this.undone.length > 0 }
  /** the entry the next undo would revert */
  peekUndo(): T | undefined { return this.done[this.done.length - 1] }
  /** the entry the next redo would re-apply */
  peekRedo(): T | undefined { return this.undone[this.undone.length - 1] }

  push(entry: T): void {
    this.done.push(entry)
    if (this.done.length > this.limit) this.done.shift()
    this.undone = []
  }

  /** move the top entry to the redo side and return it */
  undo(): T | undefined {
    const e = this.done.pop()
    if (e !== undefined) this.undone.push(e)
    return e
  }

  /** move the top redo entry back to the undo side and return it */
  redo(): T | undefined {
    const e = this.undone.pop()
    if (e !== undefined) this.done.push(e)
    return e
  }

  clear(): void {
    this.done = []
    this.undone = []
  }
}
