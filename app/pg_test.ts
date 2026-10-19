import { expect, test } from "bun:test";
import { socketPg } from "./pg.ts";

const socket = process.env.TRAME_TEST_PG_SOCKET;

test.skipIf(!socket)("socket adapter preserves local query types and rolls back failed imports", async () => {
    const pg = socketPg(socket!);
    try {
      await pg.exec(
        `create temporary table adapter_test (id int primary key, data jsonb);
        insert into adapter_test values (1, '{"seed":true}');`,
      );
      const data = [{ text: "page block" }];
      await pg.query(`insert into adapter_test values ($1,$2)`, [
        2,
        JSON.stringify(data),
      ]);
      const result = await pg.query<
        { data: unknown; n: number; amount: string; at: Date; ids: string[] }
      >(
        `select data, count(*) over () as n, 1.25::numeric as amount,
          '2026-10-11T12:00:00Z'::timestamptz as at, $1::uuid[] as ids
         from adapter_test where id=2`,
        [["a89f8286-e5d9-4931-9f52-9043726d61ea"]],
      );
      expect(result.rows[0].data).toStrictEqual(data);
      expect(result.rows[0].n).toStrictEqual(1);
      expect(result.rows[0].amount).toStrictEqual("1.25");
      expect(result.rows[0].at).toBeInstanceOf(Date);
      expect(result.rows[0].at.toISOString()).toStrictEqual("2026-10-11T12:00:00.000Z");
      expect(result.rows[0].ids).toStrictEqual([
        "a89f8286-e5d9-4931-9f52-9043726d61ea",
      ]);
      await expect(pg.transaction(async (tx) => {
          await tx.query(`insert into adapter_test values (3, '{}')`);
          await tx.query(`insert into adapter_test values (1, '{}')`);
        })).rejects.toThrow();
      expect([...(await pg.query(`select id from adapter_test order by id`)).rows]).toStrictEqual([{ id: 1 }, { id: 2 }]);
      expect(await pg.transaction(async (tx) => {
          await tx.query(`insert into adapter_test values (3, '{}')`);
          return "committed";
        })).toStrictEqual("committed");
      expect([...(await pg.query(`select id from adapter_test where id=3`)).rows]).toStrictEqual([{ id: 3 }]);
    } finally {
      await pg.close();
    }
});
