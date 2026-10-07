export type User = { id: string; name: string; email: string };
export type FileInfo = { id: string; name: string; mime: string; size: number };
export type Member = { userId: string; role: string; lastReadSeq: string; user: User };
export type Message = { id: string; seq: string; conversationId: string; senderId: string; clientId: string; body: string; createdAt: string; sender: User; attachments: FileInfo[] };
export type Conversation = { id: string; kind: 'direct' | 'group'; name: string | null; members: Member[]; messages?: Message[] };
export type Notice = { id: string; readAt: string | null; message: Message };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Send = { conversationId: string; clientId: string; body: string; attachmentIds: string[] };
