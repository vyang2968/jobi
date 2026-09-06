import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { createPrisma } from "@jobi/db";
import { type AppContext, Task } from "../types";

export class TaskList extends OpenAPIRoute {
	schema = {
		tags: ["Tasks"],
		summary: "List Tasks",
		request: {
			query: z.object({
				page: z.number().default(0).describe("Page number"),
				isCompleted: z
					.boolean()
					.optional()
					.describe("Filter by completed flag"),
			}),
		},
		responses: {
			"200": {
				description: "Returns a list of tasks",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							tasks: Task.array(),
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		// Get validated data
		const data = await this.getValidatedData<typeof this.schema>();

		// Retrieve the validated parameters
		const { page, isCompleted } = data.query;

		const prisma = createPrisma(c.env.DB_BINDING);

		const tasks = await prisma.task.findMany({
			skip: page * 25,
			take: 25,
			where: isCompleted === undefined ? undefined : { completed: isCompleted },
		});

		return {
			success: true,
			tasks,
		};
	}
}