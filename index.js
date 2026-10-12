/**
 * dsh-session-delete-next — Host half.
 *
 * Adds the one capability the Harness ships without: permanently deleting a
 * chat session from the sidebar. The browser half (./client.js) contributes a
 * "Delete session" row to the session row menu plus a confirmation dialog; both
 * call the single same-origin route registered here.
 *
 * What one deletion touches, in order:
 *   1. refuse a session that is live (or created-but-unmaterialized) in this
 *      process — a running conversation is never deleted;
 *   2. resolve the session's own log artifact through the persistence backend
 *      and remove the directory containing it — the durable log lives there;
 *   3. drop the derived projection checkpoint;
 *   4. detach the identity from its workspace account and clear any archive
 *      mark, so the sidebar row cannot survive as a stale id;
 *   5. re-emit `api-session/removed`, the forwarded event the Client session
 *      list already consumes, so the row disappears without a refresh.
 *
 * Files are removed before any bookkeeping: a failure never leaves a session
 * that is hidden but still on disk.
 *
 * @module dsh-session-delete-next
 */

import { rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

const NS = '[dsh-session-delete-next]';

/** Windows compares paths case-insensitively; a prefix test must too. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32';

/** The persistence backend's own name for one Session log artifact. */
const ARTIFACT_NAME = /^session\.v\d+\.jsonl(?:\.(?:zst|zstd|gz))?$/u;

/** Request bodies carry one session id; anything larger is refused unread. */
const BODY_LIMIT_BYTES = 8192;

/** Plugin identity; the bundle patch row mounts this package by name. */
export const name = 'dsh-session-delete-next';

/**
 * The browser carrier is the only service this plugin cannot work without.
 * Everything else — persistence, the workspace registry, the live Session
 * store, storage domains — is resolved per request through `ctx.get()`, so a
 * deployment missing one of them degrades to "files deleted, that piece of
 * bookkeeping skipped" instead of refusing to load.
 */
export const inject = ['webServer'];

/**
 * Read a thrown value as text without letting a hostile `toString` escape.
 * @param error - the caught value.
 * @returns a printable message, or an empty string.
 */
function messageOf(error) {
	if (error === null || error === undefined) return '';
	if (typeof error === 'string') return error;
	if (typeof error.message === 'string') return error.message;
	try {
		return String(error);
	} catch {
		return '';
	}
}

/**
 * Read and parse a JSON request body.
 * @param req - the incoming request stream.
 * @returns the parsed object, `{}` for an empty body, or `null` when the body
 *   is unreadable, oversized, or not a JSON object.
 */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > BODY_LIMIT_BYTES) return null;
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	let parsed;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	return parsed;
}

/**
 * Answer one request with JSON.
 * @param res - the response owner.
 * @param status - HTTP status code.
 * @param value - the JSON-serializable body.
 */
function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body)
	});
	res.end(body);
}

/**
 * Whether the request may act. The carrier is loopback-only, but any page in
 * the same browser could still post to it, so a cross-site `Origin` is
 * refused. A same-origin fetch may omit `Origin` entirely and is allowed.
 * @param req - the incoming request.
 * @returns whether the request is same-origin.
 */
