import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../../security/session.js";

/** preHandler для защищённых маршрутов: требует валидную сессионную куку. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!verifySessionToken(token)) {
    reply.code(401).send({ error: "Unauthorized" });
  }
}
