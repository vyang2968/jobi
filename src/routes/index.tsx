import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const getTasks = createServerFn({
	method: "GET",
}).handler(async () => {
	return [
		{
			name: "Clean my room",
			slug: "clean-room",
			description: undefined,
			completed: false,
			due_date: "2025-01-05",
		},
		{
			name: "Build something awesome with Cloudflare Workers",
			slug: "cloudflare-workers",
			description: "Lorem Ipsum",
			completed: true,
			due_date: "2022-12-24",
		},
	];
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