import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../src/database/sqlite.bun"

// Native busy_timeout is 0 here, so a held write lock fails the statement immediately and only the retry can recover.
const withLockedDatabase = async <A>(
  release: number | undefined,
  program: (sql: SqlClient) => Effect.Effect<A, unknown, never>,
) => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-busy-"))
  const filename = join(dir, "busy.db")
  const holder = new Database(filename)
  holder.run("create table item (id integer primary key, name text)")
  holder.run("begin immediate")
  if (release !== undefined) setTimeout(() => holder.run("commit"), release)

  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        return yield* program(yield* SqlClient)
      }).pipe(Effect.provide(layer({ filename, disableWAL: true })), Effect.scoped),
    )
  } finally {
    if (holder.inTransaction) holder.run("rollback")
    holder.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test("retries a write that hits a transient database lock", async () => {
  const rows = await withLockedDatabase(300, (sql) =>
    Effect.gen(function* () {
      yield* sql`insert into item (name) values ('written')`
      return yield* sql`select name from item`
    }),
  )

  expect(rows).toEqual([{ name: "written" }])
})

test("fails with the lock reason once the retry budget is spent", async () => {
  const error = await withLockedDatabase(undefined, (sql) =>
    sql`insert into item (name) values ('blocked')`.pipe(Effect.flip),
  )

  expect(error).toMatchObject({ reason: { _tag: "LockTimeoutError" } })
})
