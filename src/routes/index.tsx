import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

type Task = {
	slug: string;
	name: string;
	description: string | null;
	completed: boolean;
	due_date: string | null;
};

const getTasks = createServerFn({
	method: "GET",
}).handler(async () => {
	const origin = new URL(getRequest().url).origin;
	const res = await fetch(`${origin}/api/tasks`);

	if (!res.ok) {
		throw new Error("Failed to fetch tasks");
	}

	const data = (await res.json()) as { success: boolean; tasks: Task[] };

	return data.tasks;
});

export const Route = createFileRoute("/")({
	loader: async () => await getTasks(),
	component: Home,
});

function Home() {
	const tasks = Route.useLoaderData();

	return (
		<div>
			<h1>Jobi</h1>
			<ul>
				{tasks.map((task) => (
					<li key={task.slug}>
						{task.name} {task.completed ? "✓" : ""}
					</li>
				))}
			</ul>
		</div>
	);
}