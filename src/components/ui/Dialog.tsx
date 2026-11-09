import { type ReactNode, useId } from "react";

import { Modal } from "@/components/ui/Modal";

import styles from "@/components/ui/Dialog.module.css";

interface DialogProps {
    title: string;
    onClose: () => void;
    onSubmit?: () => void;
    children: ReactNode;
    footer: ReactNode;
    width?: number;
}

/** A small modal dialog: title, body and footer buttons, as a form so Enter submits. */
export function Dialog({ title, onClose, onSubmit, children, footer, width = 420 }: DialogProps) {
    const titleId = useId();

    return (
        <Modal labelledBy={titleId} onClose={onClose}>
            <form
                className={styles.form}
                style={{ width }}
                onSubmit={(e) => {
                    e.preventDefault();
                    onSubmit?.();
                }}
            >
                <h2 id={titleId} className={styles.title}>
                    {title}
                </h2>
                <div className={styles.body}>{children}</div>
                <div className={styles.footer}>{footer}</div>
            </form>
        </Modal>
    );
}
