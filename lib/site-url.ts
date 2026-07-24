const LOCAL_HOST = "localhost:3000";

type HeaderReader = {
  get(name: string): string | null;
};

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",", 1)[0]?.trim() || null;
}

export function siteUrlFromHeaders(requestHeaders: HeaderReader): URL {
  const host =
    firstHeaderValue(requestHeaders.get("x-forwarded-host")) ??
    firstHeaderValue(requestHeaders.get("host")) ??
    LOCAL_HOST;
  const protocol =
    firstHeaderValue(requestHeaders.get("x-forwarded-proto")) ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");

  return new URL(`${protocol}://${host}`);
}