function sameOrigin(req) {
	const headers = req.headers;
	if (headers === null || headers === undefined) return true;
	const origin = headers.origin;
	if (typeof origin !== 'string' || origin === '') return true;
	const host = headers.host;
	if (typeof host !== 'string' || host === '') return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/**
 * Whether `target` lies strictly below `root`.
 * @param root - the containing directory.
 * @param target - the candidate descendant.
 * @returns whether the target is inside the root.
 */
function isInside(root, target) {
	const base = resolve(root);
	const path = resolve(target);
	const left = CASE_INSENSITIVE_PATHS ? base.toLowerCase() : base;
	const right = CASE_INSENSITIVE_PATHS ? path.toLowerCase() : path;
	if (right === left) return false;
	return right.startsWith(left.endsWith(sep) ? left : left + sep);
}

/**
 * Why this session must not be deleted, or `undefined` when it is safe.
 *
 * Fails closed: a Session store that cannot answer is never treated as "nothing
 * is live", because the cost of that mistake is an irreversible deletion.
 * @param ctx - the plugin context.
 * @param persistence - the persistence service, when available.
 * @param sessionId - the session to test.
 * @returns `'live'`, `'pending'`, `'no-session-store'`, or undefined.
 */
function busyReason(ctx, persistence, sessionId) {
	const sessions = ctx.get('sessions');
	if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return 'no-session-store';
	try {
		if (sessions.get(sessionId) !== undefined) return 'live';
	} catch {
		return 'no-session-store';
	}
	if (persistence !== undefined && persistence !== null && typeof persistence.hasPendingSession === 'function') {
		try {
			if (persistence.hasPendingSession(sessionId) === true) return 'pending';
		} catch {
			return 'no-session-store';
		}
	}
	return undefined;
}

/**
 * Resolve one stored session's header.
 * @param persistence - the persistence service.
 * @param sessionId - the stored session to resolve.
 * @returns `{ code: 'ok', header }` or a failure code.
 */
async function resolveHeader(persistence, sessionId) {
	if (typeof persistence.stat === 'function') {
		let stored;
		try {
			stored = await persistence.stat(sessionId);
		} catch (error) {
			return { code: 'stat-failed', detail: messageOf(error) };
		}
		if (stored === undefined || stored === null) return { code: 'missing' };
		const header = stored.header;
		if (header === null || typeof header !== 'object') return { code: 'missing' };
		return { code: 'ok', header };
	}

	/* Fallback for a backend without `stat`: scan the listing. */
	if (typeof persistence.list !== 'function') return { code: 'no-persistence' };
	let snapshots;
	try {
		snapshots = await persistence.list();
	} catch (error) {
		return { code: 'list-failed', detail: messageOf(error) };
	}
	if (!Array.isArray(snapshots)) return { code: 'list-failed', detail: 'list() did not return an array' };
	for (const snapshot of snapshots) {
		if (snapshot === null || typeof snapshot !== 'object') continue;
		const header = snapshot.header;
		if (header === null || typeof header !== 'object') continue;
		if (header.id === sessionId) return { code: 'ok', header };
	}
	return { code: 'missing' };
}

/**
 * Locate one stored session's log artifact through the persistence backend.
 * @param ctx - the plugin context.
 * @param sessionId - the stored session to resolve.
 * @returns `{ code: 'ok', artifact, header, root }` or a failure code.
 */
async function locateArtifact(ctx, sessionId) {
	const persistence = ctx.get('sessionPersistence');
	if (persistence === undefined || persistence === null) return { code: 'no-persistence' };
	if (typeof persistence.stat !== 'function' && typeof persistence.list !== 'function') return { code: 'no-persistence' };

	const resolved = await resolveHeader(persistence, sessionId);
	if (resolved.code !== 'ok') return resolved;

	let artifact;
	try {
		const location = typeof persistence.locate === 'function' ? persistence.locate(resolved.header) : undefined;
		artifact = location !== null && typeof location === 'object' ? location.path : undefined;
	} catch (error) {
		return { code: 'no-location', detail: messageOf(error) };
	}
	if (typeof artifact !== 'string' || artifact === '') return { code: 'no-location' };

	const root = typeof persistence.root === 'string' ? persistence.root : undefined;
	return { code: 'ok', artifact, root, persistence };
}

/**
 * Drop the session's derived projection checkpoint. Derived data only: a
 * failure leaves a stale cache entry that the projection store replaces on its
 * next write, so it never invalidates the deletion.
 * @param ctx - the plugin context.
 * @param sessionId - the removed session identity.
 */
async function dropProjectionCache(ctx, sessionId) {
	const storage = ctx.get('storageDomain');
	if (storage === undefined || storage === null || typeof storage.get !== 'function') return;

	let domain;
	try {
		/* `open()` refuses an already-open domain; `get()` reaches the live one. */
		domain = storage.get('session_projcache');
	} catch {
		return;
	}
	if (domain === undefined || domain === null || typeof domain.table !== 'function') return;
	try {
		await domain.table('sessions').delete(sessionId);
	} catch (error) {
		console.error(NS, 'projection cache cleanup failed:', messageOf(error));
	}
}

/**
 * Undo every durable bookkeeping reference to a session whose files are gone.
 * Best-effort by design: the files are already removed, so a failure here costs
 * a stale id until the next restart, never a partial deletion.
 * @param ctx - the plugin context.
 * @param sessionId - the removed session identity.
 */
async function forgetSession(ctx, sessionId) {
	const registry = ctx.get('workspaceRegistry');
	if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
		let workspaces = [];
		try {
			workspaces = registry.list();
		} catch (error) {
			console.error(NS, 'workspace list failed:', messageOf(error));
		}
		for (const workspace of workspaces) {
			let attached = false;
			try {
				attached = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId);
			} catch {
				attached = false;
			}
			if (!attached) continue;
			try {
				await workspace.detachSession(sessionId);
			} catch (error) {
				console.error(NS, 'detach failed:', messageOf(error));
			}
			break;
		}

		let archived = false;
		try {
			archived = Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId);
		} catch {
			archived = false;
		}
		if (archived && typeof registry.unarchiveSession === 'function') {
			try {
				await registry.unarchiveSession(sessionId);
			} catch (error) {
				console.error(NS, 'unarchive failed:', messageOf(error));
			}
		}
	}

	await dropProjectionCache(ctx, sessionId);

	try {
		/* Already forwarded to the browser; the Client session list drops the
		   identity on this event, so the row goes away without a refresh. */
		ctx.emit('api-session/removed', sessionId);
	} catch (error) {
		console.error(NS, 'removed event failed:', messageOf(error));
	}
}

