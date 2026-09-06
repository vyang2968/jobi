import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "./generated/prisma/client";

export function createPrisma(db: D1Database) {
	return new PrismaClient({ adapter: new PrismaD1(db) });
}