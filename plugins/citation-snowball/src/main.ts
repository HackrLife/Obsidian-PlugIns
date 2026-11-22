import {
	App,
	Editor,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
	requestUrl,
	setIcon,
} from "obsidian";

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

interface CitationSnowballSettings {
	folder: string;
	tag: string;
	fileName: string;
	sections: string;
	includeAbstract: boolean;
	templatePath: string;
	keepLog: boolean;
	openAfterImport: boolean;
	openAlexKey: string;
	email: string;
}

const DEFAULT_SETTINGS: CitationSnowballSettings = {
	folder: "",
	tag: "paper",
	fileName: "{{title}}",
	sections: "Method, Data, Findings, Gaps",
	includeAbstract: true,
	templatePath: "",
	keepLog: true,
	openAfterImport: true,
	openAlexKey: "",
	email: "",
};

const LOG_NOTE = "Snowball log";
const OPENALEX = "https://api.openalex.org";
const WORK_FIELDS =
	"id,doi,ids,title,display_name,publication_year,authorships,primary_location,type,cited_by_count,abstract_inverted_index,referenced_works,open_access,locations";
/** OpenAlex accepts at most 50 values in one OR filter. */
const BATCH_SIZE = 50;

/* ------------------------------------------------------------------ */
/* Identifiers                                                         */
/* ------------------------------------------------------------------ */

export type IdKind = "doi" | "arxiv" | "openalex" | "pmid";

export interface PaperId {
	kind: IdKind;
	value: string;
}

const ARXIV_DOI_PREFIX = "10.48550/arxiv.";

function cleanTail(value: string): string {
	return value.replace(/[.,;:)\]}>'"]+$/, "");
}

export function normaliseDoi(raw: string): string {
	return cleanTail(
		raw
			.trim()
			.replace(/^doi:\s*/i, "")
			.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""),
	).toLowerCase();
}

export function normaliseArxiv(raw: string): string {
	return cleanTail(raw.trim())
		.replace(/^arxiv:\s*/i, "")
		.replace(/\.pdf$/i, "")
		.replace(/v\d+$/i, "")
		.toLowerCase();
}

function idKey(id: PaperId): string {
	return `${id.kind}:${id.value}`;
}

function pushId(found: PaperId[], seen: Set<string>, id: PaperId): void {
	if (id.kind === "doi" && id.value.startsWith(ARXIV_DOI_PREFIX)) {
		id = { kind: "arxiv", value: normaliseArxiv(id.value.slice(ARXIV_DOI_PREFIX.length)) };
	}
	const key = idKey(id);
	if (seen.has(key)) return;
	seen.add(key);
	found.push(id);
}

const NEW_ARXIV = /^\d{4}\.\d{4,5}(v\d+)?$/i;
const OLD_ARXIV = /^[a-z][a-z-]*(\.[a-z]{2})?\/\d{7}(v\d+)?$/i;

/**
 * Finds every paper identifier in a piece of text: DOIs (bare or as links), arXiv IDs and links,
 * OpenAlex work IDs and links, and PubMed IDs written as "PMID: 123" or as PubMed links.
 * Works on a single identifier or on a whole pasted reference list.
 */
export function extractIdentifiers(text: string): PaperId[] {
	const found: PaperId[] = [];
	const seen = new Set<string>();
	// Mask matched spans so a DOI inside an arXiv link is not read twice.
	let rest = text;
	const take = (pattern: RegExp, make: (match: RegExpExecArray) => PaperId | null) => {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		const spans: Array<[number, number]> = [];
		while ((match = pattern.exec(rest)) !== null) {
			const id = make(match);
			if (id && id.value.length > 0) pushId(found, seen, id);
			spans.push([match.index, match.index + match[0].length]);
		}
		for (const [start, end] of spans.reverse()) {
			rest = rest.slice(0, start) + " ".repeat(end - start) + rest.slice(end);
		}
	};

	take(/arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/gi, (m) => ({
		kind: "arxiv",
		value: normaliseArxiv(m[1] ?? ""),
	}));
	take(/\barxiv:\s*([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/gi, (m) => ({
		kind: "arxiv",
		value: normaliseArxiv(m[1] ?? ""),
	}));
	take(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})/gi, (m) => ({ kind: "pmid", value: m[1] ?? "" }));
	take(/\bpmid:?\s*(\d{1,9})\b/gi, (m) => ({ kind: "pmid", value: m[1] ?? "" }));
	take(/(?:openalex\.org\/(?:works\/)?)(W\d{4,})\b/gi, (m) => ({ kind: "openalex", value: (m[1] ?? "").toUpperCase() }));
	take(/\b10\.\d{4,9}\/[^\s"<>]+/gi, (m) => ({ kind: "doi", value: normaliseDoi(m[0]) }));

	// Bare tokens: an arXiv ID or an OpenAlex ID typed on its own.
	for (const token of rest.split(/[\s,;]+/)) {
		const value = cleanTail(token);
		if (NEW_ARXIV.test(value) || OLD_ARXIV.test(value)) {
			pushId(found, seen, { kind: "arxiv", value: normaliseArxiv(value) });
		} else if (/^W\d{4,}$/i.test(value)) {
			pushId(found, seen, { kind: "openalex", value: value.toUpperCase() });
		}
	}
	return found;
}

/* ------------------------------------------------------------------ */
/* Works                                                               */
/* ------------------------------------------------------------------ */

export interface Author {
	name: string;
	family: string;
	given: string;
}

export interface Work {
	openalex: string | null;
	doi: string | null;
	arxiv: string | null;
	pmid: string | null;
	title: string;
	authors: Author[];
	year: number | null;
	venue: string;
	type: string;
	citedBy: number | null;
	abstract: string;
	url: string;
	pdfUrl: string | null;
	references: string[];
	source: "OpenAlex" | "Crossref" | "arXiv";
}

const NAME_PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "di", "da", "du", "la", "le", "ter", "ten", "bin", "al", "dos", "das"]);

/** Splits a display name such as "Ludwig van Beethoven" into family and given names. */
export function splitName(name: string): Author {
	const clean = name.replace(/\s+/g, " ").trim();
	if (clean.includes(",")) {
		const [family, given] = clean.split(",", 2);
		return { name: clean, family: (family ?? "").trim(), given: (given ?? "").trim() };
	}
	const parts = clean.split(" ");
	if (parts.length === 1) return { name: clean, family: clean, given: "" };
	let start = parts.length - 1;
	while (start > 1 && NAME_PARTICLES.has((parts[start - 1] ?? "").toLowerCase())) start--;
	return { name: clean, family: parts.slice(start).join(" "), given: parts.slice(0, start).join(" ") };
}

