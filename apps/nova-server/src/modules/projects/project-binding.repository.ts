import { createScope, defineRepository } from "../../shared/scope.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { projectBindings, projects, type Database } from "../../../database/index.js";

export const projectBindingRepository = defineRepository(({ db, requireTransaction }) => {
  const owned = (id: string, owner: string) =>
    and(eq(projects.id, id), eq(projects.ownerUserId, owner), isNull(projects.deletedAt));
  return {
    async findProject(id: string, owner: string) {
      const [row] = await db.select({ id: projects.id }).from(projects).where(owned(id, owner));
      return row;
    },
    async lockProject(id: string, owner: string) {
      requireTransaction();
      const [row] = await db.select({ id: projects.id }).from(projects).where(owned(id, owner)).for("update");
      return row;
    },
    async current(id: string) {
      const [row] = await db
        .select()
        .from(projectBindings)
        .where(and(eq(projectBindings.projectId, id), eq(projectBindings.isCurrent, true)))
        .orderBy(desc(projectBindings.revision))
        .limit(1);
      return row;
    },
    async invalidate(id: string) {
      await db
        .update(projectBindings)
        .set({ isCurrent: false, invalidatedAt: new Date() })
        .where(and(eq(projectBindings.projectId, id), eq(projectBindings.isCurrent, true)));
    },
    async insert(input: typeof projectBindings.$inferInsert) {
      const [row] = await db.insert(projectBindings).values(input).returning();
      return row;
    },
    async touchProject(id: string) {
      await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    },
  };
});
export function createProjectBindingRepository(db: Database) {
  return createScope(db).get(projectBindingRepository);
}
export type ProjectBindingRepository = ReturnType<typeof createProjectBindingRepository>;
