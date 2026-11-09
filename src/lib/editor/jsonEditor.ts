import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import {
    Decoration,
    type DecorationSet,
    drawSelection,
    EditorView,
    GutterMarker,
    gutterLineClass,
    keymap,
    lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { changedLines } from "@/lib/grid/jsonDiff";

/**
 * JSON tokens: keys, strings, numbers, and true / false / null. Keys are strings followed by a
 * colon on the same line, which is how every formatted JSON value writes them.
 */
const json = StreamLanguage.define<null>({
    name: "json",
    startState: () => null,
    token(stream) {
        if (stream.eatSpace()) return null;
        if (stream.peek() === '"') {
            stream.next();
            let escaped = false;
            for (;;) {
                const ch = stream.next();
                if (ch === undefined) break;
                if (ch === '"' && !escaped) break;
                escaped = !escaped && ch === "\\";
            }
            return stream.match(/^\s*:/, false) ? "propertyName" : "string";
        }
        if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";
        if (stream.match(/^(true|false)\b/)) return "bool";
        if (stream.match(/^null\b/)) return "null";
        stream.next();
        return null;
    },
});

const highlight = HighlightStyle.define([
    { tag: t.propertyName, color: "var(--color-text)" },
    { tag: t.string, color: "var(--syntax-string)" },
    { tag: t.number, color: "var(--syntax-number)" },
    { tag: [t.bool, t.null], color: "var(--syntax-keyword)" },
]);

const theme = EditorView.theme({
    "&": {
        backgroundColor: "var(--color-bg)",
        color: "var(--color-text)",
        fontSize: "var(--font-size-xs)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px" },
    ".cm-content": { caretColor: "var(--color-text)", padding: "8px 0" },
    ".cm-cursor": { borderLeftColor: "var(--color-text)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--color-selected) !important",
    },
    ".cm-gutters": { backgroundColor: "var(--color-bg)", color: "var(--color-text-faint)", border: "none" },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "20px", padding: "0 10px 0 0" },
    ".cm-changed-line": { backgroundColor: "var(--color-changed-bg)" },
    ".cm-gutterElement.cm-changed-line": { color: "var(--color-changed)" },
    ".cm-matchingBracket": { backgroundColor: "var(--color-selected)", outline: "none" },
});

/** The text the document is compared with; lines that differ from it are marked as changed. */
const setBaseline = StateEffect.define<string | null>();

const baselineField = StateField.define<string | null>({
    create: () => null,
    update: (value, tr) => {
        for (const effect of tr.effects) if (effect.is(setBaseline)) return effect.value;
        return value;
    },
});

function changedSet(doc: Text, baseline: string | null): number[] {
    if (baseline === null) return [];
    return changedLines(baseline.split("\n"), doc.toString().split("\n"));
}

const changedField = StateField.define<number[]>({
    create: (state) => changedSet(state.doc, state.field(baselineField)),
    update: (value, tr) =>
        tr.docChanged || tr.effects.some((e) => e.is(setBaseline))
            ? changedSet(tr.state.doc, tr.state.field(baselineField))
            : value,
});

const changedLine = Decoration.line({ class: "cm-changed-line" });
const changedGutter = new (class extends GutterMarker {
    elementClass = "cm-changed-line";
})();

const changedDecorations = EditorView.decorations.compute([changedField], (state): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const n of state.field(changedField)) {
        const line = state.doc.line(n);
        builder.add(line.from, line.from, changedLine);
    }
    return builder.finish();
});

const changedGutterClass = gutterLineClass.compute([changedField], (state) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    for (const n of state.field(changedField)) {
        const line = state.doc.line(n);
        builder.add(line.from, line.from, changedGutter);
    }
    return builder.finish();
});

const language = new Compartment();
const editable = new Compartment();

export interface JsonEditorCallbacks {
    onChange: (text: string) => void;
    onSave: () => void;
}

/**
 * A code view for the inspector: JSON highlighting (when `highlightJson`), line numbers, and the
 * lines that differ from `baseline` marked. Read-only when `callbacks` is `null`.
 */
export function createJsonEditor(
    parent: HTMLElement,
    text: string,
    baseline: string | null,
    highlightJson: boolean,
    callbacks: (() => JsonEditorCallbacks) | null,
): EditorView {
    return new EditorView({
        parent,
        state: EditorState.create({
            doc: text,
            extensions: [
                lineNumbers(),
                history(),
                drawSelection(),
                bracketMatching(),
                language.of(highlightJson ? json : []),
                syntaxHighlighting(highlight),
                EditorView.lineWrapping,
                baselineField.init(() => baseline),
                changedField,
                changedDecorations,
                changedGutterClass,
                theme,
                editable.of(callbacks ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
                keymap.of([
                    {
                        key: "Mod-Enter",
                        preventDefault: true,
                        run: () => {
                            callbacks?.().onSave();
                            return true;
                        },
                    },
                    ...defaultKeymap,
                    ...historyKeymap,
                ]),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) callbacks?.().onChange(update.state.doc.toString());
                }),
            ],
        }),
    });
}

/** Brings the editor up to date with the host: its text, baseline and highlighting. */
export function updateJsonEditor(view: EditorView, text: string, baseline: string | null, highlightJson: boolean) {
    const current = view.state.doc.toString();
    view.dispatch({
        changes: current === text ? undefined : { from: 0, to: current.length, insert: text },
        effects: [
            ...(view.state.field(baselineField) === baseline ? [] : [setBaseline.of(baseline)]),
            language.reconfigure(highlightJson ? json : []),
        ],
    });
}
