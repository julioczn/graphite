<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, placeholder, Decoration, ViewPlugin,
} from '@codemirror/view'
import { EditorState, Compartment, Prec, RangeSetBuilder } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql, PostgreSQL, MySQL, SQLite } from '@codemirror/lang-sql'
import { syntaxHighlighting, syntaxTree, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippet, snippetCompletion } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import { splitStatements } from '../../shared/sql.mjs'
import { shortcut } from '../lib/keys'
import { snippetsFor, plain } from '../lib/snippets'
import { t, i18n } from '../lib/i18n'

const props = defineProps({
  modelValue: String,
  dialect: String,
  schema: Object,
  readOnly: Boolean,
})
const emit = defineEmits(['update:modelValue', 'run', 'runCurrent', 'save'])

const host = ref(null)
let view
const langConf = new Compartment()
const placeholderConf = new Compartment()

const DIALECTS = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite }

// Monochrome syntax: hierarchy by weight, brightness and style instead of hue.
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#ffffff', fontWeight: '600' },
  { tag: [tags.operatorKeyword, tags.modifier], color: '#e0e0e0', fontWeight: '600' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: '#c8c8c8', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: '#9e9e9e' },
  { tag: [tags.number, tags.bool, tags.null], color: '#d4d4d4' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#5e5e5e', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: '#8c8c8c' },
  { tag: [tags.name, tags.propertyName], color: '#cfcfcf' },
  { tag: tags.special(tags.name), color: '#bdbdbd', textDecoration: 'underline', textDecorationColor: '#4a4a4a' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface-2)', color: '#d9d9d9', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: '#fff', padding: '10px 0' },
  '.cm-cursor': { borderLeftColor: '#fff', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: '#4d4d4d', border: 'none', paddingLeft: '6px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#a0a0a0' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(255,255,255,0.16) !important' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255,255,255,0.07)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(255,255,255,0.14)', outline: '1px solid #555' },
  '.cm-current-stmt': { backgroundColor: 'rgba(255,255,255,0.03)', boxShadow: 'inset 2px 0 0 #6b6b6b' },
  '.cm-placeholder': { color: '#4f4f4f' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-3)', border: '1px solid var(--line-3)', borderRadius: '6px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '260px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px !important', color: '#bdbdbd' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--surface-6)', color: '#fff' },
  '.cm-completionIcon': { filter: 'grayscale(1) brightness(1.4)', opacity: '0.55', width: '1.1em' },
  '.cm-completionDetail': { color: '#6b6b6b', fontStyle: 'normal', marginLeft: '10px' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700', color: '#fff' },
  '.cm-tooltip.cm-completionInfo': { padding: '8px 10px', maxWidth: '460px' },
  '.cm-snippet-info': { margin: 0, font: '11.5px/1.5 var(--mono)', color: '#bdbdbd', whiteSpace: 'pre' },
  '.cm-snippet-info b': { display: 'block', marginBottom: '4px', font: '600 11px var(--font)', color: '#fff' },
  '.cm-snippetField': { backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: '2px' },
  '.cm-panels': { backgroundColor: 'var(--surface-3)', color: 'var(--fg)', borderColor: 'var(--line-2)' },
  '.cm-panel input, .cm-panel button': { color: 'var(--fg)' },
  '.cm-textfield': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--line-3)', borderRadius: '4px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface-4)', border: '1px solid var(--line-3)', borderRadius: '4px' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255,255,255,0.12)', outline: '1px solid #666' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(255,255,255,0.25)' },
}, { dark: true })

function statementAt(doc, pos) {
  const parts = splitStatements(doc)
  if (!parts.length) return null
  return parts.find((p) => pos >= p.start && pos <= p.end + 1) || parts.findLast((p) => p.end <= pos) || parts[0]
}

// Highlight the lines of the statement under the cursor when the script has several.
const currentStatement = ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = this.build(v) }
  update(u) { if (u.docChanged || u.selectionSet) this.decorations = this.build(u.view) }
  build(v) {
    const builder = new RangeSetBuilder()
    const doc = v.state.doc.toString()
    const parts = splitStatements(doc)
    if (parts.length < 2) return builder.finish()
    const st = statementAt(doc, v.state.selection.main.head)
    if (!st) return builder.finish()
    const offset = doc.slice(st.start, st.end).search(/\S/)
    const from = v.state.doc.lineAt(st.start + Math.max(offset, 0)).number
    const to = v.state.doc.lineAt(st.end).number
    for (let l = from; l <= to; l++) {
      builder.add(v.state.doc.line(l).from, v.state.doc.line(l).from, Decoration.line({ class: 'cm-current-stmt' }))
    }
    return builder.finish()
  }
}, { decorations: (p) => p.decorations })

