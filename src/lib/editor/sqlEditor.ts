import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { type SQLNamespace, sql } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
    Compartment,
    EditorState,
    type Extension,
    Facet,
    RangeSetBuilder,
    StateEffect,
    StateField,
} from "@codemirror/state";
import {
    Decoration,
    type DecorationSet,
    drawSelection,
    EditorView,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    tooltips,
    ViewPlugin,
    WidgetType,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { columnsInScope, completionOptionClass, keywordCompletion, sqlDialect } from "@/lib/editor/sqlCompletion";
import { TOOLTIP_GAP, VIEWPORT_MARGIN } from "@/lib/shell/tooltip";
import { type Dialect, type Statement, splitStatements, statementAt, statementsIn } from "@/lib/sql/statements";

/** What the host does for the editor's shortcuts and edits. */
export interface EditorCallbacks {
    onChange: (text: string) => void;
    onRun: () => void;
    onRunAll: () => void;
    onFormat: () => void;
    onCommit: () => void;
    onBlur: () => void;
    /** Renders result `id` into `container`; returns how to tear it down. */
    mountResult: (id: string, container: HTMLElement) => () => void;
}

const dialectFacet = Facet.define<Dialect, Dialect>({ combine: (values) => values[0] ?? "postgres" });

/** The statements in the document, recomputed on change (cheap for scripts of normal size). */
const statementsField = StateField.define<Statement[]>({
    create: (state) => splitStatements(state.doc.toString(), state.facet(dialectFacet)),
    update: (value, tr) =>
        tr.docChanged || tr.startState.facet(dialectFacet) !== tr.state.facet(dialectFacet)
            ? splitStatements(tr.state.doc.toString(), tr.state.facet(dialectFacet))
            : value,
});

/** Marks the lines of the statement Run would run, when there is more than one statement. */
const currentStatementField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (_, tr) => {
        const statements = tr.state.field(statementsField);
        if (statements.length < 2) return Decoration.none;

        const current = statementAt(statements, tr.state.selection.main.head);
        if (!current) return Decoration.none;

        const builder = new RangeSetBuilder<Decoration>();
        const first = tr.state.doc.lineAt(current.from).number;
        const last = tr.state.doc.lineAt(current.to).number;
        for (let n = first; n <= last; n++) {
            builder.add(
                tr.state.doc.line(n).from,
                tr.state.doc.line(n).from,
                Decoration.line({ class: "cm-current-statement" }),
            );
        }
        return builder.finish();
    },
    provide: (field) => EditorView.decorations.from(field),
});

class ResultWidget extends WidgetType {
    private teardown: (() => void) | null = null;

    constructor(
        readonly id: string,
        private readonly mount: EditorCallbacks["mountResult"],
    ) {
        super();
    }

    eq(other: ResultWidget) {
        return other.id === this.id;
    }

    toDOM() {
        const container = document.createElement("div");
        container.className = "cm-result";
        this.teardown = this.mount(this.id, container);
        return container;
    }

    destroy() {
        this.teardown?.();
        this.teardown = null;
    }

    ignoreEvent() {
        // The result handles its own clicks, scrolling and selection.
        return true;
    }
}

/**
 * Pins result blocks to the visible width of the editor (minus the gutter) and keeps them in view
 * when the code scrolls sideways, so a wide result scrolls inside its own grid instead of widening
 * the whole editor.
 */
const resultWidth = ViewPlugin.define((view) => {
    const measure = () =>
        view.requestMeasure({
            read: () => ({
                width: view.scrollDOM.clientWidth,
                gutter: (view.dom.querySelector(".cm-gutters") as HTMLElement | null)?.offsetWidth ?? 0,
            }),
            write: ({ width, gutter }) => {
                view.dom.style.setProperty("--cm-result-width", `${Math.max(0, width - gutter)}px`);
                view.dom.style.setProperty("--cm-result-left", `${gutter}px`);
            },
        });
    measure();
    return {
        update: (update) => {
            if (update.geometryChanged) measure();
        },
    };
});

const addResult = StateEffect.define<{ id: string; pos: number; mount: EditorCallbacks["mountResult"] }>({
    map: (value, mapping) => ({ ...value, pos: mapping.mapPos(value.pos) }),
});
const removeResult = StateEffect.define<string>();

/** Result blocks under statements; they move with the text as it is edited. */
const resultsField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (value, tr) => {
        let results = value.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(removeResult)) {
                results = results.update({
                    filter: (_from, _to, deco) => (deco.spec.widget as ResultWidget).id !== effect.value,
                });
            } else if (effect.is(addResult)) {
                const { id, pos, mount } = effect.value;
                const widget = Decoration.widget({ widget: new ResultWidget(id, mount), block: true, side: 1 });
                results = results.update({ add: [widget.range(pos)] });
            }
        }
        return results;
    },
    provide: (field) => EditorView.decorations.from(field),
});