/** OpenAlex stores abstracts as word → positions. This puts the words back in order. */
export function rebuildAbstract(index: Record<string, number[]> | null | undefined): string {
	if (!index) return "";
	const words: string[] = [];
	for (const [word, positions] of Object.entries(index)) {
		for (const position of positions) words[position] = word;
	}
	return words.filter((word) => word !== undefined).join(" ").replace(/\s+/g, " ").trim();
}

function stripMarkup(text: string): string {
	return text
		.replace(/<\/?(jats:)?[a-z][^>]*>/gi, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

type Json = unknown;

/** Reads a nested value from parsed JSON without trusting its shape. */
function at(value: Json, ...path: Array<string | number>): Json {
	let current: Json = value;
	for (const key of path) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string | number, Json>)[key];
	}
	return current;
}

function arr(value: Json): Json[] {
	return Array.isArray(value) ? (value as Json[]) : [];
}

function num(value: Json): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shortOpenAlexId(value: unknown): string | null {
	const match = /W\d+$/i.exec(str(value));
	return match ? match[0].toUpperCase() : null;
}

export function workFromOpenAlex(raw: Json): Work {
	const doi = str(at(raw, "doi")) ? normaliseDoi(str(at(raw, "doi"))) : null;
	let arxiv: string | null = null;
	if (doi && doi.startsWith(ARXIV_DOI_PREFIX)) arxiv = normaliseArxiv(doi.slice(ARXIV_DOI_PREFIX.length));
	for (const location of arr(at(raw, "locations"))) {
		const m = /arxiv\.org\/abs\/(.+)$/i.exec(str(at(location, "landing_page_url")));
		if (m && !arxiv) arxiv = normaliseArxiv(m[1] ?? "");
	}
	const pmidMatch = /(\d+)$/.exec(str(at(raw, "ids", "pmid")));
	const authors = arr(at(raw, "authorships"))
		.map((a) => str(at(a, "author", "display_name")) || str(at(a, "raw_author_name")))
		.filter((name) => name.length > 0)
		.map(splitName);
	const venue =
		str(at(raw, "primary_location", "source", "display_name")) || str(at(raw, "primary_location", "raw_source_name"));
	const openalex = shortOpenAlexId(at(raw, "id"));
	const pdfUrl = str(at(raw, "open_access", "oa_url")) || str(at(raw, "primary_location", "pdf_url")) || null;
	const references = arr(at(raw, "referenced_works"))
		.map((ref) => shortOpenAlexId(ref))
		.filter((ref): ref is string => ref !== null);
	const index = at(raw, "abstract_inverted_index");
	return {
		openalex,
		doi: doi && !doi.startsWith(ARXIV_DOI_PREFIX) ? doi : null,
		arxiv,
		pmid: pmidMatch ? (pmidMatch[1] ?? null) : null,
		title: stripMarkup(str(at(raw, "title")) || str(at(raw, "display_name"))) || "Untitled",
		authors,
		year: num(at(raw, "publication_year")),
		venue,
		type: str(at(raw, "type")),
		citedBy: num(at(raw, "cited_by_count")),
		abstract: rebuildAbstract(index && typeof index === "object" ? (index as Record<string, number[]>) : null),
		url: doi
			? `https://doi.org/${doi}`
			: arxiv
				? `https://arxiv.org/abs/${arxiv}`
				: openalex
					? `https://openalex.org/${openalex}`
					: "",
		pdfUrl,
		references,
		source: "OpenAlex",
	};
}

export function workFromCrossref(raw: Json): Work {
	const message = at(raw, "message") ?? raw;
	const doi = normaliseDoi(str(at(message, "DOI")));
	const authors = arr(at(message, "author"))
		.map((a): Author => {
			const family = str(at(a, "family"));
			const given = str(at(a, "given"));
			const name = str(at(a, "name")) || `${given} ${family}`.trim();
			return family ? { name, family, given } : splitName(name);
		})
		.filter((a) => a.name.length > 0);
	let year: number | null = null;
	for (const key of ["issued", "published", "published-print", "published-online", "created"]) {
		year = num(at(message, key, "date-parts", 0, 0));
		if (year !== null) break;
	}
	return {
		openalex: null,
		doi: doi || null,
		arxiv: null,
		pmid: null,
		title: stripMarkup(str(at(message, "title", 0))) || "Untitled",
		authors,
		year,
		venue: str(at(message, "container-title", 0)),
		type: str(at(message, "type")),
		citedBy: num(at(message, "is-referenced-by-count")),
		abstract: stripMarkup(str(at(message, "abstract"))).replace(/^abstract\s+/i, ""),
		url: doi ? `https://doi.org/${doi}` : "",
		pdfUrl: null,
		references: [],
		source: "Crossref",
	};
}

