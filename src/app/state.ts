import type { Conversation, Message } from './types';
export function mergeMessages(a: Message[], b: Message[]) {
  return [...new Map([...a, ...b].map(m => [m.id, m])).values()].sort((x, y) => BigInt(x.seq) < BigInt(y.seq) ? -1 : 1);
}
// An HTTP snapshot may have started before a newer socket receipt arrived.
export function mergeConversations(previous: Conversation[], incoming: Conversation[]) {
  const prior = new Map(previous.map(c => [c.id, c]));
  return incoming.map(c => ({ ...c, members: c.members.map(m => {
    const old = prior.get(c.id)?.members.find(member => member.userId === m.userId);
    return old && BigInt(old.lastReadSeq) > BigInt(m.lastReadSeq) ? { ...m, lastReadSeq: old.lastReadSeq } : m;
  }) }));
}
