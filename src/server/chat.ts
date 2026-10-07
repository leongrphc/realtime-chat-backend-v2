import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Resources } from './resources';
import { AppError, createConversationSchema, directKey, paginationSchema, readSchema, safeUser, sendSchema, uuid } from './core';
export const messageInclude = { sender: { select: safeUser }, attachments: { select: { id: true, name: true, mime: true, size: true } } } as const;
export async function requireMember(r: Resources, userId: string, conversationId: string) {
  uuid.parse(conversationId);
  const member = await r.db.membership.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
  if (!member) throw new AppError(403, 'FORBIDDEN');
  return member;
}
export async function createConversation(r: Resources, userId: string, input: unknown) {
  const data = createConversationSchema.parse(input);
  const ids = [...new Set([userId, ...data.userIds])];
  if (ids.length !== data.userIds.length + 1) throw new AppError(400, 'DUPLICATE_MEMBERS');
  if (await r.db.user.count({ where: { id: { in: ids } } }) !== ids.length) throw new AppError(400, 'UNKNOWN_USER');
  const members = { create: ids.map(id => ({ userId: id, role: id === userId ? 'owner' : 'member' })) };
  const key = data.kind === 'direct' ? directKey(...ids as [string, string]) : undefined;
  try {
    return await r.db.conversation.create({ data: { kind: data.kind, name: data.kind === 'group' ? data.name : null, directKey: key, members }, include: { members: { include: { user: { select: safeUser } } } } });
  } catch (err) {
    if (key && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return r.db.conversation.findUniqueOrThrow({ where: { directKey: key }, include: { members: { include: { user: { select: safeUser } } } } });
    }
    throw err;
  }
}
export async function listConversations(r: Resources, userId: string) {
  return r.db.conversation.findMany({ where: { members: { some: { userId } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 100,
    include: { members: { include: { user: { select: safeUser } } }, messages: { orderBy: { seq: 'desc' }, take: 1, include: messageInclude } } });
}
export async function sendMessage(r: Resources, userId: string, input: unknown) {
  const data = sendSchema.parse(input);
  await requireMember(r, userId, data.conversationId);
  const prior = await r.db.message.findUnique({ where: { senderId_clientId: { senderId: userId, clientId: data.clientId } }, include: messageInclude });
  const checkRetry = (message: NonNullable<typeof prior>) => {
    if (message.conversationId !== data.conversationId || message.body !== data.body ||
      [...message.attachments.map(a => a.id)].sort().join() !== [...data.attachmentIds].sort().join()) throw new AppError(409, 'IDEMPOTENCY_CONFLICT');
    return { message, created: false };
  };
  if (prior) return checkRetry(prior);
  try {
    const message = await r.db.$transaction(async tx => {
      const item = await tx.message.create({ data: { conversationId: data.conversationId, senderId: userId, clientId: data.clientId, body: data.body } });
      if (data.attachmentIds.length) {
        const updated = await tx.attachment.updateMany({ where: { id: { in: data.attachmentIds }, uploaderId: userId, conversationId: data.conversationId, messageId: null }, data: { messageId: item.id } });
        if (updated.count !== data.attachmentIds.length) throw new AppError(400, 'INVALID_ATTACHMENT');
      }
      await tx.conversation.update({ where: { id: data.conversationId }, data: { updatedAt: new Date() } });
      const members = await tx.membership.findMany({ where: { conversationId: data.conversationId, userId: { not: userId } } });
      await tx.notification.createMany({ data: members.map(m => ({ userId: m.userId, messageId: item.id })) });
      return tx.message.findUniqueOrThrow({ where: { id: item.id }, include: messageInclude });
    });
    return { message, created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await r.db.message.findUniqueOrThrow({ where: { senderId_clientId: { senderId: userId, clientId: data.clientId } }, include: messageInclude });
      return checkRetry(existing);
    }
    throw err;
  }
}
export async function listMessages(r: Resources, userId: string, conversationId: string, query: unknown) {
  await requireMember(r, userId, conversationId);
  const { cursor, limit } = paginationSchema.parse(query);
  const search = z.object({ q: z.string().trim().min(1).max(100).optional() }).parse(query).q;
  const before = cursor ? await r.db.message.findFirst({ where: { id: cursor, conversationId } }) : null;
  if (cursor && !before) throw new AppError(400, 'INVALID_CURSOR');
  const items = await r.db.message.findMany({ where: { conversationId, ...(before ? { seq: { lt: before.seq } } : {}), ...(search ? { body: { contains: search, mode: 'insensitive' } } : {}) },
    orderBy: { seq: 'desc' }, take: limit + 1, include: messageInclude });
  const hasMore = items.length > limit;
  const page = items.slice(0, limit);
  return { items: page, nextCursor: hasMore ? page.at(-1)!.id : null };
}
export async function markRead(r: Resources, userId: string, input: unknown) {
  const { conversationId, messageId } = readSchema.parse(input);
  await requireMember(r, userId, conversationId);
  const message = await r.db.message.findFirst({ where: { id: messageId, conversationId } });
  if (!message) throw new AppError(400, 'INVALID_MESSAGE');
  await r.db.$transaction(async tx => {
    await tx.membership.updateMany({ where: { conversationId, userId, lastReadSeq: { lt: message.seq } }, data: { lastReadSeq: message.seq } });
    await tx.notification.updateMany({ where: { userId, readAt: null, message: { conversationId, seq: { lte: message.seq } } }, data: { readAt: new Date() } });
  });
  const member = await r.db.membership.findUniqueOrThrow({ where: { conversationId_userId: { conversationId, userId } } });
  return { conversationId, userId, lastReadSeq: member.lastReadSeq.toString() };
}
export async function listNotifications(r: Resources, userId: string, input: unknown) {
  const { cursor, limit } = paginationSchema.parse(input);
  const before = cursor ? await r.db.notification.findFirst({ where: { id: cursor, userId } }) : null;
  if (cursor && !before) throw new AppError(400, 'INVALID_CURSOR');
  const items = await r.db.notification.findMany({ where: { userId, ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
    include: { message: { include: messageInclude } } });
  return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1].id : null,
    unread: await r.db.notification.count({ where: { userId, readAt: null } }) };
}
export const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
