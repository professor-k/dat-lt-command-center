import type { FastifyReply } from 'fastify';

export type DomainEvent =
  | { type: 'defect.created'; payload: Record<string, unknown> }
  | { type: 'defect.updated'; payload: Record<string, unknown> }
  | { type: 'aircraft.created'; payload: Record<string, unknown> }
  | { type: 'aircraft.updated'; payload: Record<string, unknown> }
  | { type: 'aircraft.deleted'; payload: Record<string, unknown> }
  | { type: 'station.created'; payload: Record<string, unknown> }
  | { type: 'station.updated'; payload: Record<string, unknown> }
  | { type: 'station.deleted'; payload: Record<string, unknown> }
  | { type: 'impediment.updated'; payload: Record<string, unknown> }
  | { type: 'alert.created'; payload: Record<string, unknown> }
  | { type: 'alert.updated'; payload: Record<string, unknown> }
  | { type: 'alert.deleted'; payload: Record<string, unknown> }
  | { type: 'history.updated'; payload: Record<string, unknown> };

const clients = new Set<FastifyReply>();

export function addClient(reply: FastifyReply) {
  clients.add(reply);
  reply.raw.on('close', () => clients.delete(reply));
}

export function broadcast(event: DomainEvent) {
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
  for (const reply of clients) {
    try {
      reply.raw.write(frame);
    } catch {
      clients.delete(reply);
    }
  }
}

export function heartbeat() {
  for (const reply of clients) {
    try {
      reply.raw.write(`: ping\n\n`);
    } catch {
      clients.delete(reply);
    }
  }
}

export const clientCount = () => clients.size;
