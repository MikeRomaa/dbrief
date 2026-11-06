import { type ReactNode, useEffect, useRef } from "react";

import styles from "@/ui/Dialog.module.css";

interface DialogProps {
    title: string;
    onClose: () => void;
    onSubmit?: () => void;
    children: ReactNode;
    footer: ReactNode;
    width?: number;
}

/**
 * A modal dialog on the native `<dialog>` element, which traps focus, closes on Esc, and returns
 * focus to where it was.
 */
export function Dialog({ title, onClose, onSubmit, children, footer, width = 420 }: DialogProps) {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = ref.current;
        const previous = document.activeElement as HTMLElement | null;
        dialog?.showModal();

        return () => {
            dialog?.close();
            previous?.focus();
        };
    }, []);

    return (
        <dialog
            ref={ref}
            className={styles.dialog}
            style={{ width }}
            aria-labelledby="dialog-title"
            onCancel={(e) => {
                e.preventDefault();
                onClose();
            }}
        >
            <form
                className={styles.form}
                onSubmit={(e) => {
                    e.preventDefault();
                    onSubmit?.();
                }}
            >
                <h2 id="dialog-title" className={styles.title}>
                    {title}
                </h2>
                <div className={styles.body}>{children}</div>
                <div className={styles.footer}>{footer}</div>
            </form>
        </dialog>
    );
}
