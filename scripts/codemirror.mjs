// Entry point for vendor/codemirror.min.js: the parts of CodeMirror that editor.js uses, exposed as window.CM.
// markdown() from lang-markdown is left out on purpose: it pulls in the HTML, CSS and JavaScript languages.
export { EditorView, Decoration, WidgetType, keymap, placeholder } from '@codemirror/view';
export { EditorState, EditorSelection, StateField, StateEffect, Annotation, Compartment, Prec, Transaction } from '@codemirror/state';
export { Language, syntaxTree, ensureSyntaxTree, indentUnit, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
export { commonmarkLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
export { history, historyKeymap, defaultKeymap, indentMore, indentLess } from '@codemirror/commands';
export { GFM } from '@lezer/markdown';
export { tags } from '@lezer/highlight';
