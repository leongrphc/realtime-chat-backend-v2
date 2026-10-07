export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/api${path}`, { ...options, credentials: 'include',
    headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP_${res.status}` }));
    throw new Error(data.error ?? 'REQUEST_FAILED');
  }
  return res.status === 204 ? undefined as T : res.json();
}
export const post = <T>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
