import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { createPrisma } from "@jobi/db";
import { type AppContext, Task } from "../types";

export class TaskCreate extends OpenAPIRoute {
	schema = {
		tags: ["Tasks"],
		summary: "Create a new Task",
		request: {
			body: {
				content: {
					"application/json": {
						schema: Task,
					},
				},
			},
		},
		responses: {
			"201": {
				description: "Returns the created task",
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

		// Retrieve the validated request body
		const taskToCreate = data.body;

		const prisma = createPrisma(c.env.DB_BINDING);

		const task = await prisma.task.create({
			data: taskToCreate,
		});

		// return the new task
		return c.json(
			{
				success: true,
				task,
			},
			201,
		);
	}
}