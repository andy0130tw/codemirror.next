import {EditorView} from "./editorview"
import {getRoot} from "./dom"
import browser from "./browser"
import {EditorSelection} from "../../state/src"

const LINE_SEP = "\ufdda" // A Unicode 'non-character', used to denote newlines internally

export function applyDOMChange(view: EditorView, start: number, end: number, typeOver: boolean) {
  let bounds = view.docView.domBoundsAround(start, end, 0)
  if (!bounds) { view.updateState([], view.state); return }
  let {from, to} = bounds
  let selPoints = selectionPoints(view.contentDOM), reader = new DOMReader(selPoints)
  reader.readRange(bounds.startDOM, bounds.endDOM)
  let newSelection = selectionFromPoints(selPoints, from)

  let oldSel = view.state.selection.primary, preferredPos = oldSel.from, preferredSide = null
  // Prefer anchoring to end when Backspace is pressed
  if (view.inputState.lastKeyCode === 8 && view.inputState.lastKeyTime > Date.now() - 100) {
    preferredPos = oldSel.to
    preferredSide = "end"
  }
  view.inputState.lastKeyCode = 0

  let diff = findDiff(view.state.doc.slice(from, to, LINE_SEP), reader.text, preferredPos - from, preferredSide)
  // Heuristic to notice typing over a selected character
  if (!diff && typeOver && !oldSel.empty && newSelection && newSelection.primary.empty)
    diff = {from: oldSel.from - from, toA: oldSel.to - from, toB: oldSel.to - from}
  if (diff) {
    let start = from + diff.from, end = from + diff.toA, sel = view.state.selection.primary, startState = view.state
    // Android browsers don't fire reasonable key events for enter,
    // backspace, or delete. So this detects changes that look like
    // they're caused by those keys, and reinterprets them as key
    // events.
    if (browser.android) {
      if ((start == sel.from && end == sel.to && reader.text.slice(diff.from, diff.toB) == LINE_SEP && dispatchKey(view, "Enter", 10)) ||
          (start == sel.from - 1 && end == sel.to && diff.from == diff.toB && dispatchKey(view, "Backspace", 8)) ||
          (start == sel.from && end == sel.to + 1 && diff.from == diff.toB && dispatchKey(view, "Delete", 46))) {
        if (view.state == startState) view.updateState([], view.state) // Force redraw if necessary
        return
      }
    }
    let tr = startState.transaction
    if (start >= sel.from && end <= sel.to && end - start >= (sel.to - sel.from) / 3) {
      tr = tr.replaceSelection(reader.text.slice(sel.from - from, sel.to - diff.toA + diff.toB - from).split(LINE_SEP))
    } else {
      tr = tr.replace(start, end, reader.text.slice(diff.from, diff.toB).split(LINE_SEP))
      if (newSelection && !tr.selection.primary.eq(newSelection.primary))
        tr = tr.setSelection(tr.selection.replaceRange(newSelection.primary))
    }
    view.dispatch(tr.scrollIntoView())
  } else if (newSelection && !newSelection.primary.eq(oldSel)) {
    view.dispatch(view.state.transaction.setSelection(newSelection).scrollIntoView())
  } else {
    view.updateState([], view.state)
  }
}

function findDiff(a: string, b: string, preferredPos: number, preferredSide: string | null)
    : {from: number, toA: number, toB: number} | null {
  let minLen = Math.min(a.length, b.length)
  let from = 0
  while (from < minLen && a.charCodeAt(from) == b.charCodeAt(from)) from++
  if (from == minLen && a.length == b.length) return null
  let toA = a.length, toB = b.length
  while (toA > 0 && toB > 0 && a.charCodeAt(toA - 1) == b.charCodeAt(toB - 1)) { toA--; toB-- }

  if (preferredSide == "end") {
    let adjust = Math.max(0, from - Math.min(toA, toB))
    preferredPos -= toA + adjust - from
  }
  if (toA < from && a.length < b.length) {
    let move = preferredPos <= from && preferredPos >= toA ? from - preferredPos : 0
    from -= move
    toB = from + (toB - toA)
    toA = from
  } else if (toB < from) {
    let move = preferredPos <= from && preferredPos >= toB ? from - preferredPos : 0
    from -= move
    toA = from + (toA - toB)
    toB = from
  }
  return {from, toA, toB}
}

class DOMReader {
  text: string = ""
  constructor(private points: DOMPoint[]) {}

  readRange(start: Node | null, end: Node | null) {
    if (!start) return
    let parent = start.parentNode!
    for (let cur = start!;;) {
      this.findPointBefore(parent, cur)
      this.readNode(cur)
      let next: Node | null = cur.nextSibling
      if (next == end) break
      if (isBlockNode(cur) || (isBlockNode(next!) && cur.nodeName != "BR")) this.text += LINE_SEP
      cur = next!
    }
    this.findPointBefore(parent, end)
  }

  readNode(node: Node) {
    if (node.cmIgnore) return
    let view = node.cmView
    let fromView = view && view.overrideDOMText
    let text: string | undefined
    if (fromView != null) text = fromView.join(LINE_SEP)
    else if (node.nodeType == 3) text = node.nodeValue!
    else if (node.nodeName == "BR") text = node.nextSibling ? LINE_SEP : ""
    else if (node.nodeType == 1) this.readRange(node.firstChild, null)
    if (text != null) {
      this.findPointIn(node, text.length)
      this.text += text
    }
  }

  findPointBefore(node: Node, next: Node | null) {
    for (let point of this.points)
      if (point.node == node && node.childNodes[point.offset] == next)
        point.pos = this.text.length
  }

  findPointIn(node: Node, maxLen: number) {
    for (let point of this.points)
      if (point.node == node)
        point.pos = this.text.length + Math.min(point.offset, maxLen)
  }
}

function isBlockNode(node: Node): boolean {
  return node.nodeType == 1 && /^(DIV|P|LI|UL|OL|BLOCKQUOTE|DD|DT|H\d|SECTION|PRE)$/.test(node.nodeName)
}

class DOMPoint {
  pos: number = -1
  constructor(readonly node: Node, readonly offset: number) {}
}

function selectionPoints(dom: HTMLElement): DOMPoint[] {
  let root = getRoot(dom), result: DOMPoint[] = []
  if (root.activeElement != dom) return result
  let {anchorNode, anchorOffset, focusNode, focusOffset} = root.getSelection()!
  if (anchorNode) {
    result.push(new DOMPoint(anchorNode, anchorOffset))
    if (focusNode != anchorNode || focusOffset != anchorOffset)
      result.push(new DOMPoint(focusNode, focusOffset))
  }
  return result
}

function selectionFromPoints(points: DOMPoint[], base: number): EditorSelection | null {
  if (points.length == 0) return null
  let anchor = points[0].pos, head = points.length == 2 ? points[1].pos : anchor
  return anchor > -1 && head > -1 ? EditorSelection.single(anchor + base, head + base) : null
}

function dispatchKey(view: EditorView, name: string, code: number): boolean {
  let options = {key: name, code: name, keyCode: code, which: code, cancelable: true}
  let down = new KeyboardEvent("keydown", options)
  view.contentDOM.dispatchEvent(down)
  let up = new KeyboardEvent("keyup", options)
  view.contentDOM.dispatchEvent(up)
  return down.defaultPrevented || up.defaultPrevented
}
