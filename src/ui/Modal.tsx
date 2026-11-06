import { type ReactNode, useEffect, useRef } from "react";

import styles from "@/ui/Modal.module.css";

interface ModalProps {
    labelledBy: string;
    onClose: () => void;
    className?: string;
    children: ReactNode;
}

/**
 * The native `<dialog>` element shown modally: it traps focus, closes on Esc (calling `onClose`), and
 * returns focus to where it was.
 */
export function Modal({ labelledBy, onClose, className, children }: ModalProps) {
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
            className={`${styles.modal} ${className ?? ""}`}
            aria-labelledby={labelledBy}
            onCancel={(e) => {
                e.preventDefault();
                onClose();
            }}
        >
            {children}
        </dialog>
    );
}