const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syntax-keyword)", fontWeight: "600" },
    { tag: [t.string, t.special(t.string)], color: "var(--syntax-string)" },
    { tag: [t.number, t.bool, t.null], color: "var(--syntax-number)" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syntax-comment)", fontStyle: "italic" },
    { tag: [t.typeName, t.standard(t.name)], color: "var(--syntax-keyword)" },
]);

const theme = EditorView.theme({
    "&": {
        height: "100%",
        backgroundColor: "var(--color-bg)",
        color: "var(--color-text)",
        fontSize: "var(--font-size-md)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--color-text)", padding: "8px 0" },
    ".cm-cursor": { borderLeftColor: "var(--color-text)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--color-changed-bg) !important",
    },
    ".cm-gutters": {
        backgroundColor: "var(--color-bg)",
        color: "var(--color-text-faint)",
        border: "none",
        paddingLeft: "8px",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-text)" },
    ".cm-current-statement": { boxShadow: "inset 2px 0 var(--color-border-strong)" },
    ".cm-matchingBracket": { backgroundColor: "var(--color-selected)", outline: "none" },
    ".cm-selectionMatch": { backgroundColor: "var(--color-selected)" },
    ".cm-tooltip": {
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-raised)",
        color: "var(--color-text)",
        boxShadow: "0 1px 2px rgb(0 0 0 / 0.08), 0 10px 28px rgb(0 0 0 / 0.2)",
        animation: "cm-popup-in 100ms ease-out",
    },
    "@keyframes cm-popup-in": { from: { opacity: "0" } },
    // The gap between the cursor's line and the popup; `popupLayer` leaves room for it.
    ".cm-tooltip-autocomplete.cm-tooltip-below": { marginTop: `${TOOLTIP_GAP}px` },
    ".cm-tooltip-autocomplete.cm-tooltip-above": { marginTop: `-${TOOLTIP_GAP}px` },
    // Completions read like the code they insert: a compact list of names in the editor's font, the
    // kind or signature muted beside each, keywords, types and built-in functions highlighted.
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        minWidth: "220px",
        maxWidth: "min(560px, 90vw)",
        maxHeight: "296px",
        padding: "4px",
        boxSizing: "border-box",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--font-size-md)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        padding: "0 8px",
        lineHeight: "24px",
    },
    ".cm-tooltip-autocomplete > ul > li:hover": { backgroundColor: "var(--color-hover)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--color-changed-bg)",
        color: "var(--color-text)",
    },
    ".cm-completionLabel": { fontWeight: "600" },
    ".cm-completionMatchedText": { textDecoration: "none" },
    ".cm-completion-keyword .cm-completionLabel, .cm-completion-type .cm-completionLabel, .cm-completion-builtin .cm-completionLabel":
        { color: "var(--syntax-keyword)" },
    ".cm-completionDetail": {
        marginLeft: "1ch",
        fontStyle: "normal",
        color: "var(--color-text-muted)",
    },
    ".cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after": {
        color: "var(--color-text-faint)",
        lineHeight: "16px",
    },
    ".cm-result": {
        position: "sticky",
        left: "var(--cm-result-left, 0)",
        boxSizing: "border-box",
        width: "var(--cm-result-width, 100%)",
        padding: "4px 16px 10px 0",
        fontFamily: "var(--font-ui)",
        lineHeight: "1.35",
        cursor: "auto",
    },
    ".cm-panels": { backgroundColor: "var(--color-surface)", color: "var(--color-text)" },
});

const language = new Compartment();
const completion = new Compartment();

function completions(): Extension {
    return autocompletion({ icons: false, optionClass: completionOptionClass });
}

/**
 * Popups (autocomplete) live on the body, so no panel clips them, and use the same bounds as the
 * app's tooltips: below the cursor when that fits, otherwise above when there's more room there,
 * shrinking to the space left and sliding sideways to stay inside the window.
 */
function popupLayer(): Extension {
    return tooltips({
        position: "fixed",
        parent: document.body,
        tooltipSpace: (view) => {
            const { clientWidth, clientHeight } = view.dom.ownerDocument.documentElement;
            const vertical = VIEWPORT_MARGIN + TOOLTIP_GAP;
            return {
                top: vertical,
                left: VIEWPORT_MARGIN,
                right: clientWidth - VIEWPORT_MARGIN,
                bottom: clientHeight - vertical,
            };
        },
    });
}

/** What autocomplete offers from the schema cache: schema → object → columns (see `completionNamespace`). */
export interface CompletionSchema {
    namespace: SQLNamespace;
    defaultSchema?: string;
}

interface LanguageConfig {
    dialect: Dialect;
    schema?: CompletionSchema;
}

const configs = new WeakMap<EditorView, LanguageConfig>();

