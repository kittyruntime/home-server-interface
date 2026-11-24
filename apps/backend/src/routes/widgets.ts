import type { FastifyInstance } from 'fastify'
import { acceptPush, MAX_PUSH } from '../services/widget-sources'

// A script sends a dashboard widget its data: POST /api/widgets/push/<id> with
// "Authorization: Bearer <token>" and a JSON body (64 KB at most). The token is
// the one shown when the push source was created.
export async function widgetRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/api/widgets/push/:id', {
    bodyLimit: MAX_PUSH,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !token) return reply.code(401).send({ error: 'A source id and a bearer token are required' })
    if (req.body === undefined || req.body === null) return reply.code(400).send({ error: 'Send a JSON body' })
    if (!await acceptPush(req.params.id, token, req.body)) return reply.code(401).send({ error: 'Unknown source or wrong token' })
    return reply.code(204).send()
  })
}
