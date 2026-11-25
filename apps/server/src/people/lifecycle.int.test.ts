import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { createUser, resetDatabase } from "../test/helpers";
import { changeEmail } from "./lifecycle";

describe("a person's lifecycle", () => {
  beforeEach(resetDatabase);

  it("ends admin rights from ADMIN_EMAILS with the address, whatever the caller read before", async () => {
    const root = await createUser({ email: "root@example.org" });
    // The directory read the person before a sign-in made them admin through ADMIN_EMAILS.
    const read = { id: root.id, adminSource: null };
    await getDb()
      .update(users)
      .set({ isAdmin: true, adminSource: "environment" })
      .where(eq(users.id, root.id));
    await changeEmail(getDb(), read, "former.root@example.org");
    const [after] = await getDb().select().from(users).where(eq(users.id, root.id));
    expect(after).toMatchObject({ email: "former.root@example.org", isAdmin: false, adminSource: null });

    // Admin rights an admin gave stay with the person.
    await getDb().update(users).set({ isAdmin: true, adminSource: "app" }).where(eq(users.id, root.id));
    await changeEmail(getDb(), read, "root.again@example.org");
    const [kept] = await getDb().select().from(users).where(eq(users.id, root.id));
    expect(kept).toMatchObject({ email: "root.again@example.org", isAdmin: true, adminSource: "app" });
  });
});