export function workFromArxivAtom(xml: string, id: string): Work | null {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	const entry = doc.getElementsByTagName("entry")[0];
	if (!entry) return null;
	const text = (tag: string) => (entry.getElementsByTagName(tag)[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
	const entryId = text("id");
	if (entryId.includes("api/errors") || text("title").length === 0) return null;
	const authors = Array.from(entry.getElementsByTagName("author"))
		.map((a) => (a.getElementsByTagName("name")[0]?.textContent ?? "").trim())
		.filter((name) => name.length > 0)
		.map(splitName);
	const published = text("published");
	const year = /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : null;
	const doi = text("arxiv:doi");
	const journal = text("arxiv:journal_ref");
	const arxiv = normaliseArxiv(id);
	return {
		openalex: null,
		doi: doi ? normaliseDoi(doi) : null,
		arxiv,
		pmid: null,
		title: text("title"),
		authors,
		year,
		venue: journal || "arXiv",
		type: "preprint",
		citedBy: null,
		abstract: text("summary"),
		url: `https://arxiv.org/abs/${arxiv}`,
		pdfUrl: `https://arxiv.org/pdf/${arxiv}`,
		references: [],
		source: "arXiv",
	};
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function initials(given: string): string {
	return given
		.split(/[\s.]+/)
		.filter((part) => part.length > 0)
		.map((part) =>
			part
				.split("-")
				.map((piece) => `${piece.charAt(0).toUpperCase()}.`)
				.join("-"),
		)
		.join(" ");
}

function apaAuthor(author: Author): string {
	const first = initials(author.given);
	return first ? `${author.family}, ${first}` : author.family;
}

/** An APA 7 reference list entry. */
export function apaCitation(work: Work): string {
	const names = work.authors.map(apaAuthor);
	let authorText = "";
	if (names.length === 1) authorText = names[0] ?? "";
	else if (names.length > 1 && names.length <= 20)
		authorText = `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1] ?? ""}`;
	else if (names.length > 20) authorText = `${names.slice(0, 19).join(", ")}, . . . ${names[names.length - 1] ?? ""}`;

	const year = work.year ? `(${work.year})` : "(n.d.)";
	const title = /[.?!]$/.test(work.title) ? work.title : `${work.title}.`;
	const parts = authorText ? [`${authorText} ${year}.`, title] : [title, `${year}.`];
	if (work.venue) parts.push(`*${work.venue}*.`);
	if (work.url) parts.push(work.url);
	return parts.join(" ");
}

function asciiFold(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/ß/g, "ss")
		.replace(/[^a-zA-Z0-9]/g, "");
}

const TITLE_STOP_WORDS = new Set(["a", "an", "the", "on", "of", "in", "for", "and", "to", "with", "is", "are", "how", "why", "what", "do", "does", "from", "at", "by", "toward", "towards"]);

/** A Better BibTeX style key: first author's family name, year, first meaningful title word. */
export function citekey(work: Work): string {
	const family = asciiFold(work.authors[0]?.family ?? "").toLowerCase() || "anon";
	const word =
		work.title
			.split(/\s+/)
			.map((w) => asciiFold(w).toLowerCase())
			.find((w) => w.length > 0 && !TITLE_STOP_WORDS.has(w)) ?? "";
	return `${family}${work.year ?? ""}${word}`;
}

export function yamlString(value: string): string {
	return JSON.stringify(value);
}

function safeFileName(value: string): string {
	const cleaned = value
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 120 ? cleaned.slice(0, 120).replace(/\s+\S*$/, "").trim() : cleaned;
}

export function fileNameFor(work: Work, pattern: string): string {
	const name = (pattern || "{{title}}")
		.replace(/\{\{\s*title\s*\}\}/g, work.title)
		.replace(/\{\{\s*author\s*\}\}/g, work.authors[0]?.family ?? "Anon")
		.replace(/\{\{\s*year\s*\}\}/g, work.year ? String(work.year) : "n.d.")
		.replace(/\{\{\s*citekey\s*\}\}/g, citekey(work));
	return safeFileName(name) || "Untitled paper";
}

function parseList(raw: string): string[] {
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export interface Provenance {
	seedLink: string;
	direction: "reference" | "citation";
}

export function buildFrontmatter(work: Work, tag: string, provenance: Provenance | null, today: string): string {
	const lines = ["---", `title: ${yamlString(work.title)}`];
	if (work.authors.length > 0) {
		lines.push("authors:");
		for (const author of work.authors) lines.push(`  - ${yamlString(author.name)}`);
	} else {
		lines.push("authors: []");
	}
	lines.push(`year: ${work.year ?? ""}`);
	if (work.venue) lines.push(`venue: ${yamlString(work.venue)}`);
	if (work.type) lines.push(`type: ${yamlString(work.type)}`);
	if (work.doi) lines.push(`doi: ${yamlString(work.doi)}`);
	if (work.arxiv) lines.push(`arxiv: ${yamlString(work.arxiv)}`);
	if (work.pmid) lines.push(`pmid: ${yamlString(work.pmid)}`);
	if (work.openalex) lines.push(`openalex: ${yamlString(work.openalex)}`);
	if (work.url) lines.push(`url: ${yamlString(work.url)}`);
	if (work.pdfUrl) lines.push(`pdf: ${yamlString(work.pdfUrl)}`);
	if (work.citedBy !== null) lines.push(`cited_by: ${work.citedBy}`);
	lines.push(`citekey: ${yamlString(citekey(work))}`);
	if (provenance) {
		lines.push(`snowball_seed: ${yamlString(provenance.seedLink)}`);
		lines.push(`snowball_direction: ${provenance.direction}`);
	}
	lines.push(`imported: ${today}`);
	const cleanTag = tag.trim().replace(/^#/, "");
	if (cleanTag) lines.push("tags:", `  - ${cleanTag}`);
	lines.push("---", "");
	return lines.join("\n");
}

export function buildBody(work: Work, sections: string[], includeAbstract: boolean): string {
	const lines: string[] = [];
	if (includeAbstract) {
		lines.push("## Abstract", "", work.abstract || "_No abstract available._", "");
	}
	for (const section of sections) lines.push(`## ${section}`, "", "");
	lines.push("## Citation", "", apaCitation(work), "");
	return lines.join("\n");
}

export function fillTemplate(template: string, work: Work): string {
	const values: Record<string, string> = {
		title: work.title,
		authors: work.authors.map((a) => a.name).join(", "),
		year: work.year ? String(work.year) : "",
		venue: work.venue,
		doi: work.doi ?? "",
		arxiv: work.arxiv ?? "",
		url: work.url,
		pdf: work.pdfUrl ?? "",
		abstract: work.abstract,
		citation: apaCitation(work),
		citekey: citekey(work),
		cited_by: work.citedBy !== null ? String(work.citedBy) : "",
	};
	return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}

function todayIso(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function authorLine(work: Work): string {
	const names = work.authors.map((a) => a.family);
	if (names.length === 0) return "Unknown authors";
	if (names.length === 1) return names[0] ?? "";
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} et al.`;
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

class RateLimitError extends Error {}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function encodeDoi(doi: string): string {
	return encodeURI(doi).replace(/#/g, "%23").replace(/\?/g, "%3F").replace(/;/g, "%3B");
}

class Lookup {
	private settings: () => CitationSnowballSettings;
	rateLimited = false;

	constructor(settings: () => CitationSnowballSettings) {
		this.settings = settings;
	}

	private openAlexUrl(path: string, params: Record<string, string>): string {
		const query = new URLSearchParams(params);
		const key = this.settings().openAlexKey.trim();
		if (key) query.set("api_key", key);
		return `${OPENALEX}${path}?${query.toString()}`;
	}

	private async getJson(url: string): Promise<unknown> {
		const response = await requestUrl({ url, throw: false });
		if (response.status === 404) return null;
		if (response.status === 429) throw new RateLimitError("rate limited");
		if (response.status >= 400) throw new Error(`Request failed (${response.status})`);
		return response.json as unknown;
	}

	private async openAlexWork(id: PaperId): Promise<Work | null> {
		if (this.rateLimited) return null;
		let path: string;
		switch (id.kind) {
			case "doi":
				path = `/works/doi:${encodeDoi(id.value)}`;
				break;
			case "arxiv":
				path = `/works/doi:${encodeDoi(ARXIV_DOI_PREFIX + id.value)}`;
				break;
			case "pmid":
				path = `/works/pmid:${id.value}`;
				break;
			case "openalex":
				path = `/works/${id.value}`;
				break;
		}
		try {
			const raw = await this.getJson(this.openAlexUrl(path, { select: WORK_FIELDS }));
			return raw ? workFromOpenAlex(raw) : null;
		} catch (error) {
			if (error instanceof RateLimitError) {
				this.rateLimited = true;
				return null;
			}
			throw error;
		}
	}

	private async crossrefWork(doi: string): Promise<Work | null> {
		const email = this.settings().email.trim();
		const suffix = email ? `?mailto=${encodeURIComponent(email)}` : "";
		const raw = await this.getJson(`https://api.crossref.org/works/${encodeDoi(doi)}${suffix}`);
		return raw ? workFromCrossref(raw) : null;
	}

	private async arxivWork(id: string): Promise<Work | null> {
		const response = await requestUrl({
			url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
			throw: false,
		});
		if (response.status >= 400) return null;
		return workFromArxivAtom(response.text, id);
	}

	/** Looks a paper up in OpenAlex, then falls back to Crossref (DOIs) or arXiv (arXiv IDs). */
	async resolve(id: PaperId): Promise<Work | null> {
		let work: Work | null = null;
		try {
			work = await this.openAlexWork(id);
		} catch {
			work = null;
		}
		if (work) return work;
		if (id.kind === "doi") return this.crossrefWork(id.value);
		if (id.kind === "arxiv") return this.arxivWork(id.value);
		return null;
	}

	/** Fetches many OpenAlex works by ID, 50 per request, keeping the order given. */
	async worksByIds(ids: string[], onProgress?: (done: number) => void): Promise<Work[]> {
		const byId = new Map<string, Work>();
		for (let start = 0; start < ids.length; start += BATCH_SIZE) {
			const chunk = ids.slice(start, start + BATCH_SIZE);
			const raw = (await this.getJson(
				this.openAlexUrl("/works", {
					filter: `openalex:${chunk.join("|")}`,
					"per-page": String(BATCH_SIZE),
					select: WORK_FIELDS,
				}),
			)) as { results?: unknown[] } | null;
			for (const item of raw?.results ?? []) {
				const work = workFromOpenAlex(item);
				if (work.openalex) byId.set(work.openalex, work);
			}
			onProgress?.(Math.min(start + BATCH_SIZE, ids.length));
			await sleep(120);
		}
		return ids.map((id) => byId.get(id)).filter((work): work is Work => work !== undefined);
	}

	/** One page of papers that cite a work, most cited first. */
	async citingWorks(openalexId: string, page: number): Promise<{ works: Work[]; total: number }> {
		const raw = (await this.getJson(
			this.openAlexUrl("/works", {
				filter: `cites:${openalexId}`,
				sort: "cited_by_count:desc",
				"per-page": String(BATCH_SIZE),
				page: String(page),
				select: WORK_FIELDS,
			}),
		)) as { results?: unknown[]; meta?: { count?: number } } | null;
		return {
			works: (raw?.results ?? []).map((item) => workFromOpenAlex(item)),
			total: raw?.meta?.count ?? 0,
		};
	}
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

interface ImportResult {
	file: TFile;
	created: boolean;
}

export default class CitationSnowballPlugin extends Plugin {
	settings: CitationSnowballSettings = { ...DEFAULT_SETTINGS };
	lookup = new Lookup(() => this.settings);

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addRibbonIcon("snowflake", "Snowball from the current paper", () => {
			void this.snowballFromActiveNote();
		});

		this.addCommand({
			id: "import-papers",
			name: "Import papers",
			callback: () => new ImportModal(this.app, this, "", null).open(),
		});

		this.addCommand({
			id: "import-papers-and-link",
			name: "Import papers and insert links",
			editorCallback: (editor: Editor) => new ImportModal(this.app, this, editor.getSelection(), editor).open(),
		});

		this.addCommand({
			id: "snowball-current-note",
			name: "Snowball from the current paper",
			callback: () => {
				void this.snowballFromActiveNote();
			},
		});

		this.addCommand({
			id: "snowball-from-identifier",
			name: "Snowball from a DOI or arXiv ID",
			callback: () => new SeedModal(this.app, this).open(),
		});

		this.addSettingTab(new CitationSnowballSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<CitationSnowballSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Maps every DOI, arXiv, PubMed and OpenAlex ID found in note properties to its note. */
	buildVaultIndex(): Map<string, TFile> {
		const index = new Map<string, TFile>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			for (const id of idsFromFrontmatter(fm)) {
				const key = idKey(id);
				if (!index.has(key)) index.set(key, file);
			}
		}
		return index;
	}

	findExisting(work: Work, index: Map<string, TFile>): TFile | null {
		for (const id of idsOfWork(work)) {
			const file = index.get(idKey(id));
			if (file) return file;
		}
		return null;
	}

	private async ensureFolder(): Promise<string> {
		const folder = this.settings.folder.trim();
		if (!folder || folder === "/") return "";
		const path = normalizePath(folder);
		if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
		return path;
	}

	private async noteBody(work: Work): Promise<string> {
		const templatePath = this.settings.templatePath.trim();
		if (templatePath) {
			const withExt = templatePath.endsWith(".md") ? templatePath : `${templatePath}.md`;
			const file = this.app.vault.getAbstractFileByPath(normalizePath(withExt));
			if (file instanceof TFile) {
				return fillTemplate(await this.app.vault.read(file), work);
			}
			new Notice(`Template "${templatePath}" not found, so the default layout was used.`);
		}
		return buildBody(work, parseList(this.settings.sections), this.settings.includeAbstract);
	}

	/** Creates a literature note for a work, or returns the note that already has it. */
	async createNote(work: Work, index: Map<string, TFile>, provenance: Provenance | null): Promise<ImportResult> {
		const existing = this.findExisting(work, index);
		if (existing) return { file: existing, created: false };

		const folder = await this.ensureFolder();
		const base = fileNameFor(work, this.settings.fileName);
		let path = normalizePath(folder ? `${folder}/${base}.md` : `${base}.md`);
		let counter = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(folder ? `${folder}/${base} (${counter}).md` : `${base} (${counter}).md`);
			counter++;
		}
		const content =
			buildFrontmatter(work, this.settings.tag, provenance, todayIso()) + (await this.noteBody(work));
		const file = await this.app.vault.create(path, content);
		for (const id of idsOfWork(work)) index.set(idKey(id), file);
		return { file, created: true };
	}

	linkTo(file: TFile, sourcePath: string): string {
		return `[[${this.app.metadataCache.fileToLinktext(file, sourcePath, true)}]]`;
	}

	async openFile(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	rateLimitNotice(): void {
		if (!this.lookup.rateLimited) return;
		new Notice(
			"OpenAlex's free daily allowance without a key is used up. Add a free OpenAlex API key in the settings to keep going.",
			10000,
		);
	}

	async snowballFromActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const fm: Record<string, unknown> | undefined = file
			? this.app.metadataCache.getFileCache(file)?.frontmatter
			: undefined;
		const ids = fm ? idsFromFrontmatter(fm) : [];
		if (!file || ids.length === 0) {
			new SeedModal(this.app, this).open();
			return;
		}
		await this.startSnowball(ids, file);
	}

	/** Resolves the seed paper, imports it when it isn't in the vault, then opens the picker. */
	async startSnowball(ids: PaperId[], seedFile: TFile | null): Promise<void> {
		this.lookup.rateLimited = false;
		const notice = new Notice("Looking up the paper…", 0);
		try {
			const preferred = ids.find((id) => id.kind === "openalex") ?? ids[0];
			if (!preferred) return;
			let seed = await this.lookup.resolve(preferred);
			if (seed && !seed.openalex) {
				// Crossref and arXiv answers have no OpenAlex ID; try the other identifiers.
				for (const id of ids) {
					if (id === preferred) continue;
					const other = await this.lookup.resolve(id);
					if (other?.openalex) {
						seed = other;
						break;
					}
				}
			}
			notice.hide();
			if (!seed) {
				this.rateLimitNotice();
				if (!this.lookup.rateLimited) new Notice("Couldn't find that paper in OpenAlex, Crossref or arXiv.");
				return;
			}
			if (!seed.openalex) {
				this.rateLimitNotice();
				if (!this.lookup.rateLimited) new Notice("OpenAlex doesn't have this paper, so its citations can't be followed.");
				return;
			}
			let file = seedFile;
			if (!file) {
				const result = await this.createNote(seed, this.buildVaultIndex(), null);
				file = result.file;
				if (result.created) new Notice(`Imported the seed paper: ${file.basename}`);
			}
			new SnowballModal(this.app, this, seed, file).open();
		} catch (error) {
			notice.hide();
			new Notice(`Lookup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async appendLog(seed: TFile, direction: "reference" | "citation", found: number, inVault: number, imported: TFile[]): Promise<void> {
		if (!this.settings.keepLog) return;
		const folder = await this.ensureFolder();
		const path = normalizePath(folder ? `${folder}/${LOG_NOTE}.md` : `${LOG_NOTE}.md`);
		const links = imported.map((file) => this.linkTo(file, path)).join(", ") || "none";
		const row = `| ${todayIso()} | ${this.linkTo(seed, path)} | ${direction === "reference" ? "Backward (references)" : "Forward (cited by)"} | ${found} | ${inVault} | ${imported.length} | ${links} |`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const data = await this.app.vault.read(existing);
			await this.app.vault.modify(existing, `${data.replace(/\s+$/, "")}\n${row}\n`);
		} else {
			const header = [
				"Every snowball search, so the review can be reported and repeated.",
				"",
				"| Date | Seed | Direction | Found | Already in vault | Imported | Notes |",
				"| --- | --- | --- | --- | --- | --- | --- |",
			].join("\n");
			await this.app.vault.create(path, `${header}\n${row}\n`);
		}
	}
}

function idsOfWork(work: Work): PaperId[] {
	const ids: PaperId[] = [];
	if (work.openalex) ids.push({ kind: "openalex", value: work.openalex });
	if (work.doi) ids.push({ kind: "doi", value: work.doi });
	if (work.arxiv) ids.push({ kind: "arxiv", value: work.arxiv });
	if (work.pmid) ids.push({ kind: "pmid", value: work.pmid });
	return ids;
}

export function idsFromFrontmatter(fm: Record<string, unknown>): PaperId[] {
	const ids: PaperId[] = [];
	const value = (key: string) => {
		const raw = fm[key] ?? fm[key.toUpperCase()];
		return typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
	};
	const openalex = shortOpenAlexId(value("openalex"));
	if (openalex) ids.push({ kind: "openalex", value: openalex });
	const doi = value("doi");
	if (doi) {
		const clean = normaliseDoi(doi);
		if (clean.startsWith(ARXIV_DOI_PREFIX)) ids.push({ kind: "arxiv", value: normaliseArxiv(clean.slice(ARXIV_DOI_PREFIX.length)) });
		else ids.push({ kind: "doi", value: clean });
	}
	const arxiv = value("arxiv") || value("arxiv_id");
	if (arxiv) ids.push({ kind: "arxiv", value: normaliseArxiv(arxiv.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "")) });
	const pmid = value("pmid");
	if (/^\d+$/.test(pmid)) ids.push({ kind: "pmid", value: pmid });
	return ids;
}

/* ------------------------------------------------------------------ */
/* Import modal                                                        */
/* ------------------------------------------------------------------ */

class ImportModal extends Modal {
	private plugin: CitationSnowballPlugin;
	private text: string;
	private editor: Editor | null;
	private busy = false;

	constructor(app: App, plugin: CitationSnowballPlugin, initial: string, editor: Editor | null) {
		super(app);
		this.plugin = plugin;
		this.text = initial;
		this.editor = editor;
	}

	onOpen(): void {
		this.titleEl.setText(this.editor ? "Import papers and insert links" : "Import papers");
		const { contentEl } = this;
		contentEl.addClass("cs-import");
		contentEl.createEl("p", {
			cls: "cs-hint",
			text: "Paste a DOI, arXiv ID, PubMed ID or OpenAlex ID, or several. A whole reference list works too.",
		});

		const area = contentEl.createEl("textarea", { cls: "cs-textarea" });
		area.rows = 6;
		area.placeholder = "10.1162/003355303322552801\narXiv:1706.03762\nhttps://pubmed.ncbi.nlm.nih.gov/31452104";
		area.value = this.text;
		const count = contentEl.createDiv({ cls: "cs-count" });

		const footer = new Setting(contentEl);
		let importButton: HTMLButtonElement | null = null;
		footer.addButton((button) => {
			importButton = button.buttonEl;
			button
				.setButtonText("Import")
				.setCta()
				.onClick(() => {
					void this.run(button.buttonEl);
				});
		});

		const update = () => {
			this.text = area.value;
			const n = extractIdentifiers(this.text).length;
			count.setText(n === 0 ? "No identifiers found yet." : n === 1 ? "1 paper found." : `${n} papers found.`);
			if (importButton) importButton.disabled = n === 0 || this.busy;
		};
		area.addEventListener("input", update);
		area.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && importButton) void this.run(importButton);
		});
		update();
		window.setTimeout(() => area.focus(), 0);
	}

	private async run(button: HTMLButtonElement): Promise<void> {
		if (this.busy) return;
		const ids = extractIdentifiers(this.text);
		if (ids.length === 0) return;
		this.busy = true;
		button.disabled = true;

		const index = this.plugin.buildVaultIndex();
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		const results: ImportResult[] = [];
		const missing: string[] = [];
		this.plugin.lookup.rateLimited = false;

		for (const [i, id] of ids.entries()) {
			button.setText(`Importing ${i + 1} of ${ids.length}…`);
			const known = index.get(idKey(id));
			if (known) {
				results.push({ file: known, created: false });
				continue;
			}
			try {
				const work = await this.plugin.lookup.resolve(id);
				if (work) results.push(await this.plugin.createNote(work, index, null));
				else missing.push(id.value);
			} catch {
				missing.push(id.value);
			}
		}

		this.busy = false;
		this.close();

		const created = results.filter((r) => r.created).length;
		const existing = results.length - created;
		const parts: string[] = [];
		if (created > 0) parts.push(`Imported ${created} ${created === 1 ? "paper" : "papers"}.`);
		if (existing > 0) parts.push(`${existing} already in your vault.`);
		if (missing.length > 0) parts.push(`Not found: ${missing.join(", ")}.`);
		new Notice(parts.join(" ") || "Nothing imported.", missing.length > 0 ? 10000 : 5000);
		this.plugin.rateLimitNotice();

		if (this.editor && results.length > 0) {
			const links = results.map((r) => this.plugin.linkTo(r.file, sourcePath));
			this.editor.replaceSelection(links.length === 1 ? (links[0] ?? "") : links.map((l) => `- ${l}`).join("\n"));
		} else if (this.plugin.settings.openAfterImport && results.length === 1 && results[0]) {
			await this.plugin.openFile(results[0].file);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* Seed modal                                                          */
/* ------------------------------------------------------------------ */

class SeedModal extends Modal {
	private plugin: CitationSnowballPlugin;
	private value = "";

	constructor(app: App, plugin: CitationSnowballPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.titleEl.setText("Snowball from a paper");
		const { contentEl } = this;
		contentEl.createEl("p", {
			cls: "cs-hint",
			text: "Enter the paper to start from. If it isn't in your vault yet, it is imported first.",
		});
		new Setting(contentEl).setName("DOI, arXiv, PubMed or OpenAlex ID").addText((text) => {
			text.setPlaceholder("10.1162/003355303322552801").onChange((value) => {
				this.value = value;
			});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") this.submit();
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Find citations")
				.setCta()
				.onClick(() => this.submit()),
		);
	}

	private submit(): void {
		const ids = extractIdentifiers(this.value);
		if (ids.length === 0) {
			new Notice("That doesn't look like a DOI, arXiv, PubMed or OpenAlex ID.");
			return;
		}
		this.close();
		const index = this.plugin.buildVaultIndex();
		const existing = ids.map((id) => index.get(idKey(id))).find((file) => file !== undefined) ?? null;
		void this.plugin.startSnowball(ids, existing);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* Snowball modal                                                      */
/* ------------------------------------------------------------------ */

type Direction = "reference" | "citation";
type SortKey = "cited" | "newest" | "oldest" | "title";

interface Candidate {
	work: Work;
	existing: TFile | null;
	selected: boolean;
}

class SnowballModal extends Modal {
	private plugin: CitationSnowballPlugin;
	private seed: Work;
	private seedFile: TFile;
	private direction: Direction = "reference";
	private lists: Record<Direction, Candidate[] | null> = { reference: null, citation: null };
	private citationTotal = 0;
	private citationPage = 0;
	private loading = false;
	private query = "";
	private sort: SortKey = "cited";
	private hideInVault = false;
	private index: Map<string, TFile>;

	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private importButton!: HTMLButtonElement;
	private moreButton!: HTMLButtonElement;
	private tabs: Record<Direction, HTMLButtonElement> = {} as Record<Direction, HTMLButtonElement>;

	constructor(app: App, plugin: CitationSnowballPlugin, seed: Work, seedFile: TFile) {
		super(app);
		this.plugin = plugin;
		this.seed = seed;
		this.seedFile = seedFile;
		this.index = plugin.buildVaultIndex();
	}

	onOpen(): void {
		this.modalEl.addClass("cs-snowball-modal");
		this.titleEl.setText("Citation snowball");
		const { contentEl } = this;
		contentEl.addClass("cs-snowball");

		const seedEl = contentEl.createDiv({ cls: "cs-seed" });
		seedEl.createDiv({ cls: "cs-seed-title", text: this.seed.title });
		seedEl.createDiv({
			cls: "cs-seed-meta",
			text: [authorLine(this.seed), this.seed.year ? String(this.seed.year) : "", this.seed.venue]
				.filter((part) => part.length > 0)
				.join(" · "),
		});

		const tabBar = contentEl.createDiv({ cls: "cs-tabs" });
		this.tabs.reference = tabBar.createEl("button", { cls: "cs-tab" });
		this.tabs.citation = tabBar.createEl("button", { cls: "cs-tab" });
		this.tabs.reference.addEventListener("click", () => void this.switchTo("reference"));
		this.tabs.citation.addEventListener("click", () => void this.switchTo("citation"));
		this.updateTabs();

		const toolbar = contentEl.createDiv({ cls: "cs-toolbar" });
		const search = toolbar.createEl("input", { cls: "cs-search", type: "search" });
		search.placeholder = "Filter by title, author or venue";
		search.addEventListener("input", () => {
			this.query = search.value.trim().toLowerCase();
			this.renderList();
		});

		const sort = toolbar.createEl("select", { cls: "dropdown cs-sort" });
		const sortOptions: Array<[SortKey, string]> = [
			["cited", "Most cited"],
			["newest", "Newest"],
			["oldest", "Oldest"],
			["title", "Title"],
		];
		for (const [value, label] of sortOptions) sort.createEl("option", { value, text: label });
		sort.addEventListener("change", () => {
			this.sort = sort.value as SortKey;
			this.renderList();
		});

		const hideLabel = toolbar.createEl("label", { cls: "cs-check-label" });
		const hide = hideLabel.createEl("input", { type: "checkbox" });
		hideLabel.appendText("Hide papers in vault");
		hide.addEventListener("change", () => {
			this.hideInVault = hide.checked;
			this.renderList();
		});

		const selectAll = toolbar.createEl("button", { cls: "cs-link-button", text: "Select all" });
		selectAll.addEventListener("click", () => this.setAll(true));
		const clear = toolbar.createEl("button", { cls: "cs-link-button", text: "Clear" });
		clear.addEventListener("click", () => this.setAll(false));

		this.statusEl = contentEl.createDiv({ cls: "cs-status" });
		this.listEl = contentEl.createDiv({ cls: "cs-list" });

		const footer = contentEl.createDiv({ cls: "cs-footer" });
		this.moreButton = footer.createEl("button", { text: "Load more" });
		this.moreButton.addEventListener("click", () => void this.loadCitations());
		footer.createDiv({ cls: "cs-spacer" });
		this.importButton = footer.createEl("button", { cls: "mod-cta" });
		this.importButton.addEventListener("click", () => void this.importSelected());

		void this.switchTo("reference");
	}

	private get current(): Candidate[] {
		return this.lists[this.direction] ?? [];
	}

	private updateTabs(): void {
		const refCount = this.seed.references.length;
		this.tabs.reference.setText(`References · ${refCount}`);
		this.tabs.citation.setText(
			`Cited by · ${this.lists.citation ? this.citationTotal : (this.seed.citedBy ?? "?")}`,
		);
		this.tabs.reference.toggleClass("is-active", this.direction === "reference");
		this.tabs.citation.toggleClass("is-active", this.direction === "citation");
	}

	private toCandidate(work: Work): Candidate {
		return { work, existing: this.plugin.findExisting(work, this.index), selected: false };
	}

	private async switchTo(direction: Direction): Promise<void> {
		this.direction = direction;
		this.updateTabs();
		if (this.lists[direction] === null && !this.loading) {
			if (direction === "reference") await this.loadReferences();
			else await this.loadCitations();
		}
		this.renderList();
	}

	private async loadReferences(): Promise<void> {
		this.loading = true;
		this.renderList();
		const ids = this.seed.references;
		try {
			const works = await this.plugin.lookup.worksByIds(ids, (done) => {
				if (this.direction === "reference") this.statusEl.setText(`Loading references… ${done} of ${ids.length}`);
			});
			this.lists.reference = works.map((work) => this.toCandidate(work));
		} catch (error) {
			this.lists.reference = [];
			this.failed(error);
		}
		this.loading = false;
		this.afterLoad();
	}

	/** If the other tab was opened while this list loaded, load it now. */
	private afterLoad(): void {
		this.updateTabs();
		if (this.lists[this.direction] === null) void this.switchTo(this.direction);
		else this.renderList();
	}

	private async loadCitations(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.renderList();
		try {
			const { works, total } = await this.plugin.lookup.citingWorks(this.seed.openalex ?? "", this.citationPage + 1);
			this.citationPage++;
			this.citationTotal = total;
			const list = this.lists.citation ?? [];
			const known = new Set(list.map((c) => c.work.openalex));
			for (const work of works) if (!known.has(work.openalex)) list.push(this.toCandidate(work));
			this.lists.citation = list;
		} catch (error) {
			this.lists.citation = this.lists.citation ?? [];
			this.failed(error);
		}
		this.loading = false;
		this.afterLoad();
	}

	private failed(error: unknown): void {
		if (error instanceof RateLimitError) {
			this.plugin.lookup.rateLimited = true;
			this.plugin.rateLimitNotice();
		} else {
			new Notice(`Couldn't load papers: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private visible(): Candidate[] {
		let list = this.current.filter((c) => !(this.hideInVault && c.existing));
		if (this.query) {
			list = list.filter((c) =>
				`${c.work.title} ${c.work.authors.map((a) => a.name).join(" ")} ${c.work.venue}`.toLowerCase().includes(this.query),
			);
		}
		const sorted = [...list];
		sorted.sort((a, b) => {
			switch (this.sort) {
				case "cited":
					return (b.work.citedBy ?? -1) - (a.work.citedBy ?? -1);
				case "newest":
					return (b.work.year ?? 0) - (a.work.year ?? 0);
				case "oldest":
					return (a.work.year ?? 9999) - (b.work.year ?? 9999);
				case "title":
					return a.work.title.localeCompare(b.work.title);
			}
		});
		return sorted;
	}

	private setAll(value: boolean): void {
		for (const candidate of this.visible()) if (!candidate.existing) candidate.selected = value;
		this.renderList();
	}

	private updateFooter(): void {
		const selected = this.current.filter((c) => c.selected).length;
		this.importButton.setText(selected === 0 ? "Import selected" : `Import ${selected} selected`);
		this.importButton.disabled = selected === 0 || this.loading;
		const loaded = this.lists.citation?.length ?? 0;
		const showMore = this.direction === "citation" && this.lists.citation !== null && loaded < this.citationTotal;
		this.moreButton.toggleClass("cs-hidden", !showMore);
		this.moreButton.disabled = this.loading;
		this.moreButton.setText(`Load more (${loaded} of ${this.citationTotal})`);
	}

	private renderList(): void {
		this.listEl.empty();
		const list = this.lists[this.direction];

		if (list === null || (this.loading && list.length === 0)) {
			this.statusEl.setText(this.direction === "reference" ? "Loading references…" : "Loading papers that cite it…");
			this.updateFooter();
			return;
		}

		const inVault = list.filter((c) => c.existing).length;
		const noun = this.direction === "reference" ? "references" : "citing papers";
		if (list.length === 0) {
			this.statusEl.setText(
				this.direction === "reference"
					? "OpenAlex has no reference list for this paper."
					: "OpenAlex has no papers that cite this one yet.",
			);
			this.updateFooter();
			return;
		}
		this.statusEl.setText(`${list.length} ${noun} loaded, ${inVault} already in your vault.`);

		const visible = this.visible();
		if (visible.length === 0) {
			this.listEl.createDiv({ cls: "cs-empty", text: "Nothing matches the filter." });
		}
		for (const candidate of visible) this.renderRow(candidate);
		this.updateFooter();
	}

	private renderRow(candidate: Candidate): void {
		const { work } = candidate;
		const row = this.listEl.createDiv({ cls: "cs-row" });
		row.toggleClass("is-in-vault", candidate.existing !== null);
		row.toggleClass("is-selected", candidate.selected);

		const box = row.createEl("input", { type: "checkbox", cls: "cs-row-check" });
		box.checked = candidate.selected;
		box.disabled = candidate.existing !== null;
		box.setAttribute("aria-label", `Select ${work.title}`);
		box.addEventListener("change", () => {
			candidate.selected = box.checked;
			row.toggleClass("is-selected", box.checked);
			this.updateFooter();
		});

		const body = row.createDiv({ cls: "cs-row-body" });
		body.createDiv({ cls: "cs-row-title", text: work.title });
		const meta = body.createDiv({ cls: "cs-row-meta" });
		meta.setText(
			[authorLine(work), work.year ? String(work.year) : "", work.venue].filter((p) => p.length > 0).join(" · "),
		);

		const badges = body.createDiv({ cls: "cs-row-badges" });
		if (work.citedBy !== null) badges.createSpan({ cls: "cs-badge", text: `${work.citedBy.toLocaleString()} citations` });
		if (candidate.existing) {
			const open = badges.createEl("button", { cls: "cs-badge cs-badge-vault" });
			setIcon(open.createSpan({ cls: "cs-badge-icon" }), "file-check");
			open.appendText("In vault");
			open.setAttribute("aria-label", `Open ${candidate.existing.basename}`);
			open.addEventListener("click", () => {
				if (candidate.existing) void this.plugin.openFile(candidate.existing);
			});
		}

		if (work.abstract) {
			const details = body.createEl("details", { cls: "cs-abstract" });
			details.createEl("summary", { text: "Abstract" });
			details.createEl("p", { text: work.abstract });
		}
	}

	private async importSelected(): Promise<void> {
		const direction = this.direction;
		const list = this.current;
		const chosen = list.filter((c) => c.selected && !c.existing);
		if (chosen.length === 0) return;
		this.loading = true;
		this.updateFooter();

		const seedLink = this.plugin.linkTo(this.seedFile, "");
		const imported: TFile[] = [];
		for (const [i, candidate] of chosen.entries()) {
			this.importButton.setText(`Importing ${i + 1} of ${chosen.length}…`);
			try {
				const result = await this.plugin.createNote(candidate.work, this.index, { seedLink, direction });
				candidate.existing = result.file;
				candidate.selected = false;
				if (result.created) imported.push(result.file);
			} catch (error) {
				new Notice(`Couldn't import "${candidate.work.title}": ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const inVault = list.filter((c) => c.existing).length - imported.length;
		await this.plugin.appendLog(this.seedFile, direction, list.length, inVault, imported);

		this.loading = false;
		new Notice(`Imported ${imported.length} ${imported.length === 1 ? "paper" : "papers"}.`);
		this.renderList();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

type TextKey = "folder" | "tag" | "fileName" | "sections" | "templatePath" | "openAlexKey" | "email";
type ToggleKey = "includeAbstract" | "keepLog" | "openAfterImport";

class CitationSnowballSettingTab extends PluginSettingTab {
	private plugin: CitationSnowballPlugin;

	constructor(app: App, plugin: CitationSnowballPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;
		const save = async () => this.plugin.saveSettings();

		const text = (name: string, desc: string, key: TextKey, placeholder: string) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((input) =>
					input
						.setPlaceholder(placeholder)
						.setValue(settings[key])
						.onChange(async (value) => {
							settings[key] = value;
							await save();
						}),
				);

		const toggle = (name: string, desc: string, key: ToggleKey) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((input) =>
					input.setValue(settings[key]).onChange(async (value) => {
						settings[key] = value;
						await save();
					}),
				);

		new Setting(containerEl).setName("Where notes go").setHeading();
		text("Folder", "New literature notes and the snowball log go here. Leave empty for the vault root.", "folder", "Example: Research/Papers");
		text("Tag", "Added to every imported paper. Leave empty for no tag.", "tag", "Example: paper");
		text("File name", "Use {{title}}, {{author}}, {{year}} and {{citekey}}. Example: {{author}} {{year}} {{title}}.", "fileName", "{{title}}");
		toggle("Open the note after a single import", "Open the new note when you import one paper.", "openAfterImport");

		new Setting(containerEl).setName("Note contents").setHeading();
		text("Sections", "Empty headings added to every new note, separated by commas. The defaults match the Literature Matrix columns.", "sections", "Method, Data, Findings, Gaps");
		toggle("Include the abstract", "Add the abstract under its own heading when the source has one.", "includeAbstract");
		text(
			"Template note",
			"Optional. Path to a note used as the body instead of the sections above. Placeholders: {{title}}, {{authors}}, {{year}}, {{venue}}, {{doi}}, {{arxiv}}, {{url}}, {{pdf}}, {{abstract}}, {{citation}}, {{citekey}}, {{cited_by}}.",
			"templatePath",
			"Example: Templates/Paper",
		);

		new Setting(containerEl).setName("Snowballing").setHeading();
		toggle("Keep a snowball log", "Record each search in a Snowball log note: seed, direction, papers found, already in the vault and imported.", "keepLog");

		new Setting(containerEl).setName("Sources").setHeading();
		text(
			"OpenAlex API key",
			"Optional and free from openalex.org/settings/api. Single imports work without it; a key gives ten times the daily allowance for snowballing.",
			"openAlexKey",
			"Paste your key",
		);
		text("Contact email", "Optional. Sent to Crossref with fallback lookups so they can contact you about heavy use.", "email", "you@example.com");
	}
}

