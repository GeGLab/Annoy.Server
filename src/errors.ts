export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const unauthorized = (message = "Sessão inválida") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Sem permissão") => new HttpError(403, "forbidden", message);
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} não encontrado`);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
