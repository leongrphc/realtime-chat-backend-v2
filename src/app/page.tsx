'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API, api, post } from './api';
import { mergeConversations, mergeMessages } from './state';
import type { Conversation, FileInfo, Message, Notice, Page, Send, User } from './types';
const errorText = (e: unknown) => e instanceof Error ? e.message : 'REQUEST_FAILED';
const title = (c: Conversation, userId: string) => c.kind === 'group' ? c.name : c.members.find(m => m.userId !== userId)?.user.name ?? 'Direct chat';
const demo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
const uploadsEnabled = process.env.NEXT_PUBLIC_UPLOADS_ENABLED !== 'false';
export default function Chat() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState(demo ? 'ada@demo.local' : '');
  const [password, setPassword] = useState(demo ? 'DemoPassword123!' : '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [pending, setPending] = useState<Send | null>(null);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [users, setUsers] = useState<User[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [group, setGroup] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [noticeCursor, setNoticeCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [desktop, setDesktop] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const selectedRef = useRef<string | null>(null);
  const searchRef = useRef('');
  const desktopRef = useRef(false);
  const typingSent = useRef(0);
  const requestVersion = useRef(0);
  const readId = useRef('');
  useEffect(() => { selectedRef.current = selected; searchRef.current = search; desktopRef.current = desktop; }, [selected, search, desktop]);
  const reloadConversations = useCallback(async () => {
    const incoming = await api<Conversation[]>('/conversations');
    setConversations(previous => mergeConversations(previous, incoming));
  }, []);
  const reloadNotices = useCallback(async () => {
    const page = await api<Page<Notice> & { unread: number }>('/notifications');
    setNotices(page.items); setNoticeCursor(page.nextCursor); setUnread(page.unread);
  }, []);
  const reloadPresence = useCallback(async () => {
    const state = await api<{ userId: string; online: boolean }[]>('/presence');
    setOnline(Object.fromEntries(state.map(s => [s.userId, s.online])));
  }, []);
  const reloadMessages = useCallback(async (conversationId: string, q: string, replace = false) => {
    const version = requestVersion.current;
    const page = await api<Page<Message>>(`/conversations/${conversationId}/messages?${new URLSearchParams(q ? { q } : {})}`);
    if (version !== requestVersion.current || selectedRef.current !== conversationId || searchRef.current !== q) return;
    setMessages(old => mergeMessages(old, page.items));
    if (replace) setCursor(page.nextCursor);
  }, []);
  useEffect(() => {
    void api<User>('/auth/me').then(setUser).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    const report = (e: unknown) => setError(errorText(e));
    const reload = () => { void Promise.all([reloadConversations(), reloadNotices(), reloadPresence()]).catch(report);
      if (selectedRef.current) void reloadMessages(selectedRef.current, searchRef.current).catch(report);
    };
    const socket = io(API, { transports: ['websocket'], withCredentials: true });
    socketRef.current = socket;
    socket.on('connect', () => { setConnected(true); reload(); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('conversation:update', reload);
    socket.on('message:new', (message: Message) => {
      if (selectedRef.current === message.conversationId && !searchRef.current) setMessages(old => mergeMessages(old, [message]));
      void reloadConversations().catch(report);
    });
    socket.on('notification:new', () => {
      void reloadNotices().catch(report);
      if (desktopRef.current && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification('New chat message', { body: 'Open Plain Chat to read it.' });
    });
    socket.on('presence:update', (state: { userId: string; online: boolean }) => setOnline(old => ({ ...old, [state.userId]: state.online })));
    socket.on('typing:update', (state: { conversationId: string; userId: string; typing: boolean }) => {
      if (state.conversationId === selectedRef.current) setTyping(old => ({ ...old, [state.userId]: state.typing ? Date.now() + 4000 : 0 }));
    });
    socket.on('receipt:update', (receipt: { conversationId: string; userId: string; lastReadSeq: string }) => {
      setConversations(old => old.map(c => c.id === receipt.conversationId ? { ...c, members: c.members.map(m => m.userId === receipt.userId && BigInt(receipt.lastReadSeq) > BigInt(m.lastReadSeq) ? { ...m, lastReadSeq: receipt.lastReadSeq } : m) } : c));
      void reloadNotices().catch(report);
    });
    reload();
    // Durable polling also repairs missed Pub/Sub events and presence after a process crash.
    const poll = setInterval(reload, 15000);
    const expireTyping = setInterval(() => setTyping(old => Object.fromEntries(Object.entries(old).filter(([, until]) => until > Date.now()))), 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') { readId.current = ''; reload(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(poll); clearInterval(expireTyping); document.removeEventListener('visibilitychange', onVisible); socket.disconnect(); socketRef.current = null; };
  }, [user, reloadConversations, reloadMessages, reloadNotices, reloadPresence]);
  useEffect(() => {
    if (!selected) return;
    const version = requestVersion.current;
    void api<Page<Message>>(`/conversations/${selected}/messages?${new URLSearchParams(search ? { q: search } : {})}`).then(page => {
      if (version !== requestVersion.current) return;
      setMessages(old => mergeMessages(old, page.items)); setCursor(page.nextCursor);
    }).catch(e => { if (version === requestVersion.current) setError(errorText(e)); });
  }, [selected, search]);
  useEffect(() => {
    const latest = messages.at(-1);
    if (!selected || search || !latest || latest.conversationId !== selected || readId.current === latest.id || document.visibilityState !== 'visible') return;
    readId.current = latest.id;
    void post('/read', { conversationId: selected, messageId: latest.id }).then(reloadNotices).catch(e => { readId.current = ''; setError(errorText(e)); });
  }, [messages, selected, search, reloadNotices]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const timer = setTimeout(() => { void api<User[]>(`/users?q=${encodeURIComponent(userQuery)}`).then(data => { if (active) setUsers(data); }).catch(e => { if (active) setError(errorText(e)); }); }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [user, userQuery]);
  function selectConversation(id: string) {
    if (pending || files.length || draft.trim()) { setError('Send or clear your draft and files before changing chats.'); return; }
    requestVersion.current += 1; selectedRef.current = id; searchRef.current = ''; readId.current = '';
    setSelected(id); setMessages([]); setCursor(null); setSearch(''); setSearchDraft(''); setTyping({}); setError('');
  }
  async function authenticate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { setUser(await post<User>(`/auth/${register ? 'register' : 'login'}`, { email, password, ...(register ? { name } : {}) })); setPassword(''); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function createChat(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const c = await post<Conversation>('/conversations', { kind: group ? 'group' : 'direct', userIds: memberIds, ...(group ? { name: groupName } : {}) });
      await reloadConversations(); selectConversation(c.id); setMemberIds([]); setGroupName('');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); if (!selected || sending) return;
    const payload = pending ?? { conversationId: selected, clientId: crypto.randomUUID(), body: draft.trim(), attachmentIds: files.map(f => f.id) };
    if (!payload.body && !payload.attachmentIds.length) return;
    setPending(payload); setSending(true); setError('');
    try {
      let message: Message;
      const socket = socketRef.current;
      if (socket?.connected) message = await new Promise<Message>((resolve, reject) => {
        socket.timeout(7000).emit('message:send', payload, (err: Error | null, response: { ok: boolean; data: Message; error?: string }) => {
          if (err) reject(new Error('Send timed out. Retry uses the same message ID.'));
          else if (!response?.ok) reject(new Error(response?.error ?? 'SEND_FAILED'));
          else resolve(response.data);
        });
      });
      else message = await post<Message>('/messages', payload);
      setMessages(old => mergeMessages(old, [message])); setDraft(''); setFiles([]); setPending(null);
      socket?.emit('typing:set', { conversationId: selected, typing: false });
      await reloadConversations();
    } catch (e) { setError(errorText(e)); } finally { setSending(false); }
  }
  async function upload(file: File) {
    if (!selected) return;
    if (file.size > 10 * 1024 * 1024) { setError('The file limit is 10 MiB.'); return; }
    if (files.length >= 5) { setError('Attach at most 5 files.'); return; }
    setBusy(true); setError('');
    const form = new FormData(); form.append('file', file);
    try { const info = await api<FileInfo>(`/conversations/${selected}/files`, { method: 'POST', body: form }); setFiles(old => [...old, info]); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function olderMessages() {
    if (!selected || !cursor) return;
    const version = requestVersion.current;
    setBusy(true);
    try {
      const page = await api<Page<Message>>(`/conversations/${selected}/messages?${new URLSearchParams({ cursor, ...(search ? { q: search } : {}) })}`);
      if (version === requestVersion.current) { setMessages(old => mergeMessages(old, page.items)); setCursor(page.nextCursor); }
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const current = conversations.find(c => c.id === selected);
  if (loading) return <main><p>Loading session…</p></main>;
  if (!user) return <main className="login"><h1>Plain Chat</h1>
    <form onSubmit={authenticate}><h2>{register ? 'Create account' : 'Sign in'}</h2>
      {register && <label>Name<input value={name} onChange={e => setName(e.target.value)} required maxLength={60} autoComplete="name" /></label>}
      <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" /></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={10} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} /></label>
      <button disabled={busy}>{busy ? 'Please wait…' : register ? 'Register' : 'Sign in'}</button>
      <button type="button" onClick={() => { setRegister(v => !v); setError(''); }}>{register ? 'Use an existing account' : 'Create account'}</button>
    </form>{demo && <p className="muted">Demo accounts: ada@demo.local, bora@demo.local, cem@demo.local<br />Password: DemoPassword123!</p>}{error && <p role="alert">{error}</p>}</main>;
  return <main><header><div><h1>Plain Chat</h1><p>{user.name} · {connected ? 'Realtime connected' : 'Realtime disconnected · HTTP available'}</p></div>
    <button onClick={() => { void post('/auth/logout', {}).then(() => { setUser(null); setSelected(null); setMessages([]); setConversations([]); setDraft(''); setFiles([]); setPending(null); }).catch(e => setError(errorText(e))); }}>Sign out</button></header>
    {error && <p role="alert" className="error">{error} <button onClick={() => setError('')}>Dismiss</button></p>}
    <div className="workspace"><aside><section><h2>Conversations</h2>{!conversations.length && <p>No chats yet.</p>}
      <ul className="chat-list">{conversations.map(c => <li key={c.id}><button aria-current={c.id === selected ? 'page' : undefined} onClick={() => selectConversation(c.id)}>{title(c, user.id)} <small>{c.kind}</small></button></li>)}</ul></section>
      <section><h2>New conversation</h2><form onSubmit={createChat}>
        <label><input type="checkbox" checked={group} onChange={e => { setGroup(e.target.checked); setMemberIds([]); }} /> Group chat</label>
        {group && <label>Group name<input value={groupName} onChange={e => setGroupName(e.target.value)} maxLength={80} required /></label>}
        <label>Find people<input value={userQuery} onChange={e => setUserQuery(e.target.value)} placeholder="Name or email" maxLength={100} /></label>
        <div className="people">{users.map(u => <label key={u.id}><input type={group ? 'checkbox' : 'radio'} name="person" checked={memberIds.includes(u.id)} onChange={e => setMemberIds(old => group ? e.target.checked ? [...old, u.id] : old.filter(id => id !== u.id) : [u.id])} />{u.name} <small>{u.email}</small></label>)}</div>
        <button disabled={busy || !memberIds.length || memberIds.length > 19}>Create chat</button></form></section>
      <section><h2>Notifications ({unread} unread)</h2><button onClick={() => { if ('Notification' in window) void Notification.requestPermission().then(p => { setDesktop(p === 'granted'); if (p !== 'granted') setError('Desktop notifications were not allowed.'); }); else setError('Desktop notifications are unavailable in this browser.'); }}>{desktop ? 'Desktop notifications enabled' : 'Enable desktop notifications'}</button>
        <ul className="notices">{notices.map(n => <li key={n.id}><button onClick={() => { selectConversation(n.message.conversationId); void post(`/notifications/${n.id}/read`, {}).then(reloadNotices).catch(e => setError(errorText(e))); }}>{n.readAt ? '' : 'Unread · '}{n.message.sender.name}: {n.message.body.slice(0, 60) || 'File attachment'}</button></li>)}</ul>
        {noticeCursor && <button onClick={() => { void api<Page<Notice> & { unread: number }>(`/notifications?cursor=${noticeCursor}`).then(page => { setNotices(old => [...new Map([...old, ...page.items].map(n => [n.id, n])).values()]); setNoticeCursor(page.nextCursor); }).catch(e => setError(errorText(e))); }}>Older notifications</button>}</section></aside>
      <section className="chat" aria-label="Chat">{current ? <><h2>{title(current, user.id)}</h2><p className="members">{current.members.map(m => `${m.user.name} (${online[m.userId] ? 'online' : 'offline'})`).join(' · ')}</p>
        <form className="search" onSubmit={e => { e.preventDefault(); requestVersion.current += 1; searchRef.current = searchDraft.trim(); if (search === searchDraft.trim()) void reloadMessages(current.id, search, true).catch(e => setError(errorText(e))); else { setSearch(searchDraft.trim()); setMessages([]); setCursor(null); } }}><label>Search messages<input value={searchDraft} onChange={e => setSearchDraft(e.target.value)} maxLength={100} /></label><button>Search</button><button type="button" onClick={() => { requestVersion.current += 1; searchRef.current = ''; setSearch(''); setSearchDraft(''); void reloadMessages(current.id, '', true).catch(e => setError(errorText(e))); }}>Clear</button></form>
        {cursor && <button disabled={busy} onClick={() => void olderMessages()}>Load older messages</button>}
        <ol className="messages" aria-label="Messages">{messages.map(m => <li key={m.id} className={m.senderId === user.id ? 'own' : ''}><div><strong>{m.sender.name}</strong> <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString()}</time></div>
          <p>{m.body}</p>{m.attachments.map(f => <button className="file" key={f.id} onClick={() => { void api<{ url: string }>(`/files/${f.id}/download`).then(({ url }) => { window.location.assign(url); }).catch(e => setError(errorText(e))); }}>{f.name} ({Math.ceil(f.size / 1024)} KiB)</button>)}
          {m.senderId === user.id && <small>{current.members.filter(member => member.userId !== user.id && BigInt(member.lastReadSeq) >= BigInt(m.seq)).map(member => member.user.name).join(', ') ? `Read by ${current.members.filter(member => member.userId !== user.id && BigInt(member.lastReadSeq) >= BigInt(m.seq)).map(member => member.user.name).join(', ')}` : 'Sent'}</small>}</li>)}</ol>
        {!messages.length && <p className="muted">{search ? 'No matching messages.' : 'No messages loaded.'}</p>}
        <p className="typing" aria-live="polite">{Object.keys(typing).map(id => current.members.find(m => m.userId === id)?.user.name).filter(Boolean).join(', ')}{Object.keys(typing).length ? ' is typing…' : ''}</p>
        <form className="composer" onSubmit={send}><label>Message<textarea value={draft} disabled={!!pending} maxLength={4000} rows={3} onChange={e => { setDraft(e.target.value); if (Date.now() - typingSent.current > 1500) { socketRef.current?.emit('typing:set', { conversationId: selected, typing: true }); typingSent.current = Date.now(); } }} onBlur={() => socketRef.current?.emit('typing:set', { conversationId: selected, typing: false })} /></label>
          {uploadsEnabled && <label>Attach file (10 MiB; text, PDF, PNG, JPEG, ZIP)<input type="file" disabled={busy || !!pending || files.length >= 5} accept="text/plain,application/pdf,image/png,image/jpeg,application/zip" onChange={e => { if (e.target.files?.[0]) void upload(e.target.files[0]); e.target.value = ''; }} /></label>}
          {files.map(f => <p key={f.id}>{f.name} <button type="button" disabled={!!pending} onClick={() => setFiles(old => old.filter(item => item.id !== f.id))}>Remove</button></p>)}
          <div className="actions"><button disabled={sending || busy || (!draft.trim() && !files.length)}>{sending ? 'Sending…' : pending ? 'Retry same message' : 'Send'}</button><button type="button" disabled={sending || !!pending} onClick={() => { setDraft(''); setFiles([]); }}>Clear draft</button></div>
          {pending && !sending && <p className="muted">Delivery may already have succeeded. Retry keeps the same ID and cannot create a duplicate. <button type="button" onClick={() => { setPending(null); setDraft(''); setFiles([]); if (selected) void reloadMessages(selected, search).catch(e => setError(errorText(e))); }}>Stop retrying and clear draft</button></p>}</form></> : <p>Select a conversation or create one.</p>}</section></div></main>;
}
