import { useState } from "react";

import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";

import styles from "@/scripts/ScriptTab.module.css";
import controls from "@/ui/controls.module.css";

type Values = Record<string, string | null>;

/** Asks for a statement's parameter values, prefilled with the ones used last time. */
export function ParamsDialog({
    keys,
    remembered,
    onRun,
    onClose,
}: {
    keys: string[];
    remembered: Values;
    onRun: (values: Values) => void;
    onClose: () => void;
}) {
    const [values, setValues] = useState<Values>(() =>
        Object.fromEntries(keys.map((k) => [k, remembered[k] === undefined ? "" : remembered[k]])),
    );

    return (
        <Dialog
            title="Query parameters"
            width={460}
            onClose={onClose}
            onSubmit={() => onRun(values)}
            footer={
                <>
                    <button type="button" className={controls.button} onClick={onClose}>
                        Cancel
                    </button>
                    <button type="submit" className={controls.primary}>
                        Run
                    </button>
                </>
            }
        >
            {keys.map((key, i) => {
                const value = values[key];
                return (
                    <div key={key} className={styles.param}>
                        <label className={styles.paramField}>
                            <span className={styles.paramName}>{/^\d+$/.test(key) ? `?${key}` : `:${key}`}</span>
                            <input
                                className={`${controls.input} ${styles.mono}`}
                                value={value ?? ""}
                                placeholder={value === null ? "NULL" : undefined}
                                disabled={value === null}
                                spellCheck={false}
                                autoComplete="off"
                                autoFocus={i === 0}
                                onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                            />
                        </label>
                        <Checkbox
                            checked={value === null}
                            onChange={(isNull) => setValues({ ...values, [key]: isNull ? null : "" })}
                        >
                            NULL
                        </Checkbox>
                    </div>
                );
            })}
            <p className={styles.note}>
                Values are sent as quoted literals; the database converts them to the column's type.
            </p>
        </Dialog>
    );
}