// Snippets offered next to the SQL completions: typing a trigger such as
// `sel`, `ins` or `lj` and picking it expands the template with tab stops.
function snippetSource(dialect) {
  const options = snippetsFor(dialect).map((s) => snippetCompletion(s.body, {
    label: s.trigger,
    detail: s.title,
    type: 'text',
    boost: 1,
    info: () => {
      const el = document.createElement('pre')
      el.className = 'cm-snippet-info'
      const head = document.createElement('b')
      head.textContent = t('Snippet · {title}', { title: s.title })
      el.append(head, plain(s.body))
      return el
    },
  }))
  return (ctx) => {
    const word = ctx.matchBefore(/\w+/)
    if (!word && !ctx.explicit) return null
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1)
    if (/String|Comment|QuotedIdentifier/.test(node.name)) return null
    return { from: word ? word.from : ctx.pos, options, validFor: /^\w*$/ }
  }
}

function placeholderText() {
  return placeholder(t('-- escreva SQL aqui.  {all} executa tudo (ou a seleção), {current} executa a instrução atual', {
    all: shortcut('mod', 'enter'), current: shortcut('mod', 'shift', 'enter'),
  }))
}

function language() {
  const support = sql({ dialect: DIALECTS[props.dialect] || PostgreSQL, schema: props.schema || {}, upperCaseKeywords: false })
  return [support, support.language.data.of({ autocomplete: snippetSource(props.dialect) })]
}

onMounted(() => {
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue || '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true }),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        langConf.of(language()),
        currentStatement,
        placeholderConf.of(placeholderText()),
        EditorState.readOnly.of(props.readOnly),
        theme,
        Prec.highest(keymap.of([
          { key: 'Mod-Enter', run: () => (emit('run'), true) },
          { key: 'Mod-Shift-Enter', run: () => (emit('runCurrent'), true) },
          { key: 'Mod-s', run: () => (emit('save'), true) },
        ])),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        }),
      ],
    }),
  })
})

watch(() => [props.schema, props.dialect], () => {
  view?.dispatch({ effects: langConf.reconfigure(language()) })
})

// Snippet titles, tab-stop names and the placeholder follow the language.
watch(() => i18n.locale, () => {
  view?.dispatch({ effects: [langConf.reconfigure(language()), placeholderConf.reconfigure(placeholderText())] })
})

watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v || '' } })
  }
})

onBeforeUnmount(() => view?.destroy())

defineExpose({
  focus: () => view?.focus(),
  // Expand a snippet template: over the selection, or on a new line below the
  // cursor when its line already has text.
  insertSnippet(body) {
    if (!view) return
    const sel = view.state.selection.main
    let { from, to } = sel
    let text = body
    if (sel.empty) {
      const line = view.state.doc.lineAt(sel.head)
      if (line.text.trim()) {
        from = to = line.to
        text = '\n\n' + body
      }
    }
    view.focus()
    snippet(text)(view, null, from, to)
  },
  // Plain text (no tab stops): over the selection, or below the cursor's line.
  insertText(body) {
    if (!view) return
    const sel = view.state.selection.main
    let { from, to } = sel
    let text = body
    if (sel.empty && view.state.doc.length) {
      const line = view.state.doc.lineAt(sel.head)
      if (line.text.trim()) {
        from = to = line.to
        text = '\n\n' + body
      }
    }
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length - body.length, head: from + text.length }, scrollIntoView: true })
    view.focus()
  },
  // Selection if there is one, otherwise the whole document.
  textForRun() {
    const s = view.state.selection.main
    return s.empty ? view.state.doc.toString() : view.state.sliceDoc(s.from, s.to)
  },
  currentStatement() {
    const doc = view.state.doc.toString()
    return statementAt(doc, view.state.selection.main.head)?.text || ''
  },
})
</script>

<template>
  <div ref="host" class="editor" />
</template>

<style scoped>
.editor { height: 100%; overflow: hidden; }
.editor :deep(.cm-editor.cm-focused) { outline: none; }
</style>