/**
 * Permanently remove one session.
 * @param ctx - the plugin context.
 * @param sessionId - the session to remove.
 * @returns `{ code: 'ok' }` or a stable failure code with optional detail.
 */
async function removeSession(ctx, sessionId) {
	/* The live check comes first so a running conversation always reports
	   `live`, whatever its stored record looks like. */
	const blocked = busyReason(ctx, ctx.get('sessionPersistence'), sessionId);
	if (blocked !== undefined) return { code: blocked };

	const located = await locateArtifact(ctx, sessionId);
	if (located.code !== 'ok') return located;

	const absolute = resolve(located.artifact);
	const directory = dirname(absolute);
	const container = basename(directory);

	/* Only ever remove a directory the persistence backend itself named as this
	   session's artifact container, and only below its own configured root. */
	if (!ARTIFACT_NAME.test(basename(absolute))) return { code: 'bad-path', detail: absolute };
	if (container === '' || container === '.' || container === '..') return { code: 'bad-path', detail: absolute };
	if (dirname(directory) === directory) return { code: 'bad-path', detail: absolute };
	if (located.root !== undefined && !isInside(located.root, directory)) {
		return { code: 'bad-path', detail: absolute };
	}

	try {
		await stat(absolute);
	} catch {
		return { code: 'missing' };
	}

	try {
		await rm(directory, { recursive: true, force: true });
	} catch (error) {
		return { code: 'rm-failed', detail: messageOf(error) };
	}

	await forgetSession(ctx, sessionId);
	return { code: 'ok' };
}

/**
 * `POST /dsh-session-delete-next/delete` — body `{ sessionId }`.
 * @param ctx - the plugin context.
 * @param req - the incoming request.
 * @param res - the response owner.
 */
async function handleDelete(ctx, req, res) {
	if (req.method !== 'POST') {
		sendJson(res, 405, { ok: false, code: 'method' });
		return;
	}
	if (!sameOrigin(req)) {
		sendJson(res, 403, { ok: false, code: 'origin' });
		return;
	}

	const body = await readJsonBody(req);
	if (body === null || typeof body.sessionId !== 'string' || body.sessionId === '') {
		sendJson(res, 400, { ok: false, code: 'bad-args' });
		return;
	}

	const outcome = await removeSession(ctx, body.sessionId);
	console.error(NS, 'delete', body.sessionId, '->', outcome.code);
	switch (outcome.code) {
		case 'ok':
			sendJson(res, 200, { ok: true });
			return;
		case 'live':
		case 'pending':
		case 'no-session-store':
			sendJson(res, 409, { ok: false, code: outcome.code });
			return;
		case 'missing':
			sendJson(res, 404, { ok: false, code: 'missing' });
			return;
		default:
			sendJson(res, 500, {
				ok: false,
				code: outcome.code,
				detail: outcome.detail === undefined ? '' : outcome.detail
			});
	}
}

/**
 * Mount the delete route for as long as this plugin is loaded.
 * @param ctx - the plugin context, with `webServer` injected.
 */
export function apply(ctx) {
	ctx.effect(
		() => ctx.webServer.register({
			kind: 'exact',
			path: '/dsh-session-delete-next/delete',
			handler: (req, res) => {
				handleDelete(ctx, req, res).catch((error) => {
					try {
						sendJson(res, 500, { ok: false, code: 'internal', detail: messageOf(error) });
					} catch {
						/* The response was already owned; nothing left to answer. */
					}
				});
			}
		}),
		'dsh-session-delete-next: delete route'
	);
	console.error(NS, 'host ready: POST /dsh-session-delete-next/delete');
}
