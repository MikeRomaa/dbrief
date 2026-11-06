import { useStore } from "@/lib/store";
import { ResultBlock } from "@/scripts/ResultBlock";
import { bottomResult } from "@/scripts/results";

import styles from "@/shell/Panels.module.css";

/** The bottom panel's Results tab: the popped-out result, or the latest one when results aren't inline. */
export function BottomResults() {
    const shown = useStore(bottomResult);
    if (!shown) {
        return (
            <p className={styles.placeholder}>
                Results you pop out, or all results when they aren't shown inline, appear here.
            </p>
        );
    }

    return (
        <div className={styles.bottomResult}>
            <ResultBlock store={shown.store} id={shown.id} actions={{ ...shown.actions, popOut: undefined }} />
        </div>
    );
}
