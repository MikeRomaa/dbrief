import type { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { createJsonEditor, updateJsonEditor } from "@/lib/editor/jsonEditor";

import styles from "@/components/shell/InspectorPanel.module.css";

/**
 * The inspector's code view of a value: JSON highlighting, line numbers, and the lines that differ
 * from `baseline` (the value before any staged change) marked. Read-only without `onChange`.
 */
export function JsonCode({
    text,
    baseline,
    highlight = true,
    label,
    invalid = false,
    onChange,
    onSave,
}: {
    text: string;
    baseline: string | null;
    highlight?: boolean;
    label: string;
    invalid?: boolean;
    onChange?: (text: string) => void;
    onSave?: () => void;
}) {
    const parent = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const callbacks = useRef({ onChange, onSave });
    callbacks.current = { onChange, onSave };
    const editable = !!onChange;

    // biome-ignore lint/correctness/useExhaustiveDependencies: created once per mount; updates go through the effect below
    useEffect(() => {
        if (!parent.current) return;
        const editor = createJsonEditor(
            parent.current,
            text,
            baseline,
            highlight,
            editable
                ? () => ({
                      onChange: (t) => callbacks.current.onChange?.(t),
                      onSave: () => callbacks.current.onSave?.(),
                  })
                : null,
        );
        editor.contentDOM.setAttribute("aria-label", label);
        view.current = editor;
        return () => {
            editor.destroy();
            view.current = null;
        };
    }, [editable]);

    useEffect(() => {
        if (view.current) updateJsonEditor(view.current, text, baseline, highlight);
    }, [text, baseline, highlight]);

    useEffect(() => {
        view.current?.contentDOM.setAttribute("aria-label", label);
    }, [label]);

    return (
        <div ref={parent} className={editable ? styles.code : styles.codeView} aria-invalid={invalid || undefined} />
    );
}
