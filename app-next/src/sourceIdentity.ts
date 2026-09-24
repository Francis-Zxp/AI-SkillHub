import type { SourceCard } from "./types";

/** Keep a repository's identity separate from its storage directory and display name. */
export function sourcePresentation(source: Pick<SourceCard, "name" | "url">) {
  const match = source.url.trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?(?:[?#].*)?$/i);
  if (!match) return { title: source.name, owner: "" };
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  const storedName = source.name.toLowerCase();
  const generated = [repo, `${owner}--${repo}`, `${owner}/${repo}`].some(name => name.toLowerCase() === storedName);
  return { title: generated ? repo : source.name, owner };
}
