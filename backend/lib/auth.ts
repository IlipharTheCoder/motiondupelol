export function isAuthorized(request: Request): boolean {
  return request.headers.get('x-api-key') === process.env.APP_SECRET_KEY;
}