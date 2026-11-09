import { Store } from "@/lib/util/store";

/** A connection to open and select in the Explorer once it is listed (set by Search). */
export const revealConnection = new Store<string | null>(null);
