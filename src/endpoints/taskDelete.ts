import { NotFoundException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { createPrisma } from "@jobi/db";
import { type AppContext, Task } from "../types";

export class TaskDelete extends OpenAPIRoute {
	schema = {
		tags: ["Tasks"],
		summary: "Delete a Task",
		request: {
			params: z.object({
				taskSlug: z.string().describe("Task slug"),
			}),
		},
		responses: {
			"200": {
				description: "Returns if the task was deleted successfully",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.object({
								task: Task,
							}),
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

		await prisma.task.delete({
			where: { slug: taskSlug },
		});

		// Return the deleted task for confirmation
		return {
			result: {
				task,
			},
			success: true,
		};
	}
}