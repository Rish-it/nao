import 'dotenv/config';

import { fastifyTRPCPlugin, FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import { auth } from './auth';
import { TrpcRouter, trpcRouter } from './router';
import { chatPlugin } from './routes/chat';

const app = fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
export type App = typeof app;

// Set the validator and serializer compilers for the Zod type provider
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// Register tRPC plugin
app.register(fastifyTRPCPlugin, {
	prefix: '/api/trpc',
	trpcOptions: {
		router: trpcRouter,
		// createContext,
		onError({ path, error }) {
			console.error(`Error in tRPC handler on path '${path}':`, error);
		},
	} satisfies FastifyTRPCPluginOptions<TrpcRouter>['trpcOptions'],
});

app.register(chatPlugin, {
	prefix: '/api',
});

/**
 * Tests the API connection
 */
app.get('/api', async () => {
	return 'Welcome to the API!';
});

app.route({
	method: ['GET', 'POST'],
	url: '/api/auth/*',
	async handler(request, reply) {
		try {
			// Construct request URL
			const url = new URL(request.url, `http://${request.headers.host}`);

			// Convert Fastify headers to standard Headers object
			const headers = new Headers();
			Object.entries(request.headers).forEach(([key, value]) => {
				if (value) headers.append(key, value.toString());
			});
			// Create Fetch API-compatible request
			const req = new Request(url.toString(), {
				method: request.method,
				headers,
				body: request.body ? JSON.stringify(request.body) : undefined,
			});
			// Process authentication request
			const response = await auth.handler(req);
			// Forward response to client
			reply.status(response.status);
			response.headers.forEach((value, key) => reply.header(key, value));
			reply.send(response.body ? await response.text() : null);
		} catch (error) {
			app.log.error(error, 'Authentication Error');
			reply.status(500).send({
				error: 'Internal authentication error',
				code: 'AUTH_FAILURE',
			});
		}
	},
});

export default app;
