import { describe, expect, it } from "vitest";

import { formatSql } from "@/lib/sql/format";

describe("formatSql", () => {
    it("formats DDL for the dialect", () => {
        const ddl = formatSql(
            'CREATE TABLE "shop"."orders" (\n    "id" integer DEFAULT nextval(\'shop.orders_id_seq\'::regclass) NOT NULL,\n    CONSTRAINT "orders_pkey" PRIMARY KEY (id)\n);\n\nCREATE INDEX orders_customer ON shop.orders USING btree (customer_id) WHERE (total > (0)::numeric);',
            "postgres",
        );
        expect(ddl).toContain("CREATE TABLE");
        expect(ddl).toContain("CREATE INDEX");
        expect(ddl.split("\n").length).toBeGreaterThan(4);
    });

    it("keeps function bodies", () => {
        const body =
            "CREATE OR REPLACE FUNCTION shop.touch()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NEW; END $function$;";
        expect(formatSql(body, "postgres")).toContain("$function$ BEGIN RETURN NEW; END $function$");
    });

    it("leaves SQL it can't parse as it was", () => {
        expect(formatSql("  CREATE TABLE ((( broken  ", "sqlite")).toBe("CREATE TABLE ((( broken");
    });
});
