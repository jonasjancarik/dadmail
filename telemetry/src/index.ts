import { env } from "cloudflare:workers";

// Receives error reports from DadMail and shows them on a password-protected page.
// Reports never contain email content or addresses: the app scrubs them, and so does this Worker.

const KINDS = new Set(["sync", "send", "crash", "ui", "update", "other"]);
const RETENTION_DAYS = 90;
// Per installation and overall, per hour
const MAX_PER_INSTALL = 60;
const MAX_TOTAL = 2000;

const EMAIL = /[^\s<>"'()@,;:]+@[^\s<>"'()@,;:]+\.[a-z]{2,}/gi;

function text(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= max ? trimmed : null;
}

async function receive(request: Request): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}
	const installId = text(body.install_id, 64);
	const appVersion = text(body.app_version, 32);
	const os = text(body.os, 80);
	const kind = text(body.kind, 16);
	const message = text(body.message, 2000);
	const count = Number.isInteger(body.count) ? Math.min(Math.max(body.count as number, 1), 10000) : 1;
	if (!installId || !appVersion || !os || !kind || !KINDS.has(kind) || !message) {
		return new Response("Missing or invalid fields", { status: 400 });
	}

	const now = Math.floor(Date.now() / 1000);
	const recent = await env.DB.prepare(
		"SELECT count(*) AS total, sum(install_id = ?) AS mine FROM reports WHERE received_at > ?",
	)
		.bind(installId, now - 3600)
		.first<{ total: number; mine: number | null }>();
	if ((recent?.mine ?? 0) >= MAX_PER_INSTALL || (recent?.total ?? 0) >= MAX_TOTAL) {
		return new Response("Too many reports", { status: 429 });
	}

	await env.DB.prepare(
		"INSERT INTO reports (received_at, install_id, app_version, os, kind, message, count) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(now, installId, appVersion, os, kind, message.replace(EMAIL, "<email>"), count)
		.run();
	return new Response(null, { status: 204 });
}

function authorized(request: Request): boolean {
	const header = request.headers.get("Authorization") ?? "";
	if (!header.startsWith("Basic ") || !env.VIEW_PASSWORD) return false;
	let password = "";
	try {
		password = atob(header.slice(6)).split(":").slice(1).join(":");
	} catch {
		return false;
	}
	// Constant-time comparison
	const a = new TextEncoder().encode(password);
	const b = new TextEncoder().encode(env.VIEW_PASSWORD);
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

const escape = (value: unknown) =>
	String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const when = (seconds: number) =>
	new Date(seconds * 1000).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", dateStyle: "short", timeStyle: "short" });

const KIND_LABELS: Record<string, string> = {
	sync: "Stahování pošty",
	send: "Odesílání",
	crash: "Pád aplikace",
	ui: "Chyba v okně",
	update: "Aktualizace",
	other: "Jiné",
};

async function page(): Promise<Response> {
	const since = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
	const { results } = await env.DB.prepare(
		`SELECT kind, message, sum(count) AS times, count(DISTINCT install_id) AS installs,
		        max(received_at) AS last_seen, min(received_at) AS first_seen,
		        max(app_version) AS version, max(os) AS os
		 FROM reports WHERE received_at > ?
		 GROUP BY kind, message ORDER BY last_seen DESC LIMIT 200`,
	)
		.bind(since)
		.all<{ kind: string; message: string; times: number; installs: number; last_seen: number; first_seen: number; version: string; os: string }>();

	const rows = results
		.map(
			(r) => `<tr>
				<td class="when">${escape(when(r.last_seen))}<small>poprvé ${escape(when(r.first_seen))}</small></td>
				<td><span class="kind">${escape(KIND_LABELS[r.kind] ?? r.kind)}</span></td>
				<td class="message">${escape(r.message)}</td>
				<td class="num">${escape(r.times)}×</td>
				<td>${escape(r.version)}<small>${escape(r.os)}</small></td>
			</tr>`,
		)
		.join("");

	const html = `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chyby v DadMailu</title>
<style>
	:root { color-scheme: light dark; --bg: #f8fafc; --card: #fff; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --accent: #1d4ed8; }
	@media (prefers-color-scheme: dark) { :root { --bg: #0f172a; --card: #1e293b; --ink: #e2e8f0; --muted: #94a3b8; --line: #334155; --accent: #93c5fd; } }
	body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
	main { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
	h1 { font-size: 22px; margin: 0 0 4px; }
	p.note { color: var(--muted); margin: 0 0 20px; }
	.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
	th { font-size: 13px; color: var(--muted); font-weight: 500; }
	tr:last-child td { border-bottom: 0; }
	small { display: block; color: var(--muted); font-size: 12px; }
	.when { white-space: nowrap; }
	.num { text-align: right; font-variant-numeric: tabular-nums; }
	.kind { white-space: nowrap; color: var(--accent); font-weight: 500; }
	.message { word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
	.empty { padding: 32px; text-align: center; color: var(--muted); }
</style></head>
<body><main>
	<h1>Chyby v DadMailu</h1>
	<p class="note">Za posledních 30 dní, stejná chyba je sloučená do jednoho řádku. Hlášení neobsahují obsah emailů ani adresy.</p>
	<div class="card">${
		rows
			? `<table><thead><tr><th>Naposledy</th><th>Kde</th><th>Chyba</th><th class="num">Kolikrát</th><th>Verze a systém</th></tr></thead><tbody>${rows}</tbody></table>`
			: `<div class="empty">Žádné chyby. Všechno funguje.</div>`
	}</div>
</main></body></html>`;
	return new Response(html, {
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
	});
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/report" && request.method === "POST") {
			return receive(request);
		}
		if (url.pathname === "/" && request.method === "GET") {
			if (!authorized(request)) {
				return new Response("Přihlaste se", {
					status: 401,
					headers: { "WWW-Authenticate": 'Basic realm="DadMail", charset="UTF-8"' },
				});
			}
			return page();
		}
		return new Response("Not found", { status: 404 });
	},

	async scheduled() {
		const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 24 * 3600;
		await env.DB.prepare("DELETE FROM reports WHERE received_at < ?").bind(cutoff).run();
	},
} satisfies ExportedHandler<Env>;