function languageFor({ dialect, schema }: LanguageConfig): Extension {
    return [
        dialectFacet.of(dialect),
        sql({
            dialect: sqlDialect(dialect),
            schema: schema?.namespace,
            defaultSchema: schema?.defaultSchema,
            upperCaseKeywords: true,
            keywordCompletion: keywordCompletion(dialect),
        }),
        schema
            ? sqlDialect(dialect).language.data.of({
                  autocomplete: columnsInScope(schema.namespace, schema.defaultSchema, dialect),
              })
            : [],
    ];
}

function reconfigure(view: EditorView, change: Partial<LanguageConfig>) {
    const config = { ...(configs.get(view) ?? { dialect: "postgres" as Dialect }), ...change };
    configs.set(view, config);
    view.dispatch({ effects: language.reconfigure(languageFor(config)) });
}

/** A SQL editor in `parent`. Callbacks are read through the getter, so the host can update them. */
export function createSqlEditor(
    parent: HTMLElement,
    text: string,
    dialect: Dialect,
    autocomplete: boolean,
    callbacks: () => EditorCallbacks,
): EditorView {
    const shortcuts = keymap.of([
        {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
                callbacks().onRun();
                return true;
            },
        },
        {
            key: "Shift-Mod-Enter",
            preventDefault: true,
            run: () => {
                callbacks().onRunAll();
                return true;
            },
        },
        {
            key: "Shift-Mod-f",
            preventDefault: true,
            run: () => {
                callbacks().onFormat();
                return true;
            },
        },
        {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
                callbacks().onCommit();
                return true;
            },
        },
    ]);

    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc: text,
            extensions: [
                shortcuts,
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightSpecialChars(),
                history(),
                drawSelection(),
                indentOnInput(),
                bracketMatching(),
                closeBrackets(),
                highlightSelectionMatches(),
                language.of(languageFor({ dialect })),
                completion.of(autocomplete ? completions() : []),
                popupLayer(),
                syntaxHighlighting(highlight),
                statementsField,
                currentStatementField,
                resultsField,
                resultWidth,
                theme,
                keymap.of([
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...searchKeymap,
                    ...historyKeymap,
                    ...completionKeymap,
                    indentWithTab,
                ]),
                EditorView.domEventHandlers({ blur: () => callbacks().onBlur() }),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) callbacks().onChange(update.state.doc.toString());
                }),
            ],
        }),
    });
    configs.set(view, { dialect });
    return view;
}

export function setDialect(view: EditorView, dialect: Dialect) {
    reconfigure(view, { dialect });
}

/** Sets the schemas, tables and columns autocomplete suggests (`undefined` for none). */
export function setCompletionSchema(view: EditorView, schema: CompletionSchema | undefined) {
    reconfigure(view, { schema });
}

export function setAutocomplete(view: EditorView, on: boolean) {
    view.dispatch({ effects: completion.reconfigure(on ? completions() : []) });
}

/** The statements Run should run: those the selection touches, or the one at the cursor. */
export function statementsToRun(view: EditorView): Statement[] {
    const statements = view.state.field(statementsField);
    const { from, to, head } = view.state.selection.main;
    if (from !== to) return statementsIn(statements, from, to);

    const current = statementAt(statements, head);
    return current ? [current] : [];
}

export function allStatements(view: EditorView): Statement[] {
    return view.state.field(statementsField);
}

/** Shows result `id` under the line where the statement ending at `end` ends. */
export function showResult(view: EditorView, id: string, end: number, mount: EditorCallbacks["mountResult"]) {
    const pos = view.state.doc.lineAt(Math.min(end, view.state.doc.length)).to;
    view.dispatch({ effects: addResult.of({ id, pos, mount }) });
}

export function hideResult(view: EditorView, id: string) {
    view.dispatch({ effects: removeResult.of(id) });
}

/** The ids of results shown between `from` and `to` (to replace a statement's old result). */
export function resultsBetween(view: EditorView, from: number, to: number): string[] {
    const ids: string[] = [];
    const end = view.state.doc.lineAt(Math.min(to, view.state.doc.length)).to;
    view.state.field(resultsField).between(from, end, (_f, _t, deco) => {
        ids.push((deco.spec.widget as ResultWidget).id);
    });
    return ids;
}

/** Replaces the whole document, or the selection, with `text` (Format, external reloads). */
export function replaceText(view: EditorView, text: string, selectionOnly = false) {
    const { from, to } = view.state.selection.main;
    const range = selectionOnly && from !== to ? { from, to } : { from: 0, to: view.state.doc.length };
    view.dispatch({ changes: { ...range, insert: text } });
}

/** A read-only SQL view (the table tab's DDL), with the editor's highlighting and line numbers. */
export function createSqlViewer(parent: HTMLElement, text: string, dialect: Dialect): EditorView {
    return new EditorView({
        parent,
        state: EditorState.create({
            doc: text,
            extensions: [
                lineNumbers(),
                highlightSpecialChars(),
                drawSelection(),
                languageFor({ dialect }),
                syntaxHighlighting(highlight),
                theme,
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
                keymap.of(defaultKeymap),
            ],
        }),
    });
}
