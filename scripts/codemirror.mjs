// Entry point for vendor/codemirror.min.js: the parts of CodeMirror that editor.js uses, exposed as window.CM.
// markdown() from lang-markdown is left out on purpose: it pulls in the HTML, CSS and JavaScript languages.
// Code blocks are highlighted with the small legacy stream modes instead, keyed by the name after the fence.
export { EditorView, Decoration, WidgetType, keymap, placeholder } from '@codemirror/view';
export { EditorState, EditorSelection, StateField, StateEffect, Annotation, Compartment, Prec, Transaction } from '@codemirror/state';
export { Language, StreamLanguage, syntaxTree, ensureSyntaxTree, indentUnit, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
export { commonmarkLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
export { history, historyKeymap, defaultKeymap, indentMore, indentLess, undo, redo } from '@codemirror/commands';
export { GFM, parseCode } from '@lezer/markdown';
export { tags, classHighlighter } from '@lezer/highlight';
import { javascript, typescript, json } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { css, sCSS, less } from '@codemirror/legacy-modes/mode/css';
import { html, xml } from '@codemirror/legacy-modes/mode/xml';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { c, cpp, java, csharp, kotlin, scala, objectiveC, dart } from '@codemirror/legacy-modes/mode/clike';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { r } from '@codemirror/legacy-modes/mode/r';
export const codeModes = {
  javascript, typescript, json, python, shell, css, scss: sCSS, less, html, xml, sql: standardSQL, c, cpp, java, csharp,
  kotlin, scala, objectivec: objectiveC, dart, go, rust, ruby, swift, yaml, toml, diff, lua, powershell: powerShell,
  dockerfile: dockerFile, r
};
