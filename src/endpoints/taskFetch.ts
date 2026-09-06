import { NotFoundException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { createPrisma } from "@jobi/db";
import { type AppContext, Task } from "../types";

export class TaskFetch extends OpenAPIRoute {
	schema = {
		tags: ["Tasks"],
		summary: "Get a single Task by slug",
		request: {
			params: z.object({
				taskSlug: z.string().describe("Task slug"),
			}),
		},
		responses: {
			"200": {
				description: "Returns a single task if found",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							task: Task,
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		// Get validated data
		const data = await this.getValidatedData<typeof this.schema>();

		// Retrieve the validated slug
		const { taskSlug } = data.params;

		const prisma = createPrisma(c.env.DB_BINDING);

		const task = await prisma.task.findUnique({
			where: { slug: taskSlug },
		});

		if (!task) {
			throw new NotFoundException();
		}

		return {
			success: true,
			task,
		};
	}
}