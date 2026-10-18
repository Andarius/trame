import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { socketPg } from "./pg.ts";

const socket = Deno.env.get("TRAME_TEST_PG_SOCKET");

Deno.test({
  name:
    "socket adapter preserves local query types and rolls back failed imports",
  ignore: !socket,
  async fn() {
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
      assertEquals(result.rows[0].data, data);
      assertEquals(result.rows[0].n, 1);
      assertEquals(result.rows[0].amount, "1.25");
      assertInstanceOf(result.rows[0].at, Date);
      assertEquals(result.rows[0].at.toISOString(), "2026-10-11T12:00:00.000Z");
      assertEquals(result.rows[0].ids, [
        "a89f8286-e5d9-4931-9f52-9043726d61ea",
      ]);
      await assertRejects(() =>
        pg.transaction(async (tx) => {
          await tx.query(`insert into adapter_test values (3, '{}')`);
          await tx.query(`insert into adapter_test values (1, '{}')`);
        })
      );
      assertEquals(
        [...(await pg.query(`select id from adapter_test order by id`)).rows],
        [{ id: 1 }, { id: 2 }],
      );
      assertEquals(
        await pg.transaction(async (tx) => {
          await tx.query(`insert into adapter_test values (3, '{}')`);
          return "committed";
        }),
        "committed",
      );
      assertEquals(
        [...(await pg.query(`select id from adapter_test where id=3`)).rows],
        [{ id: 3 }],
      );
    } finally {
      await pg.close();
    }
  },
});
