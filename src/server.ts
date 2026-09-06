import handler from "@tanstack/react-start/server-entry";
import app from "./index";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/")) {
			return app.fetch(request, env, ctx);
		}

		return handler.fetch(request);
	},
};