import type { ApiError } from "../shared/api";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({ error: "bad_response" }))) as T | ApiError;
  if (!res.ok) {
    const err = data as ApiError;
    throw new ApiFailure(res.status, err.error ?? "error", err.message);
  }
  return data as T;
}

export const get = <T>(path: string) => call<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}) => call<T>("POST", path, body);
